#!/usr/bin/env node
/**
 * Run one Codex job under the same contract as anti-run.mjs.
 *
 * Why this exists: Codex was the only runtime in the crew without an adapter.
 * It was dispatched through the plugin's rescue subagent, which is defined as a
 * forwarder -- it may not poll, monitor, or fetch results -- so a Codex job had
 * no timeout, no evidence gate, and nothing that recorded its outcome. On
 * 2026-08-24 a Codex job died two minutes in; its manifest entry carried no
 * failure field at all and the death was noticed twenty minutes later.
 *
 * Everything below exists so that a job which dies cannot be silent:
 *   - settle on `exit`, not `close`. A model-generated shell command can leave a
 *     grandchild holding stdout, and `close` waits for every pipe to reach EOF:
 *     measured 6s late on a trivial case, unbounded in the general one. A child
 *     killed while a grandchild keeps the pipe open never fires `close` at all,
 *     which would hang past every timeout with the manifest stuck on "pending" --
 *     the exact shape of the failure this adapter was written to catch.
 *   - kill the process group, not the pid, so that grandchild goes too.
 *   - an idle watchdog on stdout events, because the observed death was a
 *     process that stopped producing events while its state still read running.
 *   - a manifest write on the success path, the failure path, and every error
 *     path in between. An unrecorded crash reads as "pending" forever.
 *
 * The prompt goes in on stdin rather than argv: a brief is a file, and argv has
 * a length limit that a long brief can reach.
 */
import { appendFileSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  DEFAULT_TIMEOUT,
  GuardError,
  assertEvidenceAbsent,
  judgeJob,
  parseDuration,
  readPrompt,
  validateEvidencePath,
} from "./crew-guards.mjs";

/** A job that emits no stdout event for this long is treated as dead, not as thinking. */
const DEFAULT_IDLE_MS = 120_000;
/** Grace between SIGTERM and SIGKILL for the process group. */
const KILL_GRACE_MS = 5_000;
/** How long to keep draining stdout after the child has exited. */
const DRAIN_MS = 2_000;

/**
 * Measured 2026-08-24: `codex exec -c model_reasoning_effort=bogus` runs happily
 * and exits 0 -- codex ignores a value it does not know instead of rejecting it.
 * So this list is the only thing standing between a typo and a job that quietly
 * ran at the wrong effort. It is deliberately the union of every value seen in
 * codex and plugin documentation: a false rejection is louder and cheaper than a
 * silent downgrade.
 */
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

const KNOWN_FLAGS = new Set([
  "prompt", "promptFile", "evidence", "workspace", "timeout", "idle",
  "model", "effort", "manifest", "job",
]);

class CodexRunError extends GuardError {
  constructor(message, detail) {
    super(message, detail);
    this.name = "CodexRunError";
  }
}

