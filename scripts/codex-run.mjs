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
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { resolveCompanion } from "./codex-companion-path.mjs";
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
 * Per-write cap for the stream log. An event carrying a whole file read is both
 * the bulk of the log's size and the part most likely to hold something that
 * should not be written down; a truncated event still says what happened.
 */
const MAX_EVENT_BYTES = 8 * 1024;

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
  "model", "effort", "manifest", "job", "mode",
]);

/** Same two words the manifest records, so the flag and the record cannot drift. */
const MODES = new Set(["headless", "app"]);

/**
 * The companion reports these while a job is still going. Anything else is a
 * settled job -- `completed`, `failed`, or `cancelled`.
 */
const COMPANION_ACTIVE = new Set(["queued", "running"]);

/** Slack on top of the job's own ceiling, so a hung companion still returns. */
const COMPANION_WAIT_SLACK_MS = 60_000;
/** Dispatch is a queue insert, not the job: it should answer in seconds. */
const COMPANION_DISPATCH_TIMEOUT_MS = 120_000;

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
        const s = String(text);
        appendFileSync(
          streamPath,
          s.length > MAX_EVENT_BYTES ? `${s.slice(0, MAX_EVENT_BYTES)}…[crew: cắt ${s.length - MAX_EVENT_BYTES} byte]\n` : s,
        );
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

/**
 * Where a job's raw log goes: the task's own `data/` folder, never next to the
 * evidence in `reports/`.
 *
 * The reason is that a task's `data/` folder is already ignored by git, for both
 * the flat and the work-item layout. Keeping the log beside the evidence meant
 * same fact -- "these two files are legitimate and must not be committed" --
 * had to be written in three places: gitignore patterns, a whitelist in the
 * skill's collect step, and an exception in the collect gate. One existing rule
 * replaces all three, and the manifest records the path so nothing has to guess
 * the name.
 */
export function resolveLogDir(evidenceAbs, workspace) {
  const rel = relative(workspace, evidenceAbs).split(sep);
  const i = rel.lastIndexOf("reports");
  // rel[i + 1] is the run folder; if it is the evidence file itself the job was
  // dispatched loose, without a run folder.
  const inRunFolder = i > 0 && i + 2 <= rel.length - 1;
  const owner = i > 0 ? rel.slice(0, i) : rel.slice(0, 2);
  const runName = inRunFolder ? rel[i + 1] : "loose";
  return join(workspace, ...owner, "data", "crew-logs", runName);
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

/**
 * Everything both transports need before either one spawns anything. Kept
 * deliberately small: the two paths share their inputs and their guards, not
 * their control flow, and pretending otherwise is how one transport's fix
 * quietly changes the other's behaviour.
 */
function prepareRun(options) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const evidenceAbs = validateEvidencePath(options.evidence, workspace);
  const promptText = readPrompt(options);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const timeoutMs = parseDuration(timeout); // validates against the 30m ceiling
  const effort = options.effort ?? null;
  if (effort && !EFFORTS.has(effort)) {
    throw new CodexRunError(`unknown effort "${effort}"`, `use one of: ${[...EFFORTS].join(", ")}`);
  }

  assertEvidenceAbsent(evidenceAbs);

  // The log lives under the task's data/ folder (see resolveLogDir).
  const logDir = resolveLogDir(evidenceAbs, workspace);
  mkdirSync(logDir, { recursive: true });
  const base = evidenceAbs.split(sep).pop().replace(/\.md$/, "");
  return { workspace, evidenceAbs, promptText, timeout, timeoutMs, effort, logDir, base };
}

/**
 * Sidecars are asserted absent for the same reason the evidence is: a retry
 * after an idle-kill usually happens before any evidence was written, so
 * without this a second run appends into the first run's log and the two deaths
 * read as one.
 */
function assertSidecarsAbsent(paths) {
  for (const sidecar of paths) {
    if (existsSync(sidecar)) {
      throw new CodexRunError(
        `a sidecar from an earlier run is still there: ${sidecar}`,
        "use a fresh evidence path per attempt so two runs never share one log",
      );
    }
  }
}

