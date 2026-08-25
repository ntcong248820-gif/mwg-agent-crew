#!/usr/bin/env node
/**
 * A stand-in for the Codex plugin's codex-companion.mjs.
 *
 * It exists because the app transport cannot be tested against the real thing:
 * that would need the Codex app running, would cost tokens, and could not be
 * made to fail on demand. The failure shapes are the point of these tests.
 *
 * The JSON shapes below were measured against companion 1.0.5 on 2026-08-25 --
 * a fixture invented from the plan's guesses would have tested the wrong
 * contract, which is exactly what nearly shipped:
 *   task --background --json  ->  { jobId, status, title, summary, logFile }
 *   status <id> --wait --json ->  { workspaceRoot, job, waitTimedOut, timeoutMs }
 *
 * Driven by env so the adapter's own argv stays untouched:
 *   FAKE_COMPANION_MODE     ok | failed | timeout | no_job_id | not_json | crash
 *   FAKE_COMPANION_EVIDENCE absolute path the fake "worker" writes
 *   FAKE_COMPANION_BODY     what it writes there ("" writes nothing)
 *   FAKE_COMPANION_MARKER   file that records which subcommands were called
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const mode = process.env.FAKE_COMPANION_MODE ?? "ok";
const [cmd, ...rest] = process.argv.slice(2);
const marker = process.env.FAKE_COMPANION_MARKER;

if (marker) appendFileSync(marker, `${cmd}\n`);

const JOB_ID = "task-fake-0001";
const THREAD_ID = "01a037ab-924f-7fe1-b76a-9bfd7e329ded";

function say(value) {
  console.log(JSON.stringify(value, null, 2));
  process.exit(0);
}

if (cmd === "task") {
  if (mode === "crash") {
    process.stderr.write("fake-companion: codex is not available\n");
    process.exit(1);
  }
  if (mode === "not_json") {
    console.log("Queued.");
    process.exit(0);
  }
  if (mode === "no_job_id") say({ status: "queued", title: "Codex Task" });

  // The real worker writes the evidence; the fake does it at dispatch time
  // because there is no separate process here to do it later.
  const evidence = process.env.FAKE_COMPANION_EVIDENCE;
  const body = process.env.FAKE_COMPANION_BODY ?? "";
  if (evidence && body) {
    mkdirSync(dirname(evidence), { recursive: true });
    writeFileSync(evidence, body, "utf8");
  }
  say({ jobId: JOB_ID, status: "queued", title: "Codex Task", summary: "fake", logFile: "/tmp/fake.log" });
}

if (cmd === "status") {
  const active = mode === "timeout";
  say({
    workspaceRoot: process.cwd(),
    job: {
      id: JOB_ID,
      status: active ? "running" : (mode === "failed" ? "failed" : "completed"),
      phase: active ? "working" : "done",
      threadId: THREAD_ID,
      turnId: "01a037ab-a252-7ed0-bf3c-d8996a8c1fa2",
      errorMessage: mode === "failed" ? "the worker fell over" : null,
      logFile: "/tmp/fake.log",
    },
    waitTimedOut: active,
    timeoutMs: Number(rest[rest.indexOf("--timeout-ms") + 1]) || 0,
  });
}

if (cmd === "cancel") say({ jobId: JOB_ID, status: "cancelled", title: "Codex Task" });

process.stderr.write(`fake-companion: unknown command ${cmd}\n`);
process.exit(2);