/** Captured before the job starts: a flag that changed under us makes codex fail. */
function codexVersion() {
  try {
    return execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

/**
 * The stream sidecar is written with appendFileSync rather than a WriteStream:
 * this script ends in process.exit(), which does not flush a WriteStream. A
 * measured 2999 of 3001 lines were lost that way -- and those lines are the
 * whole reason the sidecar exists.
 *
 * A sidecar write must never fail the job either. It is a debugging aid, and a
 * job whose work is done does not become a failure because a log line did not
 * land.
 */
function makeStreamWriter(streamPath) {
  let broken = null;
  return {
    write(text) {
      if (broken) return;
      try {
        appendFileSync(streamPath, text);
      } catch (err) {
        broken = err.message;
        process.stderr.write(`codex-run: stream log disabled (${err.message})\n`);
      }
    },
    note(text) {
      // Wrapped as JSONL so the file stays parseable, and so a Monitor tailing
      // the sidecar can see a kill -- which otherwise only ever appeared on this
      // adapter's own stderr, where a Monitor on the stream file cannot see it.
      this.write(`${JSON.stringify({ type: "crew.note", at: new Date().toISOString(), text })}\n`);
    },
    get broken() { return broken; },
  };
}

function buildArgs({ workspace, model, effort, lastMessagePath }) {
  const args = [
    "exec",
    "--json",                        // JSONL events: the heartbeat this adapter watches
    "-C", workspace,
    "--sandbox", "workspace-write",  // a worker writes inside the workspace, nowhere else
    "-o", lastMessagePath,
    "--color", "never",
  ];
  if (model) args.push("-m", model);
  if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
  args.push("-");                    // read the prompt from stdin
  return args;
}

export function codexRun(options) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const evidenceAbs = validateEvidencePath(options.evidence, workspace);
  const promptText = readPrompt(options);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const timeoutMs = parseDuration(timeout); // validates against the 30m ceiling
  const idleMs = options.idle ? parseDuration(options.idle) : DEFAULT_IDLE_MS;
  const effort = options.effort ?? null;
  if (effort && !EFFORTS.has(effort)) {
    throw new CodexRunError(`unknown effort "${effort}"`, `use one of: ${[...EFFORTS].join(", ")}`);
  }

  assertEvidenceAbsent(evidenceAbs);

  // Both sidecars live next to the evidence, inside the task folder: the stream
  // is the only record of how a job died. They are asserted absent for the same
  // reason the evidence is -- a retry after an idle-kill usually happens before
  // any evidence was written, so without this a second run would append into the
  // first run's log and the two deaths would read as one.
  const streamPath = `${evidenceAbs}.codex-stream.jsonl`;
  const lastMessagePath = `${evidenceAbs}.codex-last-message.txt`;
  for (const sidecar of [streamPath, lastMessagePath]) {
    if (existsSync(sidecar)) {
      throw new CodexRunError(
        `a sidecar from an earlier run is still there: ${sidecar}`,
        "use a fresh evidence path per attempt so two runs never share one log",
      );
    }
  }

  const version = codexVersion();
  const args = buildArgs({ workspace, model: options.model, effort, lastMessagePath });
  const stream = makeStreamWriter(streamPath);

  return new Promise((resolveRun, rejectRun) => {
    const startedAt = new Date();
    const child = spawn("codex", args, {
      cwd: workspace,
      // The guard that stops a worker from reading the skill and dispatching.
      env: { ...process.env, MWG_CREW_ROLE: "worker" },
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so a kill reaches the shell commands codex spawns.
      // Killing only the pid leaves a grandchild holding stdout open.
      detached: true,
    });

    let events = 0;
    let residual = "";              // a chunk can split a line; count whole lines only
    let nextHeartbeat = 25;
    let stderrTail = [];
    let killedFor = null;
    let idleTimer = null;
    let drainTimer = null;
    let hardTimer = null;
    let exited = null;
    let settled = false;

    const elapsed = () => Math.round((Date.now() - startedAt.getTime()) / 1000);
    const heartbeat = (note) => {
      // stderr on purpose: stdout carries the one JSON result the dispatcher
      // parses. The stream sidecar gets its own copy via stream.note().
      process.stderr.write(`codex-run: ${note} events=${events} t=${elapsed()}s\n`);
    };

    const signalGroup = (sig) => {
      try {
        process.kill(-child.pid, sig); // negative pid = the whole group
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };

    const kill = (reason) => {
      if (killedFor) return;
      killedFor = reason;
      heartbeat(`killing: ${reason}`);
      stream.note(`crew killed this job: ${reason}`);
      signalGroup("SIGTERM");
      // Escalation is unconditional: the point of a hard kill is that it happens
      // even when the polite one was ignored.
      hardTimer = setTimeout(() => {
        if (!settled) {
          heartbeat("escalating to SIGKILL");
          signalGroup("SIGKILL");
          // If even SIGKILL leaves the pipes held open by a grandchild, the exit
          // handler still settles this run through the drain window below.
        }
      }, KILL_GRACE_MS);
    };

    const clearTimers = () => {
      for (const t of [idleTimer, drainTimer, hardTimer, overall]) if (t) clearTimeout(t);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      // Stop waiting on pipes a grandchild may still hold.
      child.stdout.destroy();
      child.stderr.destroy();

      const endedAt = new Date().toISOString();
      const code = exited?.code ?? null;
      const signal = exited?.signal ?? null;
      const runtimeOk = code === 0 && !killedFor;
      const runtimeDetail = runtimeOk ? null
        : killedFor ? `codex killed: ${killedFor}`
        : `codex exited ${code}${signal ? ` on ${signal}` : ""}${stderrTail.length ? `: ${stderrTail.join(" | ")}` : ""}`;

      // Whatever the runtime did, the evidence gets the first word: a job killed
      // for going quiet may still have written a complete report before it went
      // quiet.
      let verdict;
      try {
        verdict = judgeJob(evidenceAbs, {
          runtimeOk,
          runtimeDetail,
          context: `codex run, ${events} stream events, log at ${streamPath}`,
        });
      } catch (err) {
        rejectRun(err);
        return;
      }

      resolveRun({
        worker: "codex",
        mode: "exec",
        model: options.model ?? null,
        effort,
        codexVersion: version,
        startedAt: startedAt.toISOString(),
        endedAt,
        durationSec: Math.round((Date.parse(endedAt) - startedAt.getTime()) / 1000),
        streamEvents: events,
        exitCode: code,
        signal,
        killedFor,
        stream: streamPath,
        streamBroken: stream.broken,
        lastMessage: lastMessagePath,
        evidence: evidenceAbs,
        ...verdict,
      });
    };

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => kill(`no stdout event for ${Math.round(idleMs / 1000)}s`), idleMs);
    };

    const overall = setTimeout(() => kill(`exceeded ${timeout}`), timeoutMs);
    armIdle();

    child.stdout.on("data", (chunk) => {
      stream.write(chunk);
      const parts = (residual + chunk).split("\n");
      residual = parts.pop() ?? "";
      events += parts.filter(Boolean).length;
      // Only stdout re-arms the watchdog. Re-arming on stderr let a process that
      // had stopped working keep itself alive with warning chatter -- the silent
      // crashloop the skill warns about.
      armIdle();
      if (events >= nextHeartbeat) {
        heartbeat("running");
        nextHeartbeat = events + 25; // a threshold, not a modulo: a multi-line
      }                              // chunk can step straight over a multiple
    });

    child.stderr.on("data", (chunk) => {
      // Wrapped, not raw: raw stderr interleaved mid-line would break every
      // parser over a file named .jsonl.
      stream.write(`${JSON.stringify({ type: "crew.stderr", text: String(chunk) })}\n`);
      stderrTail = [...stderrTail, ...String(chunk).split("\n").filter(Boolean)].slice(-5);
    });

    // EPIPE, reproduced: a child that dies without draining stdin rejects a
    // brief larger than the pipe buffer. Uncaught, it crashed the adapter before
    // the manifest failure write -- on the watchdog path, of all places.
    child.stdin.on("error", (err) => {
      stream.note(`stdin write failed: ${err.code ?? err.message}`);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      rejectRun(new CodexRunError(`could not run codex: ${err.message}`, "check that codex is on PATH"));
    });

    // exit, not close: see the header. The drain window gives stdout a bounded
    // chance to deliver its tail without letting a lingering grandchild hold this
    // run open forever.
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(finish, DRAIN_MS);
    });
    child.on("close", () => finish());

    child.stdin.end(promptText);
  });
}

