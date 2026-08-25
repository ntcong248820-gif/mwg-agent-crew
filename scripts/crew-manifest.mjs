#!/usr/bin/env node
/**
 * The run manifest is the only shared mutable state in a crew run: the
 * dispatcher appends jobs, several workers finish at unpredictable times, and
 * the collect step reads it. So every mutation goes through a lock and lands
 * via tmp+rename, never a partial write that a concurrent reader could see.
 *
 * Layout: tasks/{task}/reports/crew-{runId}/manifest.json
 */
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, rmSync,
  existsSync, statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;

/**
 * Bumped to 2 when the adapters started recording who delivered a job
 * (`exitCode` / `conversationId`) and how long it was allowed to run
 * (`timeoutMs`). Bumped to 3 when every job started carrying why it was
 * dispatched the way it was (`role`) and which way that is (`transport`).
 *
 * The collect gate reads the version to know whether the absence of those
 * fields means something: on a version-1 manifest it means nothing, because
 * nothing wrote them yet.
 */
export const MANIFEST_VERSION = 3;

class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
}

function lockPath(manifestPath) {
  return `${manifestPath}.lock`;
}

/**
 * mkdir is the atomic primitive available on every filesystem here. A lock
 * older than LOCK_STALE_MS is assumed to be from a crashed process, because no
 * legitimate manifest mutation reads or writes for that long.
 */
function acquireLock(manifestPath) {
  const lock = lockPath(manifestPath);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      // Stamp ownership: a slow holder whose lock got reclaimed as stale must
      // not later delete the lock its successor is holding.
      const token = `${process.pid}:${randomUUID()}`;
      writeFileSync(join(lock, "owner"), token, "utf8");
      return { lock, token };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released while we looked; retry immediately
      }
      if (age > LOCK_STALE_MS) {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch { /* another process won the cleanup race */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new ManifestError(
          `timed out waiting ${LOCK_WAIT_MS}ms for the manifest lock at ${lock}\n` +
          `  → if no crew run is active, remove that directory and retry`,
        );
      }
      // Busy-wait deliberately: this is a sub-second contention window and the
      // callers are synchronous CLI scripts, not an event loop.
      const until = Date.now() + LOCK_POLL_MS;
      while (Date.now() < until) { /* spin */ }
    }
  }
}

/** Only release a lock we still own; a reclaimed lock now belongs to someone else. */
function releaseLock(lock, token) {
  try {
    if (readFileSync(join(lock, "owner"), "utf8") !== token) return;
  } catch {
    return; // no owner stamp means the lock is not ours to remove
  }
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch { /* already gone */ }
}

export function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    throw new ManifestError(`no manifest at ${manifestPath}`);
  }
  const raw = readFileSync(manifestPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ManifestError(`manifest at ${manifestPath} is not valid JSON: ${err.message}`);
  }
  // Older manifests stay readable. Strict equality here meant that bumping the
  // constant made every run already on disk unreadable -- collect and reconcile
  // would throw on the entire history the moment a new field was added. Only a
  // version this script has never heard of is refused, because that one may
  // carry fields whose absence it would misread.
  if (!Number.isInteger(parsed.version) || parsed.version > MANIFEST_VERSION) {
    throw new ManifestError(
      `manifest version ${parsed.version} is newer than this script understands (max ${MANIFEST_VERSION})\n` +
      `  → update mwg-agent-crew/scripts/ instead of editing the manifest`,
    );
  }
  return parsed;
}

/** tmp+rename so a reader never observes a half-written manifest. */
export function writeManifest(manifestPath, manifest) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(tmp, manifestPath);
  } catch (err) {
    // A partial tmp file left in the run directory looks like run output.
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw err;
  }
  return manifestPath;
}

/** Read-modify-write under the lock. `mutate` receives and returns the manifest. */
export function updateManifest(manifestPath, mutate) {
  const { lock, token } = acquireLock(manifestPath);
  try {
    const manifest = readManifest(manifestPath);
    const next = mutate(manifest) ?? manifest;
    next.updatedAt = new Date().toISOString();
    writeManifest(manifestPath, next);
    return next;
  } finally {
    releaseLock(lock, token);
  }
}

