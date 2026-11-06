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
 * Run: node plugins/agent-crew/tests/codex-lifecycle.test.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, renameSync, mkdirSync } from "node:fs";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createRun, addJob, claimRunSlot, readManifest } from "../scripts/crew-manifest.mjs";
import { resolveLogDir } from "../scripts/codex-run.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, seedLegacyJob, tmpWorkspace, writeFile } from "./helpers.mjs";
import { collectRun } from "../scripts/crew-collect.mjs";
import { DEFAULT_LAYOUT, LEGACY_LAYOUT } from "../scripts/lib/crew-layout.mjs";

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
function run({ mode, evidence, promptFile = brief, extra = [], timeoutSec = 120, env = {} }) {
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
    env: { ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: mode, FAKE_EVIDENCE: join(ws, evidence), ...env },
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
t.check("log dir: flat task", resolveLogDir("/w/tasks/t/reports/crew-1/w.md", "/w", LEGACY_LAYOUT), join("/w", "tasks/t/data/crew-logs/crew-1"));
t.check("log dir: work item", resolveLogDir("/w/tasks/p/work-items/c/reports/crew-1/w.md", "/w", LEGACY_LAYOUT), join("/w", "tasks/p/work-items/c/data/crew-logs/crew-1"));
t.check("log dir: layout mặc định", resolveLogDir("/w/.crew/runs/1/w.md", "/w", DEFAULT_LAYOUT), join("/w", ".crew/logs/1"));

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

// --- Codex is headless only: the entry refuses the app transport -----------
{
  // Refused at the top of the entry, not inside the manifest branch: a check
  // that only fired with --manifest would leave the adapter run by hand as a
  // way back to the transport.
  const bare = run({ mode: "ok", evidence: join(RUN_DIR_REL, "app-by-hand.md"), extra: ["--mode", "app"] });
  t.check("--mode app with no manifest is refused", bare.exit, 1);
  t.check("...pointing at headless --resume", bare.stderr.includes("--resume <conversationId>"), "true");
  t.check("...and nothing ran", existsSync(join(ws, RUN_DIR_REL, "app-by-hand.md")), "false");

  // A run from before 2.0.4 can still hold a pending Codex app job. Dispatching
  // it fails, on the record, with the way to redo it -- not silently as headless.
  const dir = join(ws, RUN_DIR_REL, "legacy-app-pending");
  const { manifestPath: mp } = createRun({ runDir: dir, runId: "legacy-app", task: "t", workspace: ws, depth: 0 });
  seedLegacyJob(mp, {
    worker: "codex", role: "owner", transport: "app", note: "cần resume thread buổi sau",
    title: "legacy app", evidence: join(RUN_DIR_REL, "legacy-app-pending", "w.md"),
  });
  const legacy = run({
    mode: "ok", evidence: join(RUN_DIR_REL, "legacy-app-pending", "w.md"),
    extra: ["--mode", "app", "--manifest", mp, "--job", "1"],
  });
  const job = readManifest(mp).jobs[0];
  t.check("a legacy pending codex app job is refused at dispatch", legacy.exit, 1);
  t.check("...recorded as failed", job.status, "failed");
  t.check("...with the headless way to redo it", job.failure.includes("Codex chỉ chạy headless"), "true");
  t.check("...and the record it came from left as it was", job.transport, "app");
  t.check("...with nothing written at the evidence path", existsSync(join(ws, RUN_DIR_REL, "legacy-app-pending", "w.md")), "false");
}

// --- soft deadline and the handoff rescue -----------------------------------
{
  // A long job used to end one way at its ceiling: killed, evidence half-written,
  // thread abandoned. Now the brief names a soft deadline, and a job that still
  // hits the hard one gets one short turn on the same thread to write a handoff.
  const brief20 = run({ mode: "briefdump", evidence: join(RUN_DIR_REL, "soft-20m.md"), timeoutSec: 1200 });
  const body20 = readFileSync(join(ws, RUN_DIR_REL, "soft-20m.md"), "utf8");
  t.check("a 20m job's brief carries the soft deadline", brief20.exit === 0 && /Hạn mềm \d\d:\d\d/.test(body20), true);
  t.check("...and the four handoff sections", body20.includes("`### Đang dở`") && body20.includes("Status: CONTINUE"), true);
  run({ mode: "briefdump", evidence: join(RUN_DIR_REL, "soft-5m.md"), timeoutSec: 300 });
  t.check("a 5m job's brief has no soft deadline", readFileSync(join(ws, RUN_DIR_REL, "soft-5m.md"), "utf8").includes("Hạn mềm"), false);

  const hang = (name, mode, { idle = "3s", timeoutSec = 4 } = {}) => {
    const dir = join(ws, RUN_DIR_REL, `rescue-${name}`);
    const { manifestPath: mp } = createRun({ runDir: dir, runId: `rescue-${name}`, task: "t", workspace: ws, depth: 0 });
    // One basename per case: the log dir is shared by the run folder, and a
    // reused name is refused as an earlier run's sidecar before anything runs.
    const ev = join(RUN_DIR_REL, `rescue-${name}`, `rescue-${name}.md`);
    addJob(mp, { worker: "codex", role: "owner", title: name, evidence: ev });
    const mark = join(ws, `rescue-${name}.mark`);
    const r = run({ mode, evidence: ev, timeoutSec, extra: ["--idle-timeout", idle, "--manifest", mp, "--job", "1"], env: { FAKE_RESCUE_MARK: mark } });
    const calls = existsSync(mark) ? readFileSync(mark, "utf8").trim().split("\n").filter(Boolean) : [];
    const evAbs = join(ws, ev);
    return { r, job: readManifest(mp).jobs[0], calls, evidence: existsSync(evAbs) ? readFileSync(evAbs, "utf8") : null };
  };

  // Brief quá trần mềm 2 KB: job vẫn chạy, sổ ghi cỡ brief + note, collect gắn cờ.
  {
    const dir = join(ws, RUN_DIR_REL, "long-brief");
    const { manifestPath: mp } = createRun({ runDir: dir, runId: "long-brief", task: "t", workspace: ws, depth: 0 });
    const ev = join(RUN_DIR_REL, "long-brief", "long-brief.md");
    addJob(mp, { worker: "codex", role: "owner", title: "brief dài", evidence: ev });
    const longBrief = writeFile(join(ws, "long-brief.md"), `làm việc X\n${"bối cảnh ".repeat(400)}\n`);
    const r = run({ mode: "ok", evidence: ev, promptFile: longBrief, extra: ["--manifest", mp, "--job", "1"] });
    const job = readManifest(mp).jobs[0];
    t.check("brief ~4 KB (quá trần mềm) vẫn chạy, exit 0", r.exit, 0);
    t.check("...sổ ghi briefBytes", job.briefBytes > 2048 && job.briefBytes < 8192, true);
    t.check("...kèm note nhắc tách bối cảnh", (job.notes ?? []).some((n) => n.includes("quá trần mềm")), true);
    t.check("...stderr báo ngay lúc bắn", r.stderr.includes("quá trần mềm"), true);
    const row = collectRun(mp, { workspace: ws, dryRun: true }).rows[0];
    t.check("collect: PASS + cờ BRIEF DÀI, không phải WARN", `${row.verdict}|${row.flags.includes("BRIEF DÀI")}|${row.flags.includes("WARN")}`, "PASS|true|false");
  }

  const ok = hang("ok", "hang_handoff");
  t.check("hard timeout → rescue → job is continue", ok.r.json?.status, "continue");
  t.check("...exit 3: someone has to resume it", ok.r.exit, 3);
  t.check("...rescue ran exactly once, on the same thread", ok.calls.length === 1 && ok.calls[0].includes("resume 01a04169-2763-79d1-9037-6dc85981fad1"), true);
  t.check("...and was handed the rescue prompt, not the brief", ok.calls[0].includes("exec"), true);
  t.check("...the manifest records continue and the rescue", `${ok.job.status}|${ok.job.handoffRescue?.ran}|${ok.job.handoffRescue?.ok}`, "continue|true|true");
  t.check("...usage comes from the rescue turn, the killed turn never completed", ok.job.usage?.input_tokens, 4242);
  t.check("...the evidence keeps the first part and adds the handoff", ok.evidence.startsWith("phần đầu") && ok.evidence.includes("## Handoff"), true);
  t.check("...the kill stays on the record", /exceeded/.test(ok.job.killedFor ?? ok.r.json?.killedFor ?? ""), true);
  t.check("...without a runtime disagreement (the timeout is what CONTINUE means)", Boolean(ok.job.runtimeVerdict), false);

  const stuck = hang("stuck", "hang_rescue_hang");
  t.check("a rescue that times out itself → failed", `${stuck.r.exit}|${stuck.job.status}`, "1|failed");
  t.check("...rescue tried once, recorded as not ok", `${stuck.calls.length}|${stuck.job.handoffRescue?.ok}`, "1|false");
  t.check("...the job was resolved once (one failure line)", stuck.r.stderr.split("\n").filter((l) => l.startsWith("codex-run: the ")).length, 1);

  const bare = hang("bare", "hang_rescue_nostatus");
  t.check("a rescue that writes no Status → failed as before", `${bare.r.exit}|${bare.job.status}|${bare.calls.length}`, "1|failed|1");

  const idle = hang("idle", "hang_silent", { idle: "2s", timeoutSec: 30 });
  t.check("an idle kill gets no rescue", idle.calls.length, 0);
  t.check("...and fails as before, killed for silence", `${idle.job.status}|${/no stdout event/.test(idle.job.failure ?? "")}`, "failed|true");
  t.check("...with no rescue on the record", `${idle.job.handoffRescue}`, "undefined");
}

// --- the manifest and the flag must agree on the transport ------------------
{
  // The manifest is the only record later measurement can read, so a job filed
  // as one transport and fired down the other is worse than no record at all.
  const dir = join(ws, RUN_DIR_REL, "transport-clash");
  const { manifestPath: mp } = createRun({ runDir: dir, runId: "clash", task: "t", workspace: ws, depth: 0 });
  // Seeded as a legacy record: `addJob` no longer files Codex as app, but a run
  // from before that still can, and the clash check has to keep reading it.
  seedLegacyJob(mp, {
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

// --- a refused second dispatch must not erase the first one's claim ---------
{
  // Found by a crew job on 26/08, the day the parallel cap landed. The direct
  // test of claimRunSlot proved it refuses a second claim -- and stopped there.
  // What it could not see is what the ADAPTER does with that refusal: the catch
  // path recorded the job as `failed`, wiping the first invocation's `running`
  // state and handing its parallel slot to whoever asked next, while the first
  // job was still working. The refusal has to survive the refuser.
  const dir = join(ws, RUN_DIR_REL, "double-dispatch");
  const { manifestPath: mp } = createRun({ runDir: dir, runId: "dd", task: "t", workspace: ws, depth: 0 });
  addJob(mp, {
    worker: "codex", role: "assist", transport: "headless", title: "already mine",
    evidence: join(RUN_DIR_REL, "double-dispatch", "w.md"),
  });
  claimRunSlot(mp, 1, { startedAt: new Date().toISOString(), timeoutMs: 900_000 });

  const second = run({
    mode: "ok", evidence: join(RUN_DIR_REL, "double-dispatch", "w2.md"),
    extra: ["--manifest", mp, "--job", "1"],
  });
  t.check("a second dispatch of a running job is refused", second.exit, 1);
  t.check("...saying it is already running", second.stderr.includes("already recorded as running"), "true");
  t.check("...and the first claim still stands", readManifest(mp).jobs[0].status, "running");
  t.check("...with no failure written over it", readManifest(mp).jobs[0].failure ?? null, null);
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
  t.check("the general name is read too", resolveCompanion({ CREW_CODEX_COMPANION: explicit }, home), explicit);
  t.check("...and wins over the old name", resolveCompanion({ CREW_CODEX_COMPANION: explicit, MWG_CODEX_COMPANION: join(ws, "gone.mjs") }, home), explicit);

  let msg = "no throw";
  try { resolveCompanion({ MWG_CODEX_COMPANION: join(ws, "gone.mjs") }, home); } catch (err) { msg = err.message; }
  t.check("an override that points at nothing throws", msg, "MWG_CODEX_COMPANION points at nothing");

  msg = "no throw";
  try { resolveCompanion({}, join(ws, "empty-home")); } catch (err) { msg = `${err.message}|${err.detail}`; }
  t.check("nothing found says so", msg.startsWith("could not find codex-companion.mjs"), "true");
  t.check("...and lists the paths it tried", msg.includes("probed:"), "true");
}

// --- the credential store, through the real adapter ------------------------
// The unit tests fingerprint files and the gate tests patch a manifest by
// hand; neither one proves the adapter actually writes the finding. This runs
// the real adapter against a worker that deletes a store file, which is the
// 18/09 shape. Deterministic on purpose: a live Codex run proved this on
// 22/09 and then the runtime started crashing on an unrelated MCP auth error,
// which is exactly the kind of flake a closing criterion must not depend on.
{
  const storeDir = join(ws, "cred-store");
  mkdirSync(storeDir, { recursive: true });
  writeFile(join(storeDir, "credentials.enc"), "encrypted");
  writeFile(join(storeDir, "client_secret.json"), "{}");

  const credDir = join(ws, RUN_DIR_REL, "cred-case");
  mkdirSync(credDir, { recursive: true });
  const { manifestPath: mp } = createRun({ runDir: credDir, runId: "cred", task: "t", workspace: ws, depth: 0 });
  const ev = join(RUN_DIR_REL, "cred-case", "w1.md");
  addJob(mp, { worker: "codex", role: "assist", title: "tamper", evidence: ev });

  const r = run({
    mode: "tamper",
    evidence: ev,
    extra: ["--manifest", mp, "--job", "1"],
    env: { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: storeDir },
  });
  const j = readManifest(mp).jobs[0];
  t.check("the worker's own job still reads done", r.exit, 0);
  t.check("the adapter recorded the tampering", j.credentialTamper?.[0]?.file, "credentials.enc");
  t.check("...as a deletion", j.credentialTamper?.[0]?.change, "deleted");
  t.check("...naming the directory it watched", j.credentialTamper?.[0]?.dir, storeDir);
  t.check("...and carrying no digest", /[0-9a-f]{64}/.test(JSON.stringify(j.credentialTamper)), false);
  // Thiếu dòng này ở main thì cổng "evidence đổi sau khi xong" tắt im lặng với Codex.
  t.check("codex-run ghi sha bản evidence đã chấm", j.evidenceSha256, createHash("sha256").update(readFileSync(join(ws, ev))).digest("hex"));
}

{
  // The case the --sandbox-mode grant exists for, and the one that decides
  // whether granting it is defensible at all.
  //
  // Until 22/09 two things stopped a worker destroying the credential store:
  // the Seatbelt sandbox, and the hash guard. Opening the sandbox on purpose
  // removes the first. If the second turned out to depend on it -- if it were
  // only ever exercised on the sandboxed path -- the grant would silently ship
  // with no protection left, which is exactly the 18/09 outcome. So the guard
  // is proven here at the raised permission level, not assumed to carry over.
  const storeDir = join(ws, "cred-store-full");
  mkdirSync(storeDir, { recursive: true });
  writeFile(join(storeDir, "credentials.enc"), "encrypted");
  writeFile(join(storeDir, "client_secret.json"), "{}");

  const fullDir = join(ws, RUN_DIR_REL, "cred-full");
  mkdirSync(fullDir, { recursive: true });
  const { manifestPath: mp } = createRun({ runDir: fullDir, runId: "credfull", task: "t", workspace: ws, depth: 0 });
  // Basename, not directory, is what names the sidecar log -- a second w1.md
  // under a different folder collides with the case above.
  const ev = join(RUN_DIR_REL, "cred-full", "w-full.md");
  addJob(mp, { worker: "codex", role: "assist", title: "tamper unsandboxed", evidence: ev });

  const r = run({
    mode: "tamper",
    evidence: ev,
    extra: ["--manifest", mp, "--job", "1", "--sandbox-mode", "danger-full-access"],
    env: { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: storeDir },
  });
  const j = readManifest(mp).jobs[0];
  t.check("an unsandboxed job that deletes a store file still reports done", r.exit, 0);
  t.check("...and the guard still catches it", j.credentialTamper?.[0]?.change, "deleted");
  t.check("...recording the permission it ran at", j.sandboxMode, "danger-full-access");

  // The end of the chain: a finding nobody acts on is not a guard. This is the
  // phase's closing criterion, so it is asserted through the real CLI exit code
  // rather than by reading the manifest and trusting collect to agree.
  // The gate reads the git working tree for its write-scope check and dies
  // early without one -- which would have exited 2 for the wrong reason and
  // let this assertion pass on a run that never reached the credential logic.
  if (!existsSync(join(ws, ".git"))) execFileSync("git", ["init", "-q"], { cwd: ws });
  const gate = spawnSync("node",
    [join(MODULE_ROOT, "scripts", "crew-collect.mjs"), mp], { encoding: "utf8", cwd: ws });
  t.check("...and the gate turns red", gate.status, 2);
  t.check("...naming the credential store, not just 'a violation'", /KHO CREDENTIAL/.test(`${gate.stdout}${gate.stderr}`), true);
}

{
  // The other half of the criterion: a job that touches nothing must leave the
  // field absent. An alarm that fires on the healthy path gets muted.
  const storeDir = join(ws, "cred-store-clean");
  mkdirSync(storeDir, { recursive: true });
  writeFile(join(storeDir, "credentials.enc"), "encrypted");
  writeFile(join(storeDir, "client_secret.json"), "{}");

  const cleanDir = join(ws, RUN_DIR_REL, "cred-clean");
  mkdirSync(cleanDir, { recursive: true });
  const { manifestPath: mp } = createRun({ runDir: cleanDir, runId: "credclean", task: "t", workspace: ws, depth: 0 });
  const ev = join(RUN_DIR_REL, "cred-clean", "w1.md");
  addJob(mp, { worker: "codex", role: "assist", title: "clean", evidence: ev });

  run({ mode: "ok", evidence: ev, extra: ["--manifest", mp, "--job", "1"], env: { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: storeDir } });
  const j = readManifest(mp).jobs[0];
  t.check("a clean job records no credential finding", j.credentialTamper, undefined);
  t.check("...and is not marked blind either", j.credentialWatch, undefined);
}

process.exit(t.finish() ? 0 : 1);
