/**
 * The manifest's own guards.
 *
 * Split from the gate tests because these are not about verdicts: they are
 * about whether the book the gate reads can be made to lie. Every case here
 * came out of the 25/08 review of `crew-manifest.mjs`, where each guard turned
 * out to protect the field next to the one that mattered.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createRun, addJob, updateJob, updateManifest, readManifest, writeManifest, MAX_DEPTH,
} from "../scripts/crew-manifest.mjs";
import { parseDuration } from "../scripts/crew-guards.mjs";
import { makeChecker, tmpWorkspace, MODULE_ROOT } from "./helpers.mjs";

const t = makeChecker("manifest-guards");
const EV = join("tasks", "t", "reports", "crew-x", "w1.md");

function freshRun(extra = {}) {
  const ws = tmpWorkspace("mf-guards-");
  const runDir = join(ws, "tasks", "t", "reports", "crew-x");
  const { manifestPath } = createRun({ runDir, runId: "x", task: "t", workspace: ws, depth: 0, ...extra });
  return { ws, manifestPath };
}

const threw = (fn) => { try { fn(); return null; } catch (err) { return err.message; } };

// --- the recursion guard does not care how deep you asked to start -----------
{
  // Gating the worker check on `depth === 0` left the hole it existed to close:
  // a worker asking for depth 1 passed both halves of the guard and got a run
  // it could dispatch from. Run in a child process so the env var is real.
  const ws = tmpWorkspace("mf-depth-");
  const probe = (depth) => spawnSync(process.execPath, ["-e", `
    import("${join(MODULE_ROOT, "scripts", "crew-manifest.mjs")}").then((m) => {
      try {
        m.createRun({ runDir: "${join(ws, `d${depth}`)}", runId: "x", task: "t", workspace: "${ws}", depth: ${depth} });
        console.log("CREATED");
      } catch (err) { console.log("REFUSED:" + err.message.split("\\n")[0]); }
    });
  `], { encoding: "utf8", env: { ...process.env, MWG_CREW_ROLE: "worker" } });

  t.check("a worker cannot open a run at depth 0", /REFUSED/.test(probe(0).stdout), true);
  t.check("a worker cannot open one at depth 1 either", /REFUSED/.test(probe(1).stdout), true);
  t.check("...and the refusal names the depth it was asked for", /depth 1/.test(probe(1).stdout), true);
  t.check("MAX_DEPTH is unchanged by this", MAX_DEPTH, 1);
}

// --- evidence has to live where the gate can see it -------------------------
{
  const { ws, manifestPath } = freshRun();
  const base = { worker: "codex", role: "assist", transport: "headless", title: "x" };

  // The doctrine is "only a file under tasks/ can grant a pass". Without this,
  // a job could point at /tmp/old-pass.md -- which the write-scope gate never
  // looks at -- and have its `Status: DONE` line read as proof.
  t.check("an absolute evidence path is refused",
    /absolute/.test(threw(() => addJob(manifestPath, { ...base, evidence: "/tmp/old-pass.md" })) ?? ""), true);
  t.check("a path climbing out of the workspace is refused",
    /inside the workspace/.test(threw(() => addJob(manifestPath, { ...base, evidence: "../../elsewhere.md" })) ?? ""), true);
  t.check("a path outside tasks/ is refused",
    /under tasks\//.test(threw(() => addJob(manifestPath, { ...base, evidence: "docs/note.md" })) ?? ""), true);
  t.check("an empty evidence path is refused",
    /non-empty/.test(threw(() => addJob(manifestPath, { ...base, evidence: "" })) ?? ""), true);
  t.check("a path under tasks/ is accepted", addJob(manifestPath, { ...base, evidence: EV }).seq, 1);
  t.check("...and nothing landed outside the workspace", existsSync(join(ws, "..", "elsewhere.md")), false);
}

// --- extra carries facts, it does not edit checked ones ---------------------
{
  const { manifestPath } = freshRun();
  const base = { worker: "codex", role: "assist", transport: "headless", title: "x", evidence: EV };

  // `extra` spread last, so it could null a transport that had just been
  // validated -- and assertTransport skips a null, so the adapter stopped
  // checking too. Validating a field and then letting the same call overwrite it
  // is not a guard.
  for (const field of ["transport", "role", "seq", "evidence", "worker", "status", "filesMayModify"]) {
    const msg = threw(() => addJob(manifestPath, { ...base, extra: { [field]: null } })) ?? "";
    t.check(`extra cannot overwrite ${field}`, /không được ghi đè/.test(msg), true);
  }
  const ok = addJob(manifestPath, { ...base, extra: { measuredCost: "0.5s" } });
  t.check("extra can still carry a field of its own", ok.measuredCost, "0.5s");
  t.check("...without disturbing the checked transport", ok.transport, "headless");
}

// --- filesMayModify has to be a list of strings -----------------------------
{
  const { manifestPath } = freshRun();
  const base = { worker: "codex", role: "assist", transport: "headless", title: "x", evidence: EV };
  // A string reaches `.map` in the scope gate and throws mid-collect, so a bad
  // declaration used to take the gate down with it.
  t.check("a string is refused",
    /must be an array/.test(threw(() => addJob(manifestPath, { ...base, filesMayModify: "docs" })) ?? ""), true);
  t.check("a list with a non-string is refused",
    /all be strings/.test(threw(() => addJob(manifestPath, { ...base, filesMayModify: ["docs", 3] })) ?? ""), true);
  t.check("a proper list is accepted",
    addJob(manifestPath, { ...base, filesMayModify: ["docs/"] }).filesMayModify.length, 1);
}

// --- updateJob patches progress, never identity -----------------------------
{
  const { manifestPath } = freshRun();
  addJob(manifestPath, { worker: "codex", role: "assist", transport: "headless", title: "x", evidence: EV });

  // Two jobs sharing a seq makes `jobs.find` pick the wrong one; a nulled
  // transport disarms assertTransport; a rewritten evidence path re-points the
  // proof after the fact.
  for (const [field, value] of [["seq", 2], ["transport", null], ["evidence", "tasks/t/other.md"], ["worker", "antigravity"], ["role", "owner"]]) {
    const msg = threw(() => updateJob(manifestPath, 1, { [field]: value })) ?? "";
    t.check(`updateJob cannot change ${field}`, /không được đổi/.test(msg), true);
  }
  // Patching a field to the value it already holds is not a change, so an
  // adapter re-asserting what it knows is not punished for it.
  t.check("re-writing the same transport is allowed",
    updateJob(manifestPath, 1, { transport: "headless", status: "running" }).status, "running");
  t.check("progress fields still patch", updateJob(manifestPath, 1, { exitCode: 0 }).exitCode, 0);
}

// --- a version below 1 is malformed, not ancient ----------------------------
{
  const { manifestPath } = freshRun();
  const m = readManifest(manifestPath);
  // Version 0 used to read as history, which silenced the provenance warning
  // that only fires from version 2 up: a hand-edited 0 bought quieter output.
  writeManifest(manifestPath, { ...m, version: 0 });
  t.check("version 0 is refused", /not a real version/.test(threw(() => readManifest(manifestPath)) ?? ""), true);
  writeManifest(manifestPath, { ...m, version: -3 });
  t.check("a negative version is refused", /not a real version/.test(threw(() => readManifest(manifestPath)) ?? ""), true);
  writeManifest(manifestPath, { ...m, version: 99 });
  t.check("a newer version is still refused", /newer than this script/.test(threw(() => readManifest(manifestPath)) ?? ""), true);
  writeManifest(manifestPath, { ...m, version: 1 });
  t.check("an older real version still reads", readManifest(manifestPath).version, 1);
}

// --- losing the lock means losing the right to write ------------------------
{
  const { manifestPath } = freshRun();
  addJob(manifestPath, { worker: "codex", role: "assist", transport: "headless", title: "x", evidence: EV });
  t.check("an ordinary mutation works", updateJob(manifestPath, 1, { status: "running" }).status, "running");

  // The split-brain, reproduced from the inside: while this mutation is in
  // flight the lock gets reclaimed as stale and re-stamped by a successor. The
  // slow holder used to write its own snapshot on top, erasing the successor's
  // work in silence. Losing the lock has to mean losing the right to write.
  const lockOwner = join(`${manifestPath}.lock`, "owner");
  const msg = threw(() => updateManifest(manifestPath, (m) => {
    writeFileSync(lockOwner, "9999:someone-else", "utf8");
    m.jobs[0].status = "done";
    return m;
  }));
  t.check("a mutation that lost its lock refuses to write", /lost the manifest lock/.test(msg ?? ""), true);
  t.check("...and the manifest is untouched", readManifest(manifestPath).jobs[0].status, "running");
}

// --- a duration typo is rejected, never reinterpreted smaller ---------------
{
  // `--timeout 1m30` used to parse as 60s by ignoring the trailing token, so a
  // legitimate 90-second job got killed at 60. Silently meaning something
  // smaller than asked is the worst failure mode available to a parser.
  t.check("1m30s is 90 seconds", parseDuration("1m30s"), 90_000);
  t.check("a trailing bare number is refused", /cannot parse/.test(threw(() => parseDuration("1m30")) ?? ""), true);
  t.check("a spelled-out unit is refused", /cannot parse/.test(threw(() => parseDuration("8minutes")) ?? ""), true);
  t.check("junk after a valid duration is refused", /cannot parse/.test(threw(() => parseDuration("15m; rm -rf /")) ?? ""), true);
  t.check("surrounding whitespace is still fine", parseDuration("  15m "), 900_000);
  t.check("the ceiling still applies", /ceiling/.test(threw(() => parseDuration("31m")) ?? ""), true);
}

process.exit(t.finish() ? 0 : 1);
