#!/usr/bin/env node
/**
 * The lifecycle of codex-run.mjs, driven by a fake codex on PATH.
 *
 * Every case here is a failure shape that a real Codex run will not produce on
 * demand, and five of them are defects that shipped once: settling on `close`
 * hung forever behind a grandchild holding stdout, an oversized brief crashed on
 * EPIPE before the manifest was written, a broken log file crashed the adapter,
 * the watchdog re-armed on stderr chatter, and a retry appended into the
 * previous attempt's log.
 *
 * Run: node mwg-agent-crew/tests/codex-lifecycle.test.mjs
 */
import { spawnSync } from "node:child_process";
import { readdirSync, renameSync } from "node:fs";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createRun, addJob, readManifest } from "../scripts/crew-manifest.mjs";
import { resolveLogDir } from "../scripts/codex-run.mjs";
import { FIXTURE_BIN, FIXTURES, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("codex-lifecycle");
const ADAPTER = join(MODULE_ROOT, "scripts", "codex-run.mjs");
const RUN_DIR_REL = join("tasks", "t", "reports", "crew-test");

const ws = tmpWorkspace("lifecycle-");
const brief = writeFile(join(ws, "brief.md"), "do the thing\n");
// Larger than the pipe buffer, which is what turns a child that never reads
// stdin into an EPIPE instead of a harmless short write.
const bigBrief = writeFile(join(ws, "big-brief.md"), "x".repeat(200_000));
/** What a worker leaves behind when it did its job: the last line is the verdict. */
const DONE_BODY = "work\n\nStatus: DONE\nSummary: ok\n";

/** Runs the adapter the way the skill dispatches it, and reports how it ended. */
function run({ mode, evidence, promptFile = brief, extra = [], timeoutSec = 120 }) {
  const started = Date.now();
  const proc = spawnSync("node", [
    ADAPTER,
    "--prompt-file", promptFile,
    "--evidence", evidence,
    "--workspace", ws,
    "--timeout", `${timeoutSec}s`,
    ...extra,
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: mode, FAKE_EVIDENCE: join(ws, evidence) },
    // A hang is the bug this file exists to catch, so the harness must outlive
    // the adapter's own deadline rather than the other way round.
    timeout: (timeoutSec + 30) * 1000,
  });
  return {
    exit: proc.status,
    seconds: Math.round((Date.now() - started) / 1000),
    stderr: proc.stderr ?? "",
    json: (() => { try { return JSON.parse(proc.stdout); } catch { return null; } })(),
  };
}

// --- the happy path, and where the log lands -------------------------------
const ok = run({ mode: "ok", evidence: join(RUN_DIR_REL, "ok.md") });
t.check("a finished job exits 0", ok.exit, 0);
t.check("...and its verdict comes off the evidence", ok.json?.status, "done");
t.check("...and the log is under data/, not reports/", ok.json?.stream.includes(join("data", "crew-logs")), "true");
t.check("...so reports/ keeps only the evidence", existsSync(join(ws, RUN_DIR_REL, "ok.md.codex-stream.jsonl")), "false");

// resolveLogDir must hold for both task layouts, since only those two are
// covered by the data/ ignore rule.
t.check("log dir: flat task", resolveLogDir("/w/tasks/t/reports/crew-1/w.md", "/w"), join("/w", "tasks/t/data/crew-logs/crew-1"));
t.check("log dir: work item", resolveLogDir("/w/tasks/p/work-items/c/reports/crew-1/w.md", "/w"), join("/w", "tasks/p/work-items/c/data/crew-logs/crew-1"));

// --- C1: a grandchild holding stdout must not hold the run open ------------
const gc = run({ mode: "grandchild", evidence: join(RUN_DIR_REL, "grandchild.md"), extra: ["--idle-timeout", "60s"] });
t.check("grandchild on stdout: still exits 0", gc.exit, 0);
t.check("grandchild on stdout: settles in the drain window, not 30s", gc.seconds < 10, "true");

