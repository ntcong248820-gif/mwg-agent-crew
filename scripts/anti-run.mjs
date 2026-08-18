#!/usr/bin/env node
/**
 * Run one Antigravity job and refuse to call it a success without proof.
 *
 * Two transports, same contract:
 *   headless  `agy -p` -- fast, no UI, returns structured JSON with duration
 *                         and token usage. The default.
 *   app       `agentapi new-conversation` -- creates a real conversation in the
 *                         Antigravity 2.0 desktop app so the user can watch it,
 *                         then polls the conversation store until it settles.
 *
 * Why the evidence gate exists: agy has been observed returning
 * status=SUCCESS with an empty response and no work done, when a tool it needed
 * was blocked by a permission prompt it could not show. A worker that reports
 * success without writing its evidence file is therefore treated as failed.
 * The only trustworthy signal is a file on disk inside the task folder.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveAntiEnv } from "./anti-env.mjs";
import { antiStatus } from "./anti-status.mjs";
import {
  DEFAULT_TIMEOUT,
  GuardError,
  assertEvidenceAbsent,
  assertEvidenceWritten,
  parseDuration,
  readPrompt,
  readWorkerStatus,
  validateEvidencePath,
} from "./crew-guards.mjs";

const POLL_INTERVAL_MS = 5_000;
const APP_MODELS = new Set(["flash_lite", "flash", "pro", "inherit"]);

/** Keeps `anti-run: ...` as the message prefix for every failure mode. */
class AntiRunError extends GuardError {
  constructor(message, detail) {
    super(message, detail);
    this.name = "AntiRunError";
  }
}

function runHeadless({ promptText, workspace, evidenceAbs, model, timeout, agyMode }) {
  const args = [
    "-p", promptText,
    "--output-format", "json",
    "--add-dir", workspace,          // agy otherwise works in its own scratch dir
    "--dangerously-skip-permissions", // a headless worker cannot answer prompts
    "--print-timeout", timeout,
    "--disable-slash-commands",       // the brief is the whole instruction
  ];
  if (model) args.push("--model", model);
  if (agyMode) args.push("--mode", agyMode);

  const started = new Date();
  const proc = spawnSync("agy", args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: parseDuration(timeout) + 30_000, // let agy hit its own timeout first
    maxBuffer: 64 * 1024 * 1024,
  });
  const endedAt = new Date().toISOString();

  if (proc.error) {
    throw new AntiRunError(`could not run agy: ${proc.error.message}`, "check that agy is on PATH");
  }
  const stdout = (proc.stdout ?? "").trim();
  const stderrTail = (proc.stderr ?? "").trim().split("\n").slice(-5).join("\n");

  if (proc.status !== 0) {
    throw new AntiRunError(`agy exited ${proc.status}`, stderrTail || stdout.slice(0, 500));
  }

  let parsed;
  try {
    // agy prints one JSON object; take the last line in case of stray output.
    parsed = JSON.parse(stdout.split("\n").filter(Boolean).pop());
  } catch (err) {
    throw new AntiRunError(`agy output is not JSON: ${err.message}`, stdout.slice(0, 500));
  }
  if (parsed.status !== "SUCCESS") {
    throw new AntiRunError(`agy reported status ${parsed.status}`, JSON.stringify(parsed).slice(0, 800));
  }
  if (!String(parsed.response ?? "").trim()) {
    throw new AntiRunError(
      "agy returned SUCCESS with an empty response (silent failure)",
      "this usually means a tool it needed was blocked; check the brief and permissions",
    );
  }

  const evidenceBytes = assertEvidenceWritten(
    evidenceAbs,
    `agy conversation ${parsed.conversation_id}`,
  );
  const verdict = readWorkerStatus(evidenceAbs);

  return {
    worker: "antigravity",
    mode: "headless",
    conversationId: parsed.conversation_id,
    startedAt: started.toISOString(),
    endedAt,
    // Two clocks on purpose: durationSec is wall time (what a work log bills)
    // and agentDurationSec is what the agent itself reported (what a prompt cost).
    durationSec: Math.round((Date.parse(endedAt) - started.getTime()) / 1000),
    agentDurationSec: parsed.duration_seconds ? Math.round(parsed.duration_seconds) : null,
    numTurns: parsed.num_turns ?? null,
    usage: parsed.usage ?? null,
    response: parsed.response.trim(),
    evidence: evidenceAbs,
    evidenceBytes,
    status: verdict.status,
    reportedStatus: verdict.reported,
  };
}

