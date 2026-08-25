#!/usr/bin/env node
/**
 * The collect gate, on runs built to fail in one specific way each.
 *
 * The gate's whole value is its exit code, so that is what these cases assert.
 * The synthetic runs cover what the real runs on disk cannot: a duplicated
 * evidence path, a write outside the run's scope, and a job left pending long
 * enough to be dead. Behaviour against real history is checked separately, by
 * running the gate over the runs already in tasks/ and comparing with what is
 * known to have happened.
 *
 * Run: node mwg-agent-crew/tests/collect-gate.test.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRun, addJob, updateJob, readManifest } from "../scripts/crew-manifest.mjs";
import { collectRun, abandonJob } from "../scripts/crew-collect.mjs";
import { MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const CLI = join(MODULE_ROOT, "scripts", "crew-collect.mjs");

/** The CLI, not the library: a flag that silently disables a check is only visible here. */
function runCli(manifestPath, args = [], cwd = undefined) {
  const p = spawnSync("node", [CLI, manifestPath, ...args], { encoding: "utf8", cwd });
  return { exit: p.status, out: p.stdout ?? "", err: p.stderr ?? "" };
}

const t = makeChecker("collect-gate");
const TASK = "t";
const RUN_REL = join("tasks", TASK, "reports", "crew-test");

/**
 * A git repo is required: the scope check reads `git status`. It must be a
 * throwaway repo, never the real one, or a test would report the user's
 * in-flight work as a violation.
 */
function newRun({ jobs, at = Date.now() }) {
  const ws = tmpWorkspace("collect-");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const runDir = join(ws, RUN_REL);
  const { manifestPath } = createRun({ runDir, runId: "test", task: TASK, workspace: ws, depth: 0 });
  const created = new Date(at).toISOString();
  for (const job of jobs) {
    const added = addJob(manifestPath, {
      worker: job.worker ?? "codex",
      title: job.title ?? "job",
      evidence: job.evidence,
      filesMayModify: job.filesMayModify,
    });
    if (job.body !== undefined) writeFile(join(ws, job.evidence), job.body);
    updateJob(manifestPath, added.seq, {
      status: job.status ?? "pending",
      startedAt: job.startedAt === null ? null : (job.startedAt ?? created),
      endedAt: job.endedAt === null ? null : (job.endedAt ?? new Date(at + 60_000).toISOString()),
      ...(job.patch ?? {}),
    });
  }
  return { ws, manifestPath };
}

const DONE = "work\n\nStatus: DONE\nSummary: ok\n";

// --- a clean run is the baseline: the gate must not block for its own sake ---
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE }, { evidence: join(RUN_REL, "w2.md"), body: DONE }],
  });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a clean run exits 0", r.exitCode, 0);
  t.check("...with every job PASS", r.rows.map((x) => x.verdict).join(","), "PASS,PASS");
}

// --- one evidence path for two jobs destroys one job's only proof ----------
{
  const shared = join(RUN_REL, "shared.md");
  const { ws, manifestPath } = newRun({ jobs: [{ evidence: shared, body: DONE }, { evidence: shared }] });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a duplicated evidence path is refused", r.exitCode, 2);
  t.check("...and names both jobs", r.dupes[0]?.seqs.join("+"), "1+2");
}

// --- a write outside the run's scope, during a job's own interval ----------
{
  const { ws, manifestPath } = newRun({ jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE }] });
  writeFile(join(ws, "somewhere-else.md"), "a worker wrote here\n");
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a write outside scope exits 2", r.exitCode, 2);
  t.check("...and is attributed to the job that was running", r.scope.outOfScope[0]?.seqs.join(","), "1");
}

// --- the same write, declared up front, is not a violation ----------------
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE, filesMayModify: ["shared-workspace/"] }],
  });
  writeFile(join(ws, "shared-workspace", "article.html"), "<p>edited</p>");
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a declared write outside tasks/ is allowed", r.exitCode, 0);
  t.check("...and counted in scope", r.scope.inScope.some((x) => x.path.startsWith("shared-workspace/")), "true");
}

// --- a write before any job started belongs to whoever was there first ----
{
  const { ws, manifestPath } = newRun({ jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE }] });
  const stray = writeFile(join(ws, "pre-existing.md"), "the user was editing this\n");
  execFileSync("touch", ["-t", "202608010000", stray]);
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a file changed before the job ran is not charged to it", r.exitCode, 0);
  t.check("...it is reported as outside the window", r.scope.outsideWindow.includes("pre-existing.md"), "true");
}

