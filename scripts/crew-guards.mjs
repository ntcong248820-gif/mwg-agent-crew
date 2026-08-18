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