function runApp({ promptText, workspace, evidenceAbs, model, title, timeout }) {
  if (model && !APP_MODELS.has(model)) {
    throw new AntiRunError(
      `app mode does not accept model "${model}"`,
      `pick one of: ${[...APP_MODELS].join(", ")}`,
    );
  }
  const { agentapi, env } = resolveAntiEnv(workspace);
  const args = ["new-conversation"];
  if (model) args.push(`--model=${model}`);
  if (title) args.push(`--title=${title}`);
  args.push(promptText);

  const started = new Date();
  let raw;
  try {
    raw = execFileSync(agentapi, args, {
      cwd: workspace,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    throw new AntiRunError(
      "agentapi new-conversation failed",
      String(err.stderr || err.message).trim().slice(0, 600),
    );
  }

  let conversationId;
  try {
    const parsed = JSON.parse(raw);
    conversationId = parsed?.response?.newConversation?.conversationId;
  } catch { /* fall through to the regex below */ }
  if (!conversationId) {
    // The prompt is echoed back in the payload, so match only a bare uuid line.
    conversationId = raw.match(/"conversationId"\s*:\s*"([0-9a-f-]{36})"/)?.[1];
  }
  if (!conversationId) {
    throw new AntiRunError(
      "agentapi did not return a conversation id",
      raw.trim().slice(0, 600),
    );
  }

  // The app gives no completion callback, so poll the conversation store. A
  // conversation that never leaves 0 steps means the app never picked it up.
  // "done" also requires the step count to hold still across two polls: every
  // step of an in-flight conversation has been observed as status 3 as well, so
  // status alone can read as finished between turns.
  const deadline = Date.now() + parseDuration(timeout);
  let last = null;
  let settledAt = null;
  for (;;) {
    let prevSteps = last?.steps ?? null;
    try {
      last = antiStatus(conversationId);
    } catch {
      last = null; // the database appears a moment after the conversation does
    }
    if (last?.state === "done" && last.steps === prevSteps) {
      settledAt = last.steps;
      break;
    }
    if (Date.now() > deadline) {
      throw new AntiRunError(
        `app-mode job did not finish within ${timeout}`,
        `conversation ${conversationId}, last seen ${JSON.stringify(last)}`,
      );
    }
    sleepMs(POLL_INTERVAL_MS);
  }

  const endedAt = new Date().toISOString();
  const evidenceBytes = assertEvidenceWritten(evidenceAbs, `app conversation ${conversationId}`);
  const verdict = readWorkerStatus(evidenceAbs);

  return {
    worker: "antigravity",
    mode: "app",
    conversationId,
    startedAt: started.toISOString(),
    endedAt,
    durationSec: Math.round((Date.parse(endedAt) - started.getTime()) / 1000),
    steps: settledAt,
    evidence: evidenceAbs,
    evidenceBytes,
    status: verdict.status,
    reportedStatus: verdict.reported,
  };
}

/** Blocking sleep: these scripts are synchronous CLI tools, not servers. */
function sleepMs(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

export function antiRun(options) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const evidenceAbs = validateEvidencePath(options.evidence, workspace);
  const promptText = readPrompt(options);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  parseDuration(timeout); // validate before spending anything

  assertEvidenceAbsent(evidenceAbs);

  const mode = options.mode ?? "headless";
  if (mode === "headless") {
    return runHeadless({ promptText, workspace, evidenceAbs, model: options.model, timeout, agyMode: options.agyMode });
  }
  if (mode === "app") {
    return runApp({ promptText, workspace, evidenceAbs, model: options.model, title: options.title, timeout });
  }
  throw new AntiRunError(`unknown mode "${mode}"`, "use --mode headless or --mode app");
}

export { AntiRunError };
export { parseDuration, validateEvidencePath } from "./crew-guards.mjs";

function parseArgv(argv) {
  const out = {};
  const alias = {
    "prompt-file": "promptFile",
    "agy-mode": "agyMode",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new AntiRunError(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new AntiRunError(`--${name} needs a value`);
    out[alias[name] ?? name] = value;
    i += 1;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let opts = {};
  let result = null;
  try {
    opts = parseArgv(process.argv.slice(2));
    result = antiRun(opts);
  } catch (err) {
    // A failed job must be recorded, or collect cannot tell a job that broke
    // from one that never started -- both would read as "pending" forever.
    if (opts.manifest && opts.job) {
      try {
        const { updateJob } = await import("./crew-manifest.mjs");
        updateJob(opts.manifest, Number(opts.job), {
          status: "failed",
          endedAt: new Date().toISOString(),
          failure: err.message,
        });
      } catch (manifestErr) {
        console.error(`anti-run: could not record the failure in the manifest: ${manifestErr.message}`);
      }
    }
    console.error(`anti-run: ${err.message}`);
    process.exit(1);
  }

  // Recording the outcome is deliberately outside the try above: the job has
  // already finished by now, so a manifest write that fails must be reported as
  // a bookkeeping problem, never as a failed job.
  if (opts.manifest && opts.job) {
    try {
      const { updateJob } = await import("./crew-manifest.mjs");
      updateJob(opts.manifest, Number(opts.job), {
        status: result.status,
        reportedStatus: result.reportedStatus,
        conversationId: result.conversationId,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        agentDurationSec: result.agentDurationSec ?? null,
        usage: result.usage ?? null,
        evidenceBytes: result.evidenceBytes,
      });
    } catch (manifestErr) {
      console.error(
        `anti-run: job finished ${result.status} but the manifest was not updated: ${manifestErr.message}\n` +
        `  → the evidence at ${result.evidence} is valid; re-run the manifest update, not the job`,
      );
      console.log(JSON.stringify(result, null, 2));
      process.exit(2); // distinct from 1: the job worked, the bookkeeping did not
    }
  }

  // A worker that skipped the contract's Status line cannot be judged silently.
  if (result.status === "done_unverified") {
    console.error(
      `anti-run: evidence has no "Status:" line, so the outcome is unverified\n` +
      `  → ${result.evidence}`,
    );
  }
  console.log(JSON.stringify(result, null, 2));
}
