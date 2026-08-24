#!/usr/bin/env node
/**
 * Repair a run manifest from the evidence on disk.
 *
 * A job can finish its work and still leave the manifest stale: the runtime
 * that was carrying it can die between the worker writing evidence and the
 * bookkeeping being recorded. That happened for real -- a Codex subagent was
 * killed when its parent process exited, after the worker had already written
 * a complete report. The work was not lost; only the manifest was wrong.
 *
 * The rule this encodes: evidence on disk outranks the manifest. But the repair
 * is deliberately narrow -- it only fills in jobs that never reached a terminal
 * state, and never rewrites a verdict that was already recorded. A reconcile
 * that could overwrite results would be a second way to lose them.
 *
 * A job with no evidence file is left alone and reported as such: it may still
 * be running. Deciding that it failed is the dispatcher's call, not this
 * script's, because only the dispatcher knows whether the runtime is still up.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readManifest, updateJob } from "./crew-manifest.mjs";
import { readWorkerStatus } from "./crew-guards.mjs";

/**
 * The rule, learned from a real run: evidence with a valid Status line outranks
 * every status the runtime recorded -- including "failed".
 *
 * An app-mode job timed out at 8 minutes and was recorded as failed, but its
 * write was queued behind an approval step and landed afterwards. The evidence
 * on disk was complete and correct while the manifest called the job failed.
 * A reconcile that respected "failed" would have preserved exactly the wrong
 * answer.
 *
 * Two things keep this from becoming a way to lose results: a job is only
 * patched when its evidence carries a real Status line, and a job whose status
 * already came from that evidence (reportedStatus is set) is left alone.
 */
export function reconcileRun(manifestPath, { dryRun = false } = {}) {
  const abs = resolve(manifestPath);
  const manifest = readManifest(abs);
  const runDir = dirname(abs);
  const result = { runId: manifest.runId, patched: [], waiting: [], untouched: [] };

  for (const job of manifest.jobs) {
    const evidenceAbs = resolve(runDir, job.evidence.split("/").pop());
    const candidate = existsSync(job.evidence) ? resolve(job.evidence)
      : existsSync(evidenceAbs) ? evidenceAbs
      : null;

    if (!candidate) {
      // No evidence yet: the job may still be running, and only the dispatcher
      // knows whether its runtime is still alive. Report, do not judge.
      result.waiting.push({ seq: job.seq, status: job.status, evidence: job.evidence });
      continue;
    }

    const verdict = readWorkerStatus(candidate);
    if (job.reportedStatus) {
      result.untouched.push({ seq: job.seq, status: job.status, why: "đã đọc từ evidence trước đó" });
      continue;
    }
    if (!verdict.reported) {
      result.untouched.push({ seq: job.seq, status: job.status, why: "evidence không có dòng Status" });
      continue;
    }

    result.patched.push({
      seq: job.seq, from: job.status, to: verdict.status,
      reported: verdict.reported, evidence: candidate,
    });
    if (!dryRun) {
      updateJob(abs, job.seq, {
        status: verdict.status,
        reportedStatus: verdict.reported,
        endedAt: job.endedAt ?? new Date().toISOString(),
        notes: [...(job.notes ?? []), `reconcile: ${job.status} → ${verdict.status} theo evidence trên đĩa`],
      });
    }
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const manifestPath = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (!manifestPath) {
    console.error("usage: crew-reconcile.mjs <manifest.json> [--dry-run]");
    process.exit(2);
  }
  try {
    const r = reconcileRun(manifestPath, { dryRun });
    const verb = dryRun ? "sẽ sửa" : "đã sửa";
    for (const p of r.patched) console.log(`${verb} job ${p.seq}: ${p.from} → ${p.to} (${p.reported ?? "không có dòng Status"})`);
    for (const w of r.waiting) console.log(`chờ job ${w.seq}: chưa có evidence tại ${w.evidence}`);
    for (const u of r.untouched) console.log(`giữ nguyên job ${u.seq} (${u.status}): ${u.why}`);
    if (r.patched.length === 0 && r.waiting.length === 0) console.log("manifest đã khớp với evidence, không cần sửa");
  } catch (err) {
    console.error(`crew-reconcile: ${err.message}`);
    process.exit(1);
  }
}
