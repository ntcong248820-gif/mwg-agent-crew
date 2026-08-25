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
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("codex-lifecycle");
const ADAPTER = join(MODULE_ROOT, "scripts", "codex-run.mjs");
const RUN_DIR_REL = join("tasks", "t", "reports", "crew-test");

const ws = tmpWorkspace("lifecycle-");
const brief = writeFile(join(ws, "brief.md"), "do the thing\n");
// Larger than the pipe buffer, which is what turns a child that never reads
// stdin into an EPIPE instead of a harmless short write.
const bigBrief = writeFile(join(ws, "big-brief.md"), "x".repeat(200_000));

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
addJob(manifestPath, { worker: "codex", title: "watchdog", evidence: join(RUN_DIR_REL, "manifest-case", "killed.md") });
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
  addJob(mp, { worker: "codex", title: "retry", evidence: ev });
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

process.exit(t.finish() ? 0 : 1);