// --- a job left pending with no evidence is dead, not slow ----------------
{
  const old = Date.now() - 90 * 60_000;
  const { ws, manifestPath } = newRun({
    at: old,
    jobs: [{ evidence: join(RUN_REL, "never.md"), status: "pending", endedAt: null }],
  });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a long-pending job with no evidence is STALE", r.rows[0].verdict, "STALE");
  t.check("...and blocks the report", r.exitCode, 1);

  abandonJob(manifestPath, 1);
  const after = collectRun(manifestPath, { workspace: ws });
  t.check("--abandon clears the block", after.exitCode, 0);
  t.check("...by recording it as cancelled, not as passed", readManifest(manifestPath).jobs[0].status, "cancelled");
}

// --- a young pending job is still running; the gate must not bury it ------
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "soon.md"), status: "pending", endedAt: null }],
  });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a young pending job reads as RUNNING", r.rows[0].verdict, "RUNNING");
  t.check("...and still blocks the report", r.exitCode, 1);
}

// --- a cost gate is a decision waiting, not a failure --------------------
{
  const { ws, manifestPath } = newRun({
    jobs: [{
      evidence: join(RUN_REL, "gated.md"),
      body: "stopped\n\nStatus: BLOCKED\nConcerns/Blockers: cần Ahrefs\n",
      patch: { failure: "BLOCKED / COST_GATE — Ahrefs" },
    }],
  });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a cost gate blocks the report", r.exitCode, 1);
  t.check("...and names the API to ask about", r.costGates[0]?.api, "Ahrefs");
}

// --- evidence with no Status line cannot be judged as a pass -------------
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "nostatus.md"), body: "did work, forgot the contract\n", status: "pending", endedAt: null }],
  });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("evidence without a Status line is NO_STATUS", r.rows[0].verdict, "NO_STATUS");
  t.check("...and blocks the report", r.exitCode, 1);
}

// --- empty evidence is a failure, not an absence ------------------------
{
  const { ws, manifestPath } = newRun({ jobs: [{ evidence: join(RUN_REL, "empty.md"), body: "" }] });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("empty evidence fails", r.rows[0].verdict, "FAIL");
  t.check("...and blocks the report", r.exitCode, 1);
}

// --- the disagreement class: a recorded failure the evidence contradicts --
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE, patch: { runtimeVerdict: "agy reported ERROR" } }],
  });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a runtime that disagreed still passes on evidence", r.rows[0].verdict, "PASS");
  t.check("...but is flagged for a human", r.rows[0].flags.join(","), "WARN");
  t.check("...without blocking the report", r.exitCode, 0);
}

// --- reconcile runs first, so a stale manifest cannot fail a done job ----
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "late.md"), body: DONE, status: "failed", patch: { failure: "timeout" } }],
  });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("evidence outranks a manifest that said failed", r.rows[0].verdict, "PASS");
  t.check("...and the disagreement is shown", r.rows[0].flags.join(","), "WARN");
  t.check("...and the manifest is repaired on disk", readManifest(manifestPath).jobs[0].status, "done");
}

// --- a verdict that already passed must not be rewritten downward -------
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "verified.md"), body: DONE, status: "done_verified_manually" }],
  });
  collectRun(manifestPath, { workspace: ws });
  t.check("done_verified_manually survives reconcile", readManifest(manifestPath).jobs[0].status, "done_verified_manually");
}

// --- a job that never recorded an end has no knowable interval -----------
// Failing hard here made the gate unpassable on exactly the runs it exists for:
// the gate reconciles before it checks, which moves updatedAt to now, so a
// killed job's window reached the present and swallowed the user's own edits.
{
  const { ws, manifestPath } = newRun({
    at: Date.now() - 20 * 60_000,
    jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE, endedAt: null }],
  });
  writeFile(join(ws, "docs", "user-was-editing.md"), "not the worker's doing\n");
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("an unbounded job window does not fail the run", r.exitCode, 0);
  t.check("...the write is reported as suspect instead", r.scope.suspect[0]?.path, "docs/user-was-editing.md");
  t.check("...and is not counted as a violation", r.scope.outOfScope.length, 0);
}

