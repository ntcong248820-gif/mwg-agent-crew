#!/usr/bin/env node
/**
 * Attribute working-tree changes to the jobs of a crew run.
 *
 * A worker is allowed to write its evidence and its own data, and nothing else.
 * Checking that with `git status` alone does not work in this workspace: the
 * repo normally carries several hundred modified files of the user's own, so a
 * plain diff reports files no run ever touched.
 *
 * So attribution is by time: a file counts against a job only if it was
 * modified inside that job's own interval. Per-job matters. A run-wide window
 * once charged 32 skill files to a run whose only job never started -- the user
 * was editing those files in the same five minutes, and a window spanning the
 * whole run had no way to say so.
 *
 * Two limits are deliberate and documented rather than papered over:
 *   - a write that was committed is invisible here, because only the working
 *     tree is read; workers are not supposed to commit, and a gate that shelled
 *     out to `git log` would still not know who authored a commit;
 *   - a job that died without recording an end time has no knowable interval,
 *     so anything found in its capped window is reported as suspect rather than
 *     charged as a violation. Failing hard there made the gate unpassable on
 *     exactly the runs it exists for, which teaches a dispatcher to ignore it.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/** How long after a job ends a write can still plausibly be that job's. */
export const DEFAULT_GRACE_MS = 120_000;

/**
 * The widest interval a job with no recorded end can be given. `updatedAt` is
 * unusable as the bound: the gate reconciles before it checks, which moves
 * `updatedAt` to now, so a killed job would get a window reaching the present
 * and swallow everything the user touched meanwhile.
 */
export const MAX_JOB_SPAN_MS = 35 * 60_000;

/**
 * The widest window a job may be given, preferring what the adapter recorded
 * over the derived ceiling. A job that was only ever allowed five minutes must
 * not be charged with what the user edited half an hour later.
 */
function jobSpanMs(job, graceMs) {
  return Number.isFinite(job.timeoutMs) && job.timeoutMs > 0
    ? job.timeoutMs + graceMs
    : MAX_JOB_SPAN_MS;
}

/** Ceiling on entries read per declared prefix, so a stray declaration cannot hang the gate. */
const WALK_LIMIT = 20_000;

/**
 * Paths a worker must never write, checked whatever git thinks of them.
 *
 * This list exists because `git status` cannot see them: every one of these is
 * gitignored in this repo, so the diff-based check is blind to a worker that
 * overwrites a runtime config or a credential file. Kept in sync with the
 * Protected Files list in CLAUDE.md.
 */
export const PROTECTED_PATHS = [
  ".mcp.json", ".claude/.mcp.json", ".agents/mcp_config.json",
  ".codex/config.toml", ".gemini/settings.json", "skills-lock.json",
  "mwg-workflow-n8n/.env", "mwg-workflow-n8n/.claude/.mcp.json",
  "mwg-workflow-n8n/.codex/config.toml", "mwg-workflow-n8n/.gemini/settings.json",
  "mwg-workflow-n8n/.agents/mcp_config.json",
  "mwg-seo-analytics/.env", "mwg-seo-analytics/config/client_secret.json",
];

/** A prefix only means "this directory" if it ends in a separator. */
function normalizePrefix(p) {
  return p.endsWith("/") || p.endsWith(sep) ? p : `${p}/`;
}

/**
 * One interval per job. A job with no `startedAt` never ran, so nothing can be
 * charged to it; a cancelled job is the same case after the fact.
 */
export function jobIntervals(manifest, graceMs = DEFAULT_GRACE_MS) {
  return manifest.jobs
    .filter((job) => job.startedAt && job.status !== "cancelled")
    .map((job) => {
      const from = Date.parse(job.startedAt);
      // `endedAtInferred` means reconcile filled the end time in rather than the
      // runtime reporting it, so the interval is a guess and must be treated
      // like a missing one.
      return job.endedAt && !job.endedAtInferred
        ? { seq: job.seq, from, to: Date.parse(job.endedAt) + graceMs, bounded: true }
        : { seq: job.seq, from, to: Math.min(from + jobSpanMs(job, graceMs), Date.parse(job.endedAt ?? "") + graceMs || Infinity), bounded: false };
    });
}

/**
 * Where each job may write. `tasks/{task}/` is implicit for every job; anything
 * else has to be declared per job, because some legitimate work lands outside
 * it -- an article edit belongs in `mwg-content-editor/content-workspaces/`,
 * which is durable and shared, not task-scoped.
 */