export function codexRun(options) {
  const {
    workspace, evidenceAbs, promptText, timeout, timeoutMs, effort, logDir, base,
  } = prepareRun(options);
  const idleMs = options.idle ? parseDuration(options.idle) : DEFAULT_IDLE_MS;

  const streamPath = join(logDir, `${base}.codex-stream.jsonl`);
  const lastMessagePath = join(logDir, `${base}.codex-last-message.txt`);
  assertSidecarsAbsent([streamPath, lastMessagePath]);

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

/**
 * One companion call. Parsed defensively on purpose: this is another project's
 * CLI, so a field that moved must produce a named error rather than an
 * `undefined` that travels three functions before it fails.
 */
function callCompanion(companion, args, { workspace, timeoutMs, what }) {
  const proc = spawnSync(process.execPath, [companion, ...args], {
    cwd: workspace,
    encoding: "utf8",
    timeout: timeoutMs,
    // Same recursion guard as the headless path: the detached worker the
    // companion spawns inherits this env, so the Codex process running the job
    // reads the skill as a worker and refuses to dispatch further.
    env: { ...process.env, MWG_CREW_ROLE: "worker" },
    maxBuffer: 16 * 1024 * 1024,
  });
  const stderrTail = String(proc.stderr ?? "").trim().slice(-600);
  if (proc.error?.code === "ETIMEDOUT" || (proc.signal && proc.status === null)) {
    throw new CodexRunError(
      `companion ${what} did not return within ${Math.round(timeoutMs / 1000)}s`,
      stderrTail || "no stderr",
    );
  }
  if (proc.error) throw new CodexRunError(`could not run the companion: ${proc.error.message}`, companion);
  if (proc.status !== 0) {
    throw new CodexRunError(`companion ${what} exited ${proc.status}`, stderrTail || "no stderr");
  }
  const raw = String(proc.stdout ?? "");
  // A future plugin version printing a banner before the JSON must not read as
  // a protocol break, so fall back to the first brace.
  const candidates = [raw, raw.slice(raw.indexOf("{"))];
  for (const text of candidates) {
    try { return JSON.parse(text); } catch { /* try the next shape */ }
  }
  throw new CodexRunError(`companion ${what} did not print JSON`, raw.trim().slice(0, 600));
}

/**
 * The app transport: a real thread in the Codex app, which is the whole point --
 * an owner job is one whose evidence IS the deliverable, so the person who will
 * be judged on it gets to watch it being made.
 *
 * Measured 2026-08-25 against companion 1.0.5, because a parser written from
 * guesses is how a transport fails silently:
 *   task --background --json  ->  { jobId, status: "queued", title, summary, logFile }
 *   status <id> --wait --json ->  { workspaceRoot, job: {...}, waitTimedOut, timeoutMs }
 *   job.status                ->  queued | running | completed | failed | cancelled
 *   job.threadId              ->  the app thread, populated by the time it settles
 *
 * Unlike Anti's app mode there is a real completion signal here (`--wait`
 * blocks), so this does not poll the evidence file. The timeout ceiling is still
 * enforced separately, because `--wait` itself can outlive a dead broker.
 */
export async function codexRunApp(options) {
  const {
    workspace, evidenceAbs, promptText, timeout, timeoutMs, effort, logDir, base,
  } = prepareRun(options);

  let companion;
  try {
    companion = resolveCompanion();
  } catch (err) {
    // Never fall back to headless. A manifest that says `app` while nothing
    // opened is exactly the silent-substitution failure this harness exists to
    // catch, and it would be invisible until someone went looking for a thread.
    throw new CodexRunError(err.message, err.detail);
  }

  const promptPath = join(logDir, `${base}.codex-app-prompt.md`);
  const statusPath = join(logDir, `${base}.codex-app-status.json`);
  assertSidecarsAbsent([promptPath, statusPath]);
  // The companion reads the prompt from a file, so `--prompt` and
  // `--prompt-file` both land here and the file doubles as the audit record.
  writeFileSync(promptPath, promptText, "utf8");

  const version = codexVersion();
  const startedAt = new Date();

  const dispatchArgs = [
    "task", "--background", "--json",
    "--prompt-file", promptPath,
    "--cwd", workspace,
    // Always write. Not role-dependent, despite what the plan first said: every
    // crew job has to write its own evidence file, so a read-only app job could
    // not satisfy the evidence gate at all. This also keeps the two transports
    // on one contract -- headless already runs `--sandbox workspace-write`.
    "--write",
  ];
  if (options.model) dispatchArgs.push("-m", options.model);
  if (effort) dispatchArgs.push("--effort", effort);

  const queued = callCompanion(companion, dispatchArgs, {
    workspace, timeoutMs: COMPANION_DISPATCH_TIMEOUT_MS, what: "task dispatch",
  });
  const jobId = queued?.jobId;
  if (typeof jobId !== "string" || !jobId) {
    throw new CodexRunError(
      "companion dispatch returned no jobId",
      `got: ${JSON.stringify(queued).slice(0, 400)}`,
    );
  }
  process.stderr.write(`codex-run: app job ${jobId} queued, waiting up to ${timeout}\n`);

  const snapshot = callCompanion(companion, [
    "status", jobId, "--wait",
    "--timeout-ms", String(timeoutMs),
    "--poll-interval-ms", "2000",
    "--json", "--cwd", workspace,
  ], { workspace, timeoutMs: timeoutMs + COMPANION_WAIT_SLACK_MS, what: `status --wait for ${jobId}` });

  try {
    writeFileSync(statusPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  } catch { /* an audit copy must not fail a finished job */ }

  const job = snapshot?.job;
  if (!job || typeof job.status !== "string") {
    throw new CodexRunError(
      "companion status returned no job.status",
      `got: ${JSON.stringify(snapshot).slice(0, 400)}`,
    );
  }

  const timedOut = Boolean(snapshot.waitTimedOut) || COMPANION_ACTIVE.has(job.status);
  let cancelled = null;
  if (timedOut) {
    // Cancel before judging, so a job that outlived its allowance is not left
    // running against a workspace nobody is watching any more.
    try {
      callCompanion(companion, ["cancel", jobId, "--json", "--cwd", workspace], {
        workspace, timeoutMs: 60_000, what: `cancel ${jobId}`,
      });
      cancelled = "cancelled after timeout";
    } catch (err) {
      cancelled = `cancel failed: ${err.message}`;
    }
    process.stderr.write(`codex-run: ${cancelled}\n`);
  }

  const runtimeOk = job.status === "completed" && !timedOut;
  const runtimeDetail = runtimeOk ? null
    : timedOut ? `companion job did not settle within ${timeout} (status ${job.status}); ${cancelled}`
    : `companion job ${job.status}${job.errorMessage ? `: ${job.errorMessage}` : ""}`;

  // Evidence gets the first word even here: a job the companion calls `failed`
  // may still have written a complete report before it fell over. If it wrote
  // nothing, judgeJob throws and the caller records the failure -- which is the
  // whole reason this adapter exists.
  const verdict = judgeJob(evidenceAbs, {
    runtimeOk,
    runtimeDetail,
    context: `codex app job ${jobId}, thread ${job.threadId ?? "none"}, log at ${job.logFile ?? "unknown"}`,
  });

  const endedAt = new Date().toISOString();
  return {
    worker: "codex",
    mode: "app",
    model: options.model ?? null,
    effort,
    codexVersion: version,
    startedAt: startedAt.toISOString(),
    endedAt,
    durationSec: Math.round((Date.parse(endedAt) - startedAt.getTime()) / 1000),
    // The provenance field the collect gate already asks about for app-mode
    // jobs. Reusing it means no new branch in the gate to forget to update.
    conversationId: job.threadId ?? null,
    companionJobId: jobId,
    companionStatus: job.status,
    turnId: job.turnId ?? null,
    companionLog: job.logFile ?? null,
    statusFile: statusPath,
    prompt: promptPath,
    // Null, not 0: nothing here exited. The gate reads provenance from
    // conversationId for app jobs, and a fake 0 would claim a clean exit.
    exitCode: null,
    killedFor: timedOut ? runtimeDetail : null,
    evidence: evidenceAbs,
    ...verdict,
  };
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
  let mode = "headless";
  let result = null;
  // Captured before the job starts so a job that dies still carries a duration.
  const dispatchedAt = new Date().toISOString();
  try {
    opts = parseArgv(process.argv.slice(2));
    mode = opts.mode ?? "headless";
    if (!MODES.has(mode)) {
      throw new CodexRunError(`unknown mode "${mode}"`, `use one of: ${[...MODES].join(", ")}`);
    }
    // Recorded before the job spawns, not after it returns. A job that is still
    // working has no result to write, so without this the manifest showed it as
    // `pending` with no start time -- and the collect gate cannot tell a live
    // job from one that never launched, nor attribute any file it writes while
    // it runs. `timeoutMs` goes down here for the same reason: the gate needs
    // this job's own allowance to decide when silence means death.
    if (opts.manifest && opts.job) {
      const { assertTransport, updateJob } = await import("./crew-manifest.mjs");
      // Before anything is spawned: a job recorded as one transport and fired
      // down the other leaves a manifest that lies, and the manifest is the only
      // thing later measurement can read.
      assertTransport(opts.manifest, Number(opts.job), mode);
      updateJob(opts.manifest, Number(opts.job), {
        status: "running",
        startedAt: dispatchedAt,
        timeoutMs: parseDuration(opts.timeout ?? DEFAULT_TIMEOUT),
      });
    }
    result = mode === "app" ? await codexRunApp(opts) : await codexRun(opts);
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
      const priorJob = readManifest(opts.manifest).jobs.find((j) => j.seq === Number(opts.job)) ?? {};
      const prior = [
        ...(priorJob.notes ?? []),
        // Carried over before `failure` is cleared below, or the retry would
        // erase the only record that an earlier attempt died.
        ...(priorJob.failure ? [`lượt trước fail: ${priorJob.failure}`] : []),
      ];
      updateJob(opts.manifest, Number(opts.job), {
        status: result.status,
        reportedStatus: result.reportedStatus,
        runtimeVerdict: result.runtimeVerdict,
        model: result.model,
        // A retry that succeeded must not inherit the previous attempt's
        // failure: the field would keep firing a WARN on a job that is now
        // clean, and a WARN that cries on every retried job is one people learn
        // to scroll past. The history stays in `notes`, which is append-only.
        failure: undefined,
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
        // App-transport provenance. Undefined on the headless path, and
        // JSON.stringify drops undefined, so no headless job grows empty fields.
        transportMode: result.mode,
        conversationId: result.conversationId,
        companionJobId: result.companionJobId,
        companionStatus: result.companionStatus,
        companionLog: result.companionLog,
        turnId: result.turnId,
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