// --- C1: --abandon must not be a way to clear a recorded failure ---------
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "gone.md"), status: "failed", patch: { failure: "worker crashed" } }],
  });
  const before = collectRun(manifestPath, { workspace: ws });
  t.check("a crashed job with no evidence is FAIL", before.rows[0].verdict, "FAIL");
  let refused = "";
  try { abandonJob(manifestPath, 1); } catch (e) { refused = e.message; }
  t.check("--abandon refuses a recorded failure", refused.includes("không phải STALE"), "true");
  t.check("...and the run still blocks", collectRun(manifestPath, { workspace: ws }).exitCode, 1);
}

// --- C2: two declared paths whose basenames collide ---------------------
{
  const { ws, manifestPath } = newRun({
    jobs: [
      { evidence: join(RUN_REL, "report.md"), body: DONE },
      { evidence: join("tasks", TASK, "data", "report.md") },
    ],
  });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a job with no evidence of its own does not pass", r.rows[1].verdict === "PASS", "false");
}

// --- C4: a deletion cannot be attributed, and must not vanish ----------
{
  const { ws, manifestPath } = newRun({ jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE }] });
  const doomed = writeFile(join(ws, "docs", "important.md"), "tracked\n");
  execFileSync("git", ["add", "-A"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: ws });
  rmSync(doomed);
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a deletion is surfaced, not dropped", r.scope.unattributable.includes("docs/important.md"), "true");
}

// --- H1: git cannot see an ignored path, so the walk has to ------------
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE, filesMayModify: ["ignored-area/"] }],
  });
  // Aged out of the job's window: the .gitignore is the test's own setup, not
  // something the worker wrote.
  execFileSync("touch", ["-t", "202608010000", writeFile(join(ws, ".gitignore"), "ignored-area/\n")]);
  writeFile(join(ws, "ignored-area", "article.html"), "<p>the real case</p>");
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a declared gitignored write is seen at all", r.scope.inScope.some((x) => x.path === "ignored-area/article.html"), "true");
  t.check("...and allowed", r.exitCode, 0);
}

// --- H1: a protected file is never a legal write ----------------------
{
  const { ws, manifestPath } = newRun({ jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE }] });
  execFileSync("touch", ["-t", "202608010000", writeFile(join(ws, ".gitignore"), ".codex/\n")]);
  writeFile(join(ws, ".codex", "config.toml"), "clobbered = true\n");
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("writing a protected config blocks", r.exitCode, 2);
  t.check("...and is named", r.scope.protectedHits[0]?.path, ".codex/config.toml");
}

// --- H2/H5: nobody vouched for this evidence -------------------------
{
  const { ws, manifestPath } = newRun({ jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE, worker: "codex" }] });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("evidence with no reportedStatus passes but is flagged", r.rows[0].flags.join(","), "WARN");
  t.check("...naming the reason", r.rows[0].detail.includes("không do runtime giao"), "true");
}
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "w1.md"), body: "did work, no contract line\n", status: "done" }],
  });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a hand-set done cannot stand in for a missing Status line", r.rows[0].verdict, "NO_STATUS");
  t.check("...and blocks", r.exitCode, 1);
}
{
  const { ws, manifestPath } = newRun({
    jobs: [{
      evidence: join(RUN_REL, "w1.md"), body: "did work, no contract line\n",
      status: "done", patch: { reportedStatus: "DONE" },
    }],
  });
  t.check("a runner-set verdict may stand in", collectRun(manifestPath, { workspace: ws }).rows[0].verdict, "PASS");
}

// --- H3: the brief's own template line is not a verdict --------------
{
  const { ws, manifestPath } = newRun({
    jobs: [{
      evidence: join(RUN_REL, "w1.md"),
      body: "Tôi không làm được gì, thiếu quyền.\n\nDòng cuối phải là:\nStatus: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT\n",
    }],
  });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("echoing the brief template is not a pass", r.rows[0].verdict, "NO_STATUS");
  t.check("...and nothing is written to the manifest", readManifest(manifestPath).jobs[0].status, "pending");
}

// --- H4: a declared prefix is a directory, not a string prefix -------
{
  const { ws, manifestPath } = newRun({
    jobs: [
      { evidence: join(RUN_REL, "w1.md"), body: DONE, filesMayModify: ["docs"] },
      { evidence: join(RUN_REL, "w2.md"), body: DONE },
    ],
  });
  writeFile(join(ws, "docs-secret.md"), "sibling, not a member\n");
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a declared prefix does not leak to a sibling path", r.exitCode, 2);
  t.check("...and the sibling is the violation", r.scope.outOfScope[0]?.path, "docs-secret.md");
}