// --- C2: an oversized brief to a child that never reads stdin --------------
const epipe = run({ mode: "nodrain", evidence: join(RUN_DIR_REL, "epipe.md"), promptFile: bigBrief });
t.check("200KB brief + no reader: controlled failure, not a crash", epipe.exit, 1);
t.check("...and the crash was not an uncaught EPIPE", epipe.stderr.includes("EPIPE") && epipe.stderr.includes("throw"), "false");

// --- H2: the watchdog keys on stdout events, not stderr noise --------------
const idle = run({ mode: "stderr_only", evidence: join(RUN_DIR_REL, "idle.md"), extra: ["--idle-timeout", "3s"] });
t.check("stderr chatter does not keep a dead job alive", idle.exit, 1);
t.check("...and it is killed at the idle deadline", idle.seconds <= 8, "true");

// --- M1: a retry must not append into the previous attempt's log -----------
const retry = run({ mode: "ok", evidence: join(RUN_DIR_REL, "idle.md"), extra: ["--idle-timeout", "3s"] });
t.check("a leftover sidecar blocks a same-path retry", retry.exit, 1);
t.check("...with a message naming the sidecar", retry.stderr.includes("sidecar from an earlier run"), "true");

// --- C3: the log is a debugging aid; losing it must not fail the job -------
const brokenLogEvidence = join(RUN_DIR_REL, "broken-log.md");
const brokenLogDir = resolveLogDir(join(ws, brokenLogEvidence), ws);
writeFile(join(brokenLogDir, ".keep"), "");
symlinkSync("/nonexistent/dir/x", join(brokenLogDir, "broken-log.codex-stream.jsonl"));
const brokenLog = run({ mode: "ok", evidence: brokenLogEvidence });
t.check("an unwritable log does not fail a finished job", brokenLog.json?.status, "done");
t.check("...and the reason is recorded", String(brokenLog.json?.streamBroken).includes("ENOENT"), "true");

// --- M5: a job that needs a human must not ping as a clean success --------
const blocked = run({ mode: "blocked", evidence: join(RUN_DIR_REL, "blocked.md") });
t.check("BLOCKED exits 3, not 0", blocked.exit, 3);
t.check("...and keeps the cost-gate verdict", blocked.json?.reportedStatus, "BLOCKED");
const noStatus = run({ mode: "no_status", evidence: join(RUN_DIR_REL, "no-status.md") });
t.check("evidence with no Status line also exits 3", noStatus.exit, 3);

// --- the manifest must record a death, which is why this adapter exists ----
const runDirAbs = join(ws, RUN_DIR_REL, "manifest-case");
const { manifestPath } = createRun({ runDir: runDirAbs, runId: "test", task: "t", workspace: ws, depth: 0 });
addJob(manifestPath, { worker: "codex", role: "assist", title: "watchdog", evidence: join(RUN_DIR_REL, "manifest-case", "killed.md") });
run({
  mode: "stderr_only",
  evidence: join(RUN_DIR_REL, "manifest-case", "killed.md"),
  extra: ["--idle-timeout", "3s", "--manifest", manifestPath, "--job", "1"],
});
const job = readManifest(manifestPath).jobs[0];
t.check("a killed job is recorded as failed", job.status, "failed");
t.check("...with a non-empty failure field", Boolean(job.failure), "true");
t.check("...naming the real cause", job.failure.includes("no stdout event"), "true");
t.check("...and the codex version, captured before the run", Boolean(job.codexVersion), "true");

// --- flags: a safety knob must not be silently ignored --------------------
const typo = spawnSync("node", [ADAPTER, "--idle-timout", "1s", "--evidence", "tasks/t/x.md"], { encoding: "utf8" });
t.check("a misspelled flag is refused", typo.status, 1);
t.check("...and the message prints real CLI spellings", typo.stderr.includes("--idle-timeout") && !typo.stderr.includes("--promptFile"), "true");

