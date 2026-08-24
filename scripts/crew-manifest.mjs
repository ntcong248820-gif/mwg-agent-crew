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

export const MANIFEST_VERSION = 1;

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
  if (parsed.version !== MANIFEST_VERSION) {
    throw new ManifestError(
      `manifest version ${parsed.version} is not supported (expected ${MANIFEST_VERSION})`,
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
 * Jobs are appended with an explicit seq so evidence paths and report ordering
 * stay stable even when jobs finish out of order.
 */
export function addJob(manifestPath, job) {
  let added;
  updateManifest(manifestPath, (m) => {
    const seq = m.jobs.length + 1;
    added = {
      seq,
      worker: job.worker,
      mode: job.mode ?? null,
      model: job.model ?? null,
      title: job.title,
      evidence: job.evidence,
      // Path prefixes this job is allowed to write outside tasks/{task}/. Some
      // real work lands there -- an article edit belongs in
      // mwg-content-editor/content-workspaces/ -- and the collect gate treats
      // an undeclared write as a scope violation.
      filesMayModify: job.filesMayModify ?? [],
      status: "pending",
      conversationId: null,
      startedAt: null,
      endedAt: null,
      durationSec: null,
      exitCode: null,
      notes: [],
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