// --- H6: overlapping windows must name every candidate --------------
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE }, { evidence: join(RUN_REL, "w2.md"), body: DONE }],
  });
  writeFile(join(ws, "stray.md"), "which worker wrote this?\n");
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("an overlapping write names both candidates", r.scope.outOfScope[0]?.seqs.join(","), "1,2");
}

// --- M3: the WARN must survive a second collect ---------------------
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE, status: "failed" }],
  });
  const first = collectRun(manifestPath, { workspace: ws });
  const second = collectRun(manifestPath, { workspace: ws });
  t.check("first collect flags the disagreement", first.rows[0].flags.join(","), "WARN");
  t.check("second collect still flags it", second.rows[0].flags.join(","), "WARN");
}

// --- M5: a cost gate the runtime never noticed ----------------------
{
  const { ws, manifestPath } = newRun({
    jobs: [{
      evidence: join(RUN_REL, "w1.md"),
      body: "dừng lại\n\nStatus: BLOCKED\nConcerns/Blockers: COST_GATE — DataForSEO\n",
    }],
  });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a cost gate written only in the evidence is still found", r.costGates[0]?.api, "DataForSEO");
}

// --- CLI: an input that could turn a check off must be refused ------
{
  const { ws, manifestPath } = newRun({ jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE }] });
  writeFile(join(ws, "stray.md"), "outside scope\n");
  t.check("a real violation exits 2 via the CLI", runCli(manifestPath).exit, 2);
  const bad = runCli(manifestPath, ["--grace", "abc"]);
  t.check("--grace with a non-number is refused, not coerced", bad.exit, 2);
  t.check("...and says why", bad.err.includes("--grace"), "true");
  t.check("--grace with no value is refused", runCli(manifestPath, ["--grace"]).exit, 2);
  t.check("a flag value is not read as the manifest path", runCli(manifestPath, ["--grace", "5000"]).exit, 2);
  t.check("...for the right reason", runCli(manifestPath, ["--grace", "5000"]).out.includes("SCOPE_VIOLATION"), "true");
}

// --- H7: the verdict must not depend on where the command was run ---
{
  const { ws, manifestPath } = newRun({ jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE }] });
  const home = runCli(manifestPath, [], ws);
  const away = runCli(manifestPath, [], "/tmp");
  t.check("same verdict from the workspace and from elsewhere", `${home.exit}`, `${away.exit}`);
  t.check("...and it is a pass", home.exit, 0);
}

// --- M1: the safety flag must cover the mutating flag ---------------
{
  const old = Date.now() - 90 * 60_000;
  const { manifestPath } = newRun({
    at: old,
    jobs: [{ evidence: join(RUN_REL, "never.md"), status: "pending", endedAt: null }],
  });
  runCli(manifestPath, ["--abandon", "1", "--dry-run"]);
  t.check("--dry-run covers --abandon", readManifest(manifestPath).jobs[0].status, "pending");
  runCli(manifestPath, ["--abandon", "1"]);
  t.check("...and without it the job is abandoned", readManifest(manifestPath).jobs[0].status, "cancelled");
}

// --- G1: provenance is only asked of a manifest that could have answered ---
{
  // A run from before the adapters recorded who delivered a job. The WARN fired
  // on every one of these, and a warning that is always on is not a warning.
  const { ws, manifestPath } = newRun({ jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE }] });
  const m = readManifest(manifestPath);
  writeFile(manifestPath, JSON.stringify({ ...m, version: 1 }, null, 2));
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a version-1 run passes without a provenance WARN", r.rows[0].flags.length, 0);
}
{
  const { ws, manifestPath } = newRun({ jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE }] });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("a version-2 job with no exitCode still warns", r.rows[0].flags.join(","), "WARN");
  t.check("...while passing", r.rows[0].verdict, "PASS");
}
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE, patch: { exitCode: 0 } }],
  });
  t.check("a job the runtime vouched for does not warn",
    collectRun(manifestPath, { workspace: ws }).rows[0].flags.length, 0);
}