export { CodexRunError };

/**
 * The message has to print what the CLI actually accepts. KNOWN_FLAGS holds the
 * internal keys, so a raw dump of it would tell the caller to use --promptFile
 * when the flag is --prompt-file.
 */
function knownFlagSpellings(alias) {
  const cliName = Object.fromEntries(Object.entries(alias).map(([cli, key]) => [key, cli]));
  return [...KNOWN_FLAGS].map((key) => `--${cliName[key] ?? key}`);
}

function parseArgv(argv) {
  const out = {};
  const alias = { "prompt-file": "promptFile", "idle-timeout": "idle" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new CodexRunError(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    const key = alias[name] ?? name;
    // An unknown flag used to be accepted and ignored, which meant a typo in
    // --idle-timeout silently disabled the watchdog.
    if (!KNOWN_FLAGS.has(key)) {
      throw new CodexRunError(`unknown flag --${name}`, `known flags: ${knownFlagSpellings(alias).join(" ")}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new CodexRunError(`--${name} needs a value`);
    out[key] = value;
    i += 1;
  }
  return out;
}

/** Exit 3: the job finished but a human has to look before it counts. */
function needsHuman(result) {
  return Boolean(result.runtimeVerdict)
    || result.status === "done_unverified"
    || result.status === "blocked"
    || result.status === "needs_context";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let opts = {};
  let result = null;
  // Captured before the job starts so a job that dies still carries a duration.
  const dispatchedAt = new Date().toISOString();
  try {
    opts = parseArgv(process.argv.slice(2));
    result = await codexRun(opts);
  } catch (err) {
    // The whole point of this adapter: a death nobody records reads as "pending"
    // forever, which is exactly what happened on 2026-08-24.
    if (opts.manifest && opts.job) {
      try {
        const { updateJob } = await import("./crew-manifest.mjs");
        updateJob(opts.manifest, Number(opts.job), {
          status: "failed",
          startedAt: dispatchedAt,
          endedAt: new Date().toISOString(),
          codexVersion: codexVersion(),
          failure: err.message,
        });
      } catch (manifestErr) {
        console.error(`codex-run: could not record the failure in the manifest: ${manifestErr.message}`);
      }
    }
    console.error(`codex-run: ${err.message}`);
    process.exit(1);
  }

  // Outside the try above: the job is finished by now, so a failed manifest
  // write is a bookkeeping problem and must never read as a failed job.
  if (opts.manifest && opts.job) {
    try {
      const { updateJob } = await import("./crew-manifest.mjs");
      const { readManifest } = await import("./crew-manifest.mjs");
      const prior = readManifest(opts.manifest).jobs.find((j) => j.seq === Number(opts.job))?.notes ?? [];
      updateJob(opts.manifest, Number(opts.job), {
        status: result.status,
        reportedStatus: result.reportedStatus,
        runtimeVerdict: result.runtimeVerdict,
        model: result.model,
        effort: result.effort,
        codexVersion: result.codexVersion,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        exitCode: result.exitCode,
        signal: result.signal,
        streamEvents: result.streamEvents,
        evidenceBytes: result.evidenceBytes,
        // Recorded so the collect step can find the log without guessing its name.
        stream: result.stream,
        lastMessage: result.lastMessage,
        notes: result.runtimeVerdict
          ? [...prior, `runtime báo fail (${result.runtimeVerdict}) nhưng evidence tự phán ${result.reportedStatus} — cần người đọc`]
          : prior,
      });
    } catch (manifestErr) {
      console.error(
        `codex-run: job finished ${result.status} but the manifest was not updated: ${manifestErr.message}\n` +
        `  → the evidence at ${result.evidence} is valid; re-run the manifest update, not the job`,
      );
      console.log(JSON.stringify(result, null, 2));
      process.exit(2); // distinct from 1: the job worked, the bookkeeping did not
    }
  }

  if (result.runtimeVerdict) {
    console.error(
      `codex-run: the runtime disagreed with the evidence (${result.runtimeVerdict})\n` +
      `  → evidence judged itself ${result.reportedStatus}; a human must read ${result.evidence}`,
    );
  }
  if (result.status === "done_unverified") {
    console.error(`codex-run: evidence has no "Status:" line, so the outcome is unverified\n  → ${result.evidence}`);
  }
  console.log(JSON.stringify(result, null, 2));
  // Background dispatch made the exit code the ping, so a job that needs a human
  // must not ping as a clean success.
  process.exit(needsHuman(result) ? 3 : 0);
}