// --- a retry that works must not inherit the last attempt's failure -------
{
  // Seen live 2026-08-25: a job failed, was retried, succeeded -- and the stale
  // `failure` kept the collect gate flagging the clean result forever. A WARN
  // that fires on every retried job is one people stop reading.
  const retryDir = join(ws, RUN_DIR_REL, "retry-case");
  const { manifestPath: mp } = createRun({ runDir: retryDir, runId: "retry", task: "t", workspace: ws, depth: 0 });
  const ev = join(RUN_DIR_REL, "retry-case", "ok.md");
  addJob(mp, { worker: "codex", role: "assist", title: "retry", evidence: ev });
  run({ mode: "stderr_only", evidence: ev, extra: ["--idle-timeout", "3s", "--manifest", mp, "--job", "1"] });
  t.check("the failed attempt records a failure", Boolean(readManifest(mp).jobs[0].failure), "true");
  const logDir = resolveLogDir(join(ws, ev), ws);

  // The adapter refuses to reuse a log path, so a retry needs the old sidecar
  // moved aside first. That guard is right -- two attempts interleaved into one
  // log destroys the evidence -- but it means "retry once" is not a thing an
  // operator can do without this step, which is why it is asserted here.
  const refused = run({ mode: "ok", evidence: ev, extra: ["--manifest", mp, "--job", "1"] });
  t.check("a retry over a live sidecar is refused", refused.exit, 1);
  t.check("...and the message says what to do", refused.stderr.includes("fresh evidence path"), "true");
  for (const f of readdirSync(logDir)) renameSync(join(logDir, f), join(logDir, `prev-${f}`));

  run({ mode: "ok", evidence: ev, extra: ["--manifest", mp, "--job", "1"] });
  const after = readManifest(mp).jobs[0];
  t.check("the successful retry clears it", after.failure, undefined);
  t.check("...and the job reads as done", after.status, "done");
  t.check("...while the history stays in notes", after.notes.length > 0, "true");
}