// --- G1: bumping the version must not orphan the runs already on disk ---
{
  const { manifestPath } = newRun({ jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE }] });
  const m = readManifest(manifestPath);
  writeFile(manifestPath, JSON.stringify({ ...m, version: 1 }, null, 2));
  let readable = "true";
  try { readManifest(manifestPath); } catch { readable = "false"; }
  t.check("an older manifest stays readable", readable, "true");

  writeFile(manifestPath, JSON.stringify({ ...m, version: 99 }, null, 2));
  let refused = "false";
  try { readManifest(manifestPath); } catch { refused = "true"; }
  t.check("a manifest from a newer script is refused", refused, "true");
}

// --- G2: how long silence is allowed comes from the job, not a constant ---
{
  const at = Date.now() - 30 * 60_000;
  const { ws, manifestPath } = newRun({
    at,
    jobs: [{ evidence: join(RUN_REL, "slow.md"), status: "running", endedAt: null, patch: { timeoutMs: 25 * 60_000 } }],
  });
  t.check("a 25m job silent for 30m is still running",
    collectRun(manifestPath, { workspace: ws }).rows[0].verdict, "RUNNING");
}
{
  const at = Date.now() - 30 * 60_000;
  const { ws, manifestPath } = newRun({
    at,
    jobs: [{ evidence: join(RUN_REL, "quick.md"), status: "running", endedAt: null, patch: { timeoutMs: 5 * 60_000 } }],
  });
  t.check("a 5m job silent for 30m is dead", collectRun(manifestPath, { workspace: ws }).rows[0].verdict, "STALE");
}
{
  // No timeoutMs: an old manifest must behave exactly as it did before.
  const { ws, manifestPath } = newRun({
    at: Date.now() - 30 * 60_000,
    jobs: [{ evidence: join(RUN_REL, "old.md"), status: "pending", endedAt: null }],
  });
  t.check("without timeoutMs the old 35m allowance applies",
    collectRun(manifestPath, { workspace: ws }).rows[0].verdict, "RUNNING");
  const later = newRun({
    at: Date.now() - 40 * 60_000,
    jobs: [{ evidence: join(RUN_REL, "old.md"), status: "pending", endedAt: null }],
  });
  t.check("...and past it the job is dead",
    collectRun(later.manifestPath, { workspace: later.ws }).rows[0].verdict, "STALE");
}
{
  // `running` is what the adapter writes before it spawns. Reading it as a
  // recorded outcome would have failed every job that was still working.
  const { ws, manifestPath } = newRun({
    at: Date.now() - 60_000,
    jobs: [{ evidence: join(RUN_REL, "live.md"), status: "running", endedAt: null }],
  });
  t.check("a job the adapter marked running is not a failure",
    collectRun(manifestPath, { workspace: ws }).rows[0].verdict, "RUNNING");
}

// --- G3: two problems must not read as one ---------------------------
{
  const { ws, manifestPath } = newRun({
    jobs: [
      { evidence: join(RUN_REL, "w1.md"), body: DONE },
      { evidence: join(RUN_REL, "w2.md"), body: "hỏng\n\nStatus: BLOCKED\n" },
    ],
  });
  writeFile(join(ws, "stray.md"), "outside scope\n");
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("an unresolved job plus a scope violation exits 3", r.exitCode, 3);
  t.check("...and the CLI says so", runCli(manifestPath).out.includes("CẢ HAI"), "true");
}
{
  const { ws, manifestPath } = newRun({ jobs: [{ evidence: join(RUN_REL, "w1.md"), body: DONE }] });
  writeFile(join(ws, "stray.md"), "outside scope\n");
  t.check("a scope violation alone still exits 2", collectRun(manifestPath, { workspace: ws }).exitCode, 2);
}
{
  const { ws, manifestPath } = newRun({
    jobs: [{ evidence: join(RUN_REL, "w1.md"), body: "hỏng\n\nStatus: BLOCKED\n" }],
  });
  t.check("an unresolved job alone still exits 1", collectRun(manifestPath, { workspace: ws }).exitCode, 1);
}

// --- a job whose adapter died after the work landed is the ordinary repair ---
{
  // `running` is bookkeeping, so reconcile patching over it must not be
  // reported as the runtime contradicting the evidence.
  const { ws, manifestPath } = newRun({
    jobs: [{
      evidence: join(RUN_REL, "w1.md"), body: DONE, status: "running", endedAt: null,
      patch: { conversationId: "c1" },
    }],
  });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("reconcile from running to done is a clean pass", r.rows[0].verdict, "PASS");
  t.check("...with no invented disagreement", r.rows[0].flags.length, 0);
}

process.exit(t.finish() ? 0 : 1);