export function allowedFor(manifest, seqs) {
  const implicit = [normalizePrefix(`tasks/${manifest.task}`)];
  const runLevel = (manifest.filesMayModify ?? []).map(normalizePrefix);
  const perJob = manifest.jobs
    .filter((j) => seqs.includes(j.seq))
    .flatMap((j) => (j.filesMayModify ?? []).map(normalizePrefix));
  return [...implicit, ...runLevel, ...perJob];
}

/** Every prefix any job declared, for the walk that git cannot do. */
function declaredPrefixes(manifest) {
  return [
    ...(manifest.filesMayModify ?? []),
    ...manifest.jobs.flatMap((j) => j.filesMayModify ?? []),
  ].map(normalizePrefix);
}

/** `git status --porcelain -z`, keeping the second path of a rename record. */
function changedPaths(workspace) {
  const out = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd: workspace, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  const records = out.split("\0");
  const paths = [];
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (!rec) continue;
    const code = rec.slice(0, 2);
    paths.push(rec.slice(3));
    // A rename/copy record is followed by its source path in its own field, so
    // it must be consumed here or it is read as a status line on the next pass.
    if (code[0] === "R" || code[0] === "C") {
      i += 1;
      if (records[i]) paths.push(records[i]);
    }
  }
  return paths;
}

/**
 * Files under a declared prefix or on the protected list, found by walking
 * rather than by asking git. Both categories are gitignored in this repo, which
 * is why declaring `filesMayModify` was a no-op before this existed.
 */
function watchedPaths(workspace, manifest) {
  const found = new Set();
  const add = (rel) => found.add(rel.split(sep).join("/"));

  for (const file of PROTECTED_PATHS) {
    try {
      statSync(join(workspace, file));
      add(file);
    } catch { /* absent here; nothing to attribute */ }
  }
  for (const prefix of declaredPrefixes(manifest)) {
    const root = join(workspace, prefix);
    let entries;
    try {
      entries = readdirSync(root, { recursive: true, withFileTypes: true });
    } catch { continue; }
    let n = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (n += 1, n > WALK_LIMIT) break;
      add(join(prefix, e.parentPath ? e.parentPath.slice(root.length + 1) : "", e.name));
    }
  }
  return [...found];
}

export function collectWriteScope(manifest, { workspace, graceMs = DEFAULT_GRACE_MS } = {}) {
  if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 24 * 3600_000) {
    throw new Error(`--grace không hợp lệ: ${graceMs}. Phải là số ms từ 0 đến 86400000.`);
  }
  const intervals = jobIntervals(manifest, graceMs);
  const result = {
    intervals, inScope: [], outOfScope: [], suspect: [],
    protectedHits: [], outsideWindow: [], unattributable: [],
  };
  const paths = new Set([...changedPaths(workspace), ...watchedPaths(workspace, manifest)]);

  for (const path of paths) {
    let mtime;
    try {
      mtime = statSync(join(workspace, path)).mtimeMs;
    } catch {
      // Deleted, or a path git sees and we cannot stat. A deletion carries no
      // timestamp, so it cannot be charged to a job -- but it also cannot be
      // waved through, so it is surfaced for a human. It is not made blocking:
      // this repo already carries an unrelated deletion, and a gate that failed
      // every run over it would be ignored within a day.
      result.unattributable.push(path);
      continue;
    }
    const hits = intervals.filter((i) => mtime >= i.from && mtime <= i.to);
    if (hits.length === 0) {
      result.outsideWindow.push(path);
      continue;
    }
    const seqs = hits.map((h) => h.seq);
    // With MAX_PARALLEL 3 and a two-minute grace, concurrent jobs' windows
    // always overlap, so every candidate is named. Picking the first would
    // routinely accuse the wrong worker -- and that name is the line a human
    // reads to find the culprit.
    const entry = { path, seqs, bounded: hits.some((h) => h.bounded) };

    if (PROTECTED_PATHS.includes(path)) {
      result.protectedHits.push(entry);
      continue;
    }
    if (allowedFor(manifest, seqs).some((p) => path.startsWith(p))) {
      result.inScope.push(entry);
    } else if (entry.bounded) {
      result.outOfScope.push(entry);
    } else {
      // Only jobs with no recorded end could have written this, so the interval
      // is a guess. Report it loudly; do not fail the run on a guess.
      result.suspect.push(entry);
    }
  }
  return result;
}