/**
 * MAX_DEPTH is the second half of the recursion guard. MWG_CREW_ROLE stops a
 * worker that reads the skill and tries to dispatch; this stops a run that got
 * created anyway. Depth 0 is the dispatcher, depth 1 is a worker sub-run that a
 * human deliberately asked for; deeper than that is a loop, not a plan.
 */
export const MAX_DEPTH = 1;

export function createRun({ runDir, runId, task, workspace, depth = 0, dispatcher = "claude" }) {
  const manifestPath = join(runDir, "manifest.json");
  if (existsSync(manifestPath)) {
    throw new ManifestError(`run manifest already exists at ${manifestPath}`);
  }
  if (!Number.isInteger(depth) || depth < 0) {
    throw new ManifestError(`depth must be a non-negative integer, got ${depth}`);
  }
  if (depth > MAX_DEPTH) {
    throw new ManifestError(
      `refusing to create a run at depth ${depth} (max ${MAX_DEPTH})\n` +
      `  → a worker is dispatching workers; stop the chain instead of deepening it`,
    );
  }
  if (process.env.MWG_CREW_ROLE === "worker" && depth === 0) {
    throw new ManifestError(
      "refusing to create a depth-0 run while MWG_CREW_ROLE=worker\n" +
      "  → a worker cannot start its own dispatch run",
    );
  }
  const now = new Date().toISOString();
  return {
    manifestPath,
    manifest: writeManifest(manifestPath, {
      version: MANIFEST_VERSION,
      runId,
      task,
      workspace,
      dispatcher,
      depth,
      createdAt: now,
      updatedAt: now,
      jobs: [],
    }) && readManifest(manifestPath),
  };
}

/**
 * Who answers for this job's acceptance. `owner` means the worker does: its
 * evidence IS the deliverable. `assist` means Claude does, and the job is
 * material for something Claude writes.
 */
export const ROLES = new Set(["owner", "assist"]);
export const TRANSPORTS = new Set(["app", "headless"]);

/**
 * An owner job opens a chat box so the person who will be judged on the output
 * can watch it being made; an assist job has no audience, so it runs headless
 * and hands its stdout back. Recording the role next to the transport keeps the
 * reason separable from the consequence: change this default later and old runs
 * still say what the old decision was based on.
 */
const DEFAULT_TRANSPORT = { owner: "app", assist: "headless" };

/**
 * The previous rule -- "app when the user wants to watch" -- was not a rule: it
 * could not be checked, so 34 historical jobs split 10/24 between the two
 * transports with no way to ask why any single one went where it went.
 */
function resolveRouting(job) {
  if (!ROLES.has(job.role)) {
    throw new ManifestError(
      `job needs role "owner" or "assist", got ${JSON.stringify(job.role ?? null)}\n` +
      `  → owner: the worker answers for acceptance; its evidence is the deliverable\n` +
      `  → assist: the job is material for a deliverable Claude writes\n` +
      `  → test: who answers for this job's acceptance?`,
    );
  }
  if ("mode" in job) {
    throw new ManifestError(
      "`mode` is gone; pass `transport: \"app\" | \"headless\"` instead\n" +
      "  → transport now follows from role, so it is recorded with the reason next to it",
    );
  }
  // Claude is the dispatcher. Nothing is spawned for a Claude job, so there is
  // no transport to record -- writing one would put a chat box in the manifest
  // that never opened.
  if (job.worker === "claude") {
    if (job.transport != null) {
      throw new ManifestError(
        `a claude job has no transport (got ${JSON.stringify(job.transport)})\n` +
        `  → Claude does the work in-process; nothing is dispatched to record`,
      );
    }
    return { role: job.role, transport: null };
  }
  const fallback = DEFAULT_TRANSPORT[job.role];
  const transport = job.transport ?? fallback;
  if (!TRANSPORTS.has(transport)) {
    throw new ManifestError(
      `transport must be "app" or "headless", got ${JSON.stringify(transport)}`,
    );
  }
  if (transport !== fallback && !job.note) {
    throw new ManifestError(
      `job overrides the ${job.role} default transport (${fallback} → ${transport}) with no reason\n` +
      `  → pass note: "<why>"; an override without one is transport picked by feel again`,
    );
  }
  return { role: job.role, transport };
}