// --- the app transport: a real thread in the Codex app, faked ---------------
{
  // The fake exists because these shapes cannot be produced on demand by the
  // real companion, and because a test that opens real threads costs tokens.
  // Every case below is a way the transport could fail without saying so.
  const FAKE = join(FIXTURES, "fake-companion.mjs");

  const runApp = ({ mode, evidence, body = DONE_BODY, extra = [], companion = FAKE, marker = null, timeoutSec = 20, result = null }) => {
    const proc = spawnSync("node", [
      ADAPTER,
      "--mode", "app",
      "--prompt-file", brief,
      "--evidence", evidence,
      "--workspace", ws,
      "--timeout", `${timeoutSec}s`,
      "--effort", "low",
      ...extra,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${FIXTURE_BIN}:${process.env.PATH}`,
        FAKE_MODE: "ok",
        MWG_CODEX_COMPANION: companion,
        FAKE_COMPANION_MODE: mode,
        FAKE_COMPANION_EVIDENCE: join(ws, evidence),
        FAKE_COMPANION_BODY: body,
        ...(result ? { FAKE_COMPANION_RESULT: result } : {}),
        ...(marker ? { FAKE_COMPANION_MARKER: marker } : {}),
      },
      timeout: (timeoutSec + 30) * 1000,
    });
    return {
      exit: proc.status,
      stderr: proc.stderr ?? "",
      json: (() => { try { return JSON.parse(proc.stdout); } catch { return null; } })(),
    };
  };

  const ok = runApp({ mode: "ok", evidence: join(RUN_DIR_REL, "app-ok.md") });
  t.check("an app job exits 0", ok.exit, 0);
  t.check("...judged off the evidence", ok.json?.status, "done");
  t.check("...recorded as the app transport", ok.json?.mode, "app");
  t.check("...with the thread id as provenance", ok.json?.conversationId, "01a037ab-924f-7fe1-b76a-9bfd7e329ded");
  t.check("...and no fake exit code claiming a clean exit", `${ok.json?.exitCode}`, "null");
  t.check("...while the companion job id stays traceable", ok.json?.companionJobId, "task-fake-0001");

  // The gap this transport had next to headless: the job ran, the evidence was
  // judged, and what the worker actually said was thrown away.
  t.check("...the worker's reply is fetched and filed", Boolean(ok.json?.lastMessage), "true");
  t.check("...with text in it", readFileSync(ok.json.lastMessage, "utf8").includes("Đã ghi evidence"), "true");
  t.check("...no reply error on the happy path", `${ok.json?.replyError}`, "null");
  t.check("...the companion's own exit status is recorded", ok.json?.companionExitStatus, 0);
  t.check("...separately from exitCode, which the gate reads", `${ok.json?.exitCode}`, "null");
  t.check("...and the files the runtime says it wrote", ok.json?.touchedFiles?.length, 1);

  // Three ways the reply can be lost. None of them is a failed job: the
  // evidence already decided that, and a thinner record is not a failure.
  for (const [rmode, label] of [["crash", "result exits non-zero"], ["empty", "result is empty"], ["no_result", "result has no stored result"]]) {
    const r = runApp({ mode: "ok", result: rmode, evidence: join(RUN_DIR_REL, `app-reply-${rmode}.md`) });
    t.check(`a job whose ${label} still exits 0`, r.exit, 0);
    t.check(`...${label}: no reply file claimed`, `${r.json?.lastMessage}`, "null");
    t.check(`...${label}: and the reason is on the record`, Boolean(r.json?.replyError), "true");
  }

  // Doctrine: evidence on disk outranks the runtime's verdict, including failed.
  const failed = runApp({ mode: "failed", evidence: join(RUN_DIR_REL, "app-failed.md") });
  t.check("companion says failed but the evidence stands", failed.json?.status, "done");
  t.check("...and the disagreement is surfaced, not resolved", Boolean(failed.json?.runtimeVerdict), "true");
  t.check("...so it exits 3, not 0", failed.exit, 3);

  // A job that outlives its allowance must be cancelled, not left running
  // against a workspace nobody is watching.
  const marker = join(ws, "cancel-marker.txt");
  const mfDir = join(ws, RUN_DIR_REL, "app-timeout-case");
  const { manifestPath: tmp } = createRun({ runDir: mfDir, runId: "app-to", task: "t", workspace: ws, depth: 0 });
  addJob(tmp, {
    worker: "codex", role: "owner", transport: "app", note: "cần resume thread buổi sau",
    title: "app timeout",
    evidence: join(RUN_DIR_REL, "app-timeout-case", "late.md"),
  });
  const timedOut = runApp({
    mode: "timeout", body: "", marker,
    evidence: join(RUN_DIR_REL, "app-timeout-case", "late.md"),
    extra: ["--manifest", tmp, "--job", "1"],
  });
  t.check("a job that never settles fails", timedOut.exit, 1);
  t.check("...and cancel was actually called", readFileSync(marker, "utf8").includes("cancel"), "true");
  const toJob = readManifest(tmp).jobs[0];
  t.check("...with a failure the manifest can show", Boolean(toJob.failure), "true");
  t.check("...naming the transport that stalled", toJob.failure.includes("companion job did not settle"), "true");

  const noId = runApp({ mode: "no_job_id", evidence: join(RUN_DIR_REL, "app-noid.md") });
  t.check("a dispatch with no jobId is refused", noId.exit, 1);
  t.check("...naming the field that is missing", noId.stderr.includes("no jobId"), "true");

  const garbage = runApp({ mode: "not_json", evidence: join(RUN_DIR_REL, "app-garbage.md") });
  t.check("non-JSON output is refused", garbage.exit, 1);
  t.check("...instead of an undefined travelling downstream", garbage.stderr.includes("did not print JSON"), "true");

  const crashed = runApp({ mode: "crash", evidence: join(RUN_DIR_REL, "app-crash.md") });
  t.check("a companion that exits non-zero fails the job", crashed.exit, 1);
  t.check("...quoting its stderr", crashed.stderr.includes("codex is not available"), "true");

  // Falling back to headless here would be the silent substitution this whole
  // harness exists to catch: the manifest would say app, no thread would open.
  const missing = runApp({
    mode: "ok", companion: join(ws, "nope", "codex-companion.mjs"),
    evidence: join(RUN_DIR_REL, "app-missing.md"),
  });
  t.check("a companion that is not there fails loudly", missing.exit, 1);
  t.check("...listing where it looked", missing.stderr.includes("probed:"), "true");
  // The override is authoritative: searching past a path someone named would
  // hand them a different companion than the one they asked for -- and this
  // test proved it, by reaching the real install on the first attempt.
  t.check("...saying the override is the thing to fix", missing.stderr.includes("MWG_CODEX_COMPANION points at nothing"), "true");
  t.check("...and never falling back to headless", missing.json, "null");
}

// --- the manifest and the flag must agree on the transport ------------------
{
  // The manifest is the only record later measurement can read, so a job filed
  // as one transport and fired down the other is worse than no record at all.
  const dir = join(ws, RUN_DIR_REL, "transport-clash");
  const { manifestPath: mp } = createRun({ runDir: dir, runId: "clash", task: "t", workspace: ws, depth: 0 });
  addJob(mp, {
    worker: "codex", role: "owner", transport: "app", note: "việc khám phá, chưa viết nổi acceptance",
    title: "filed as app",
    evidence: join(RUN_DIR_REL, "transport-clash", "w.md"),
  });
  const clash = run({
    mode: "ok", evidence: join(RUN_DIR_REL, "transport-clash", "w.md"),
    extra: ["--manifest", mp, "--job", "1"],
  });
  t.check("dispatching headless against an app job is refused", clash.exit, 1);
  t.check("...naming both sides of the disagreement", clash.stderr.includes('recorded as transport "app"'), "true");
  // Refused before spawning, and the refusal is on the record: a clash left as
  // `pending` would read as a job that never launched, which is the shape the
  // gate treats as lost rather than as something an operator has to fix.
  t.check("...with nothing written at the evidence path", existsSync(join(ws, RUN_DIR_REL, "transport-clash", "w.md")), "false");
  t.check("...and the refusal on the record", readManifest(mp).jobs[0].failure.includes("recorded as transport"), "true");
}

// --- finding the companion, which lives outside this repo -------------------
{
  const { companionCandidates, resolveCompanion } = await import("../scripts/codex-companion-path.mjs");
  const home = join(ws, "home");
  const marketplace = join(home, ".claude", "plugins", "marketplaces", "openai-codex", "plugins", "codex", "scripts", "codex-companion.mjs");

  const order = companionCandidates({ CLAUDE_PLUGIN_ROOT: join(ws, "plug") }, home);
  t.check("the plugin root is probed before the marketplace", order[0], join(ws, "plug", "scripts", "codex-companion.mjs"));
  t.check("...and the marketplace path is the fallback", order[1], marketplace);
  // The cache path carries a version segment, so probing it would mean sorting
  // semver to pick "the newest" -- and the newest copy on disk is not
  // necessarily the one running.
  t.check("the versioned cache path is not probed at all", order.some((x) => x.includes("plugins/cache")), "false");

  writeFile(marketplace, "// stand-in\n");
  t.check("the marketplace install is found", resolveCompanion({}, home), marketplace);

  const explicit = writeFile(join(ws, "elsewhere", "codex-companion.mjs"), "// stand-in\n");
  t.check("an explicit override wins", resolveCompanion({ MWG_CODEX_COMPANION: explicit }, home), explicit);

  let msg = "no throw";
  try { resolveCompanion({ MWG_CODEX_COMPANION: join(ws, "gone.mjs") }, home); } catch (err) { msg = err.message; }
  t.check("an override that points at nothing throws", msg, "MWG_CODEX_COMPANION points at nothing");

  msg = "no throw";
  try { resolveCompanion({}, join(ws, "empty-home")); } catch (err) { msg = `${err.message}|${err.detail}`; }
  t.check("nothing found says so", msg.startsWith("could not find codex-companion.mjs"), "true");
  t.check("...and lists the paths it tried", msg.includes("probed:"), "true");
}

process.exit(t.finish() ? 0 : 1);
