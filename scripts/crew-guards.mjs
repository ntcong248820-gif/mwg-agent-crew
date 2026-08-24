#!/usr/bin/env node
/**
 * The checks every crew worker must pass, regardless of which runtime executes
 * it. Antigravity uses them today; the Codex runner uses the same ones so a
 * "done" from either worker means the same thing.
 *
 * The central rule: a worker's own claim of success is not evidence. Only a
 * non-empty file inside the task folder is.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// Ceilings come from mwg-agent-crew/cost-gate.md; a runaway agent burns quota.
export const DEFAULT_TIMEOUT = "15m";
export const MAX_TIMEOUT_MS = 30 * 60_000;

export class GuardError extends Error {
  constructor(message, detail) {
    super(detail ? `${message}\n  ${detail}` : message);
    this.name = "GuardError";
    this.detail = detail;
  }
}

/** Accepts Go-style durations because that is what agy's --print-timeout takes. */
export function parseDuration(value) {
  const matches = [...String(value).matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)];
  if (matches.length === 0) {
    throw new GuardError(`cannot parse duration "${value}"`, 'use forms like "90s", "15m", "1h30m"');
  }
  const unit = { h: 3_600_000, m: 60_000, s: 1000 };
  const ms = matches.reduce((sum, [, n, u]) => sum + Number(n) * unit[u], 0);
  if (ms <= 0) throw new GuardError(`duration "${value}" is not positive`);
  if (ms > MAX_TIMEOUT_MS) {
    throw new GuardError(
      `duration "${value}" exceeds the crew ceiling of 30m`,
      "split the job instead of raising the timeout (see cost-gate.md)",
    );
  }
  return ms;
}

/**
 * Evidence must land inside the task folder, so a crew run leaves its trail
 * where the workspace task contract expects it and never scattered in the repo.
 */
export function validateEvidencePath(evidence, workspace) {
  if (!evidence) {
    throw new GuardError("--evidence is required", "every job must write a report file under tasks/");
  }
  const abs = resolve(workspace, evidence);
  const tasksRoot = join(resolve(workspace), "tasks") + sep;
  if (!abs.startsWith(tasksRoot)) {
    throw new GuardError(`evidence path is outside the task tree: ${abs}`, `it must be under ${tasksRoot}`);
  }
  return abs;
}

/** A stale file from an earlier run would read as proof of this one. */
export function assertEvidenceAbsent(evidenceAbs) {
  if (existsSync(evidenceAbs)) {
    throw new GuardError(
      `evidence file already exists: ${evidenceAbs}`,
      "use a fresh path per job so a stale file can never be mistaken for proof",
    );
  }
}

/**
 * The gate that catches a silent success: agy has been observed returning
 * status=SUCCESS with an empty response and no work done, when a tool it needed
 * was blocked by a permission prompt it could not show.
 */
export function assertEvidenceWritten(evidenceAbs, context) {
  if (!existsSync(evidenceAbs)) {
    throw new GuardError(
      "the worker reported success but wrote no evidence file",
      `expected ${evidenceAbs}\n  ${context}`,
    );
  }
  const size = statSync(evidenceAbs).size;
  if (size === 0) {
    throw new GuardError(
      "the worker created an empty evidence file",
      `${evidenceAbs} is 0 bytes\n  ${context}`,
    );
  }
  return size;
}

/**
 * The worker's own `Status:` line, read back off the evidence file.
 *
 * A worker that finished and a worker that stopped at the cost gate both leave a
 * non-empty evidence file, so file existence alone cannot tell them apart. The
 * contract puts the verdict on the last Status line; this reads it rather than
 * trusting the runtime's exit code.
 */
const WORKER_STATUS = {
  DONE: "done",
  DONE_WITH_CONCERNS: "done_with_concerns",
  BLOCKED: "blocked",
  NEEDS_CONTEXT: "needs_context",
};

export function readWorkerStatus(evidenceAbs) {
  const lines = readFileSync(evidenceAbs, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const verdict = lines[i].match(/^Status:\s*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)\b/)?.[1];
    if (verdict) return { status: WORKER_STATUS[verdict], reported: verdict };
  }
  // No Status line means the worker ignored the contract, so we cannot say the
  // job succeeded -- but the evidence may still be usable. Flag, do not judge.
  return { status: "done_unverified", reported: null };
}

export function readPrompt({ prompt, promptFile }) {
  if (promptFile) {
    const abs = resolve(promptFile);
    if (!existsSync(abs)) throw new GuardError(`no prompt file at ${abs}`);
    const text = readFileSync(abs, "utf8").trim();
    if (!text) throw new GuardError(`prompt file ${abs} is empty`);
    return text;
  }
  const text = (prompt ?? "").trim();
  if (!text) throw new GuardError("--prompt or --prompt-file is required");
  return text;
}

/**
 * The verdict for one finished job, with evidence outranking the runtime.
 *
 * Both adapters used to ask the runtime first and only look at the evidence
 * afterwards. That inverted the module's own rule and cost two real jobs: agy
 * returned status=ERROR twice on 2026-08-24 while the work was complete and the
 * evidence file met its acceptance criteria, so both were recorded as failed and
 * had to be patched by hand into a status that does not exist in the contract.
 *
 * So the runtime's own verdict is consulted in exactly two places: when there is
 * no usable evidence (then it is all we have), and when the evidence carries no
 * Status line (then it decides whether an unverified report is a finished job or
 * a corpse). A runtime failure over evidence that does carry a Status line is
 * recorded as disagreement -- `runtimeVerdict` -- not as failure, because the
 * collect step has to show a human that disagreement rather than bury it.
 */
export function judgeJob(evidenceAbs, { runtimeOk, runtimeDetail = null, context = "" }) {
  if (!existsSync(evidenceAbs) || statSync(evidenceAbs).size === 0) {
    // No evidence: the runtime's account is the only account there is. Two
    // different stories need two different headlines -- a worker that claimed
    // success and wrote nothing is a silent failure, while a worker that was
    // killed never got the chance to claim anything.
    if (runtimeOk) assertEvidenceWritten(evidenceAbs, context);
    throw new GuardError(
      "the job did not finish and left no usable evidence",
      `${runtimeDetail ?? "the runtime failed with no detail"}\n  expected ${evidenceAbs}\n  ${context}`,
    );
  }
  const evidenceBytes = statSync(evidenceAbs).size;
  const verdict = readWorkerStatus(evidenceAbs);

  if (!verdict.reported && !runtimeOk) {
    throw new GuardError(
      "the runtime failed and the evidence carries no Status line",
      `${runtimeDetail ?? "no detail"}\n  the evidence at ${evidenceAbs} is kept for reading, but it cannot be judged`,
    );
  }

  return {
    status: verdict.status,
    reportedStatus: verdict.reported,
    evidenceBytes,
    // Set only when the runtime disagreed with evidence that judged itself.
    runtimeVerdict: runtimeOk ? null : (runtimeDetail ?? "runtime reported failure"),
  };
}