/**
 * Jobs are appended with an explicit seq so evidence paths and report ordering
 * stay stable even when jobs finish out of order.
 */
export function addJob(manifestPath, job) {
  let added;
  updateManifest(manifestPath, (m) => {
    const seq = m.jobs.length + 1;
    const { role, transport } = resolveRouting(job);
    added = {
      seq,
      worker: job.worker,
      role,
      transport,
      model: job.model ?? null,
      // Codex takes its tier as a reasoning effort rather than a model name, so
      // recording only `model` would leave every Codex job looking unset.
      effort: job.effort ?? null,
      title: job.title,
      evidence: job.evidence,
      // Path prefixes this job is allowed to write outside tasks/{task}/. Some
      // real work lands there -- an article edit belongs in
      // mwg-content-editor/content-workspaces/ -- and the collect gate treats
      // an undeclared write as a scope violation.
      filesMayModify: job.filesMayModify ?? [],
      status: "pending",
      // Filled in by the adapter when the job starts. The collect gate uses it
      // to decide how long "still running" is allowed to last for this job
      // rather than assuming the global ceiling.
      timeoutMs: null,
      conversationId: null,
      startedAt: null,
      endedAt: null,
      durationSec: null,
      exitCode: null,
      // A transport override lands here so the justification travels with the
      // job into the collect report, not just into whoever ran the command.
      notes: job.note ? [job.note] : [],
      ...job.extra,
    };
    m.jobs.push(added);
    return m;
  });
  return added;
}

/**
 * Appends notes to a job inside the lock.
 *
 * `updateJob` assigns `notes` wholesale, so building the array from a snapshot
 * read outside the lock loses any note another process appended in between --
 * and the collect gate is explicitly expected to run while jobs are still live.
 */
export function appendNote(manifestPath, seq, ...notes) {
  let updated;
  updateManifest(manifestPath, (m) => {
    const job = m.jobs.find((j) => j.seq === seq);
    if (!job) throw new ManifestError(`no job with seq ${seq} in ${manifestPath}`);
    job.notes = [...(job.notes ?? []), ...notes.filter(Boolean)];
    updated = job;
    return m;
  });
  return updated;
}

export function updateJob(manifestPath, seq, patch) {
  let updated;
  updateManifest(manifestPath, (m) => {
    const job = m.jobs.find((j) => j.seq === seq);
    if (!job) throw new ManifestError(`no job with seq ${seq} in ${manifestPath}`);
    Object.assign(job, patch);
    if (job.startedAt && job.endedAt) {
      job.durationSec = Math.round((Date.parse(job.endedAt) - Date.parse(job.startedAt)) / 1000);
    }
    updated = job;
    return m;
  });
  return updated;
}

/**
 * Refuses to dispatch down a transport the manifest did not record.
 *
 * The manifest is the only place a run's shape survives, and phase-3 style
 * measurement reads it back -- so a job recorded as `app` and then fired
 * headless is worse than no record at all. Version-gated for the usual reason:
 * a manifest written before `transport` existed cannot be asked about it.
 */
export function assertTransport(manifestPath, seq, mode) {
  const manifest = readManifest(manifestPath);
  if (!(manifest.version >= 3)) return null;
  const job = manifest.jobs.find((j) => j.seq === seq);
  if (!job || job.transport == null) return null;
  if (job.transport !== mode) {
    throw new ManifestError(
      `job ${seq} is recorded as transport "${job.transport}" but was dispatched as "${mode}"\n` +
      `  → fix the flag, or fix the manifest; do not leave the two disagreeing`,
    );
  }
  return job.transport;
}

export { ManifestError };

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "read") {
      console.log(JSON.stringify(readManifest(rest[0]), null, 2));
    } else if (cmd === "update-job") {
      const [path, seq, patchJson] = rest;
      console.log(JSON.stringify(updateJob(path, Number(seq), JSON.parse(patchJson)), null, 2));
    } else {
      console.error("usage: crew-manifest.mjs read <manifest.json>\n       crew-manifest.mjs update-job <manifest.json> <seq> <patchJson>");
      process.exit(2);
    }
  } catch (err) {
    console.error(`crew-manifest: ${err.message}`);
    process.exit(1);
  }
}
