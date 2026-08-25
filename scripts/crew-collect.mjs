#!/usr/bin/env node
/**
 * The review gate for a finished crew run: one command, run last, that decides
 * whether the run may be reported.
 *
 * Before this existed the gate was three sentences of prose in the skill, and
 * the outcome depended on the dispatcher remembering to check. It did not hold:
 * a Codex job died silently and was reported as running for twenty minutes, and
 * two finished jobs were recorded as failed because the runtime's opinion was
 * read before the evidence. Neither needed a smarter reader -- both needed a
 * command with an exit code.
 *
 * The exit code is the whole point, which is why every input that could turn a
 * check off is validated rather than coerced, and why there is no flag that
 * clears a recorded failure.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readManifest, updateJob, appendNote } from "./crew-manifest.mjs";
import { readWorkerStatus } from "./crew-guards.mjs";
import { reconcileRun, resolveEvidence } from "./crew-reconcile.mjs";
import { collectWriteScope } from "./crew-scope.mjs";

/**
 * How long past a job's own timeout it may stay silent before the gate calls it
 * dead.
 *
 * Deliberately generous. The adapter needs seconds, not minutes, to kill a job
 * and record the failure -- but the two errors are not symmetric. Calling a live
 * job dead opens `--abandon`, which throws the work away; calling a dead job
 * live costs one more collect. So the margin sits well past what the adapter
 * needs, and the boundary comparison below is inclusive for the same reason.
 */
const STALE_GRACE_MS = 10 * 60_000;

/**
 * Fallback for a manifest written before adapters recorded `timeoutMs`. Kept at
 * the exact old constant so replaying an old run gives the same verdict it gave
 * before.
 */
const STALE_AFTER_MS = 35 * 60_000;

/**
 * A job is judged dead only after its own allowance runs out, not after a fixed
 * 35 minutes. The old constant was derived from the 30m ceiling, so a job that
 * legitimately ran long read as dead, while a 5-minute job that died got half an
 * hour of benefit of the doubt.
 */
function staleAfter(job) {
  return Number.isFinite(job.timeoutMs) && job.timeoutMs > 0
    ? job.timeoutMs + STALE_GRACE_MS
    : STALE_AFTER_MS;
}

/**
 * Statuses that mean "nobody has recorded an outcome yet". `running` is written
 * by the adapter before it spawns, `pending` by addJob before that; neither is
 * a result, and a job in either state with no evidence may simply be working.
 */
const IN_FLIGHT = new Set(["pending", "running"]);

const PASS = new Set(["done", "done_with_concerns", "done_verified_manually"]);
/** Verdicts a human has to resolve; these block, but they are not failures. */
const NEEDS_HUMAN = new Set(["blocked", "needs_context"]);
/** Verdicts that stop the run from being reported. */
const BLOCKING = new Set(["FAIL", "STALE", "NO_STATUS", "BLOCKED", "NEEDS_HUMAN", "RUNNING"]);

/**
 * `evidence_path` must be unique per job, compared after resolution. Comparing
 * the declared strings was not enough: two jobs can declare different paths
 * whose basenames collide, and a job that did nothing then passes on another
 * job's proof.
 */
function duplicateEvidence(manifest) {
  const seen = new Map();
  const dupes = [];
  for (const job of manifest.jobs) {
    const key = resolve(manifest.workspace, job.evidence);
    if (seen.has(key)) dupes.push({ path: job.evidence, seqs: [seen.get(key), job.seq] });
    else seen.set(key, job.seq);
  }
  return dupes;
}

/** Evidence is a file with a verdict in it; anything else cannot be judged. */
function readEvidence(path) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`evidence không phải file: ${path}`);
  return { bytes: stat.size, text: stat.size === 0 ? "" : readFileSync(path, "utf8") };
}

function judgeOne(job, workspace, now, manifestVersion) {
  const row = { seq: job.seq, worker: job.worker, title: job.title, status: job.status, flags: [], detail: "" };
  const evidenceAbs = resolveEvidence(job, workspace);

  if (!evidenceAbs) {
    if (job.status === "cancelled") {
      row.verdict = "CANCELLED";
      row.detail = "job bị bỏ có chủ ý, không có evidence — đúng như vậy";
      return row;
    }
    const started = Date.parse(job.startedAt ?? "") || null;
    const allowance = staleAfter(job);
    if (IN_FLIGHT.has(job.status) && started && now - started <= allowance) {
      row.verdict = "RUNNING";
      row.detail = `chưa có evidence, mới ${Math.round((now - started) / 60_000)}/${Math.round(allowance / 60_000)} phút — có thể còn chạy`;
      return row;
    }
    row.verdict = IN_FLIGHT.has(job.status) ? "STALE" : "FAIL";
    row.detail = IN_FLIGHT.has(job.status)
      ? `${job.status} mà không có evidence tại ${job.evidence} sau ${Math.round(allowance / 60_000)} phút — coi như chết, bỏ bằng --abandon ${job.seq}`
      : `không có evidence tại ${job.evidence}`;
    return row;
  }

  const evidence = readEvidence(evidenceAbs);
  if (evidence.bytes === 0) {
    row.verdict = "FAIL";
    row.detail = `evidence rỗng: ${job.evidence}`;
    return row;
  }

  // The evidence is the verdict. The manifest is consulted only when the
  // evidence cannot speak -- that ordering is the fix for the two jobs that
  // were wrongly marked failed.
  const read = readWorkerStatus(evidenceAbs);
  // A manifest status may stand in for a missing Status line only when it came
  // from the runner itself. Without that condition a hand-patched `done` let
  // contract-less evidence read as a clean pass.
  const substitute = !read.reported && job.reportedStatus && PASS.has(job.status);
  const status = read.reported ? read.status : (substitute ? job.status : read.status);
  row.status = status;
  row.reported = read.reported;

  if (!read.reported && !substitute) {
    row.verdict = "NO_STATUS";
    row.detail = `evidence có nội dung nhưng thiếu dòng Status: ${job.evidence}`;
    return row;
  }
  if (NEEDS_HUMAN.has(status)) {
    row.verdict = status === "blocked" ? "BLOCKED" : "NEEDS_HUMAN";
    row.detail = job.failure ?? "xem evidence";
    return row;
  }
  if (!PASS.has(status)) {
    row.verdict = "FAIL";
    row.detail = job.failure ?? `status ${status}`;
    return row;
  }

  row.verdict = "PASS";
  // Every way a pass can still need a human's eyes is the same class: something
  // recorded a failure, or nobody vouched for the evidence, and the gate shows
  // the disagreement instead of resolving it -- only a reader can tell a
  // runtime glitch from a job that half-worked.
  const warn = job.runtimeVerdict ? `runtime báo fail nhưng evidence đạt`
    : job.disagreement ? job.disagreement
    : job.failure ? `manifest có ghi lỗi nhưng evidence đạt`
    // Provenance is what the runtime itself recorded: anti-run writes a
    // conversationId, codex-run writes an exitCode, on both the success and the
    // failure path. Neither can be inferred from the evidence, which is why
    // reportedStatus is not the signal -- reconcile sets that from the file, so
    // a hand-written report would look runner-delivered. A job dispatched to a
    // runtime with neither field never heard from that runtime, and the file at
    // the evidence path came from somewhere else -- exactly what happened when a
    // Codex job died and the dispatcher wrote the report by hand.
    // Only asked of a manifest new enough for the adapters to have written
    // those fields. On a version-1 run nothing ever did, so the check fired on
    // nearly every historical job -- and a WARN that is always on is a WARN
    // people learn to scroll past, taking the real ones with it.
    : (manifestVersion >= 2 && job.worker !== "claude"
        && job.exitCode == null && job.conversationId == null)
      ? `evidence không do runtime giao (manifest không có exitCode/conversationId)`
    : null;
  if (warn) {
    row.flags.push("WARN");
    row.detail = `${warn} — đọc mắt: ${job.evidence}`;
  }
  return row;
}

/** Why a BLOCKED job stopped, when the reason is a paid API waiting on the user. */
function costGateReason(job, workspace) {
  const evidenceAbs = resolveEvidence(job, workspace);
  // The evidence text counts too: a worker can stop at a cost gate while its
  // runtime exits cleanly, in which case the manifest carries no failure at all.
  const text = [
    job.failure ?? "", ...(job.notes ?? []),
    evidenceAbs ? readEvidence(evidenceAbs).text : "",
  ].join("\n");
  const hit = /COST_GATE\s*[—:-]?\s*([^\n]*)/.exec(text);
  return hit ? (hit[1].trim() || "không nêu tên API") : null;
}

export function collectRun(manifestPath, { workspace, graceMs, dryRun = false, now = Date.now() } = {}) {
  const abs = resolve(manifestPath);
  // Reconcile first: evidence on disk outranks the manifest, and a gate that
  // judged a stale manifest would fail jobs that had already finished.
  const reconciled = reconcileRun(abs, { dryRun });
  const manifest = readManifest(abs);
  const ws = workspace ?? manifest.workspace;

  const rows = manifest.jobs.map((job) => judgeOne(job, ws, now, manifest.version));
  const dupes = duplicateEvidence(manifest);
  const scope = collectWriteScope(manifest, { workspace: ws, graceMs });
  const costGates = manifest.jobs
    .filter((j) => rows.find((r) => r.seq === j.seq)?.verdict === "BLOCKED")
    .map((j) => ({ seq: j.seq, api: costGateReason(j, ws) }))
    .filter((g) => g.api);

  const blocking = rows.some((r) => BLOCKING.has(r.verdict));
  const violation = scope.outOfScope.length > 0 || scope.protectedHits.length > 0 || dupes.length > 0;
  // 3 is not "worse than 2" -- it is both. Folding the two into one code let a
  // reader who fixed the scope problem believe the run was clean while jobs were
  // still unresolved underneath.
  const exitCode = violation && blocking ? 3 : violation ? 2 : blocking ? 1 : 0;
  const unchecked = rows.length > 0 && scope.intervals.length === 0;

  return { runId: manifest.runId, task: manifest.task, dryRun, reconciled, rows, dupes, scope, costGates, unchecked, exitCode };
}

/**
 * Marks a job the gate judged dead as deliberately abandoned.
 *
 * Restricted to `STALE` on purpose. Abandoning any job would have made this a
 * one-flag bypass: a job an adapter recorded as `failed` with a crash message
 * could be cancelled and vanish from the count, turning exit 1 into exit 0.
 * A recorded failure has to be dealt with, not cleared.
 */
export function abandonJob(manifestPath, seq, { now = Date.now() } = {}) {
  const abs = resolve(manifestPath);
  const manifest = readManifest(abs);
  const job = manifest.jobs.find((j) => j.seq === seq);
  if (!job) throw new Error(`không có job seq ${seq} trong ${manifestPath}`);

  const verdict = judgeOne(job, manifest.workspace, now, manifest.version).verdict;
  if (verdict !== "STALE") {
    throw new Error(
      `job ${seq} đang là ${verdict}, không phải STALE — --abandon chỉ bỏ được job treo không evidence. `
      + "Job có ghi lỗi thì phải xử, không được bỏ cho hết đỏ.",
    );
  }
  updateJob(abs, seq, { status: "cancelled", endedAt: job.endedAt ?? new Date(now).toISOString() });
  return appendNote(abs, seq, "collect: bỏ job vì pending quá lâu và không có evidence");
}

function report(r) {
  console.log(`run ${r.runId} — task ${r.task}`);
  for (const p of r.reconciled.patched) console.log(`  reconcile: job ${p.seq} ${p.from} → ${p.to} theo evidence`);
  if (r.dryRun) console.log("  (--dry-run: không ghi gì vào manifest)");

  console.log("\n| # | worker | verdict | job | ghi chú |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const row of r.rows) {
    const verdict = row.flags.length ? `${row.verdict} + ${row.flags.join("+")}` : row.verdict;
    console.log(`| ${row.seq} | ${row.worker} | ${verdict} | ${row.title} | ${row.detail} |`);
  }

  if (r.dupes.length) {
    console.log("\nTRÙNG EVIDENCE — job sau ghi đè bằng chứng của job trước:");
    for (const d of r.dupes) console.log(`  job ${d.seqs.join(" và ")} trỏ về cùng một file: ${d.path}`);
  }

  if (r.scope.protectedHits.length) {
    console.log("\nGHI VÀO FILE ĐƯỢC BẢO VỆ — không worker nào được phép:");
    for (const h of r.scope.protectedHits) console.log(`  ${h.path} (lúc job ${h.seqs.join("/")} chạy)`);
  }
  if (r.scope.outOfScope.length) {
    console.log("\nSCOPE_VIOLATION — file bị ghi ngoài phạm vi run:");
    for (const p of r.scope.outOfScope) console.log(`  ${p.path} (lúc job ${p.seqs.join("/")} chạy)`);
    console.log("  Nếu đây là chỗ ghi hợp lệ, khai `filesMayModify` cho job lúc addJob thay vì bỏ qua cảnh báo.");
  }
  if (r.scope.suspect.length) {
    console.log("\nNGHI VẤN PHẠM VI (không chặn) — job không ghi được giờ kết thúc nên khoảng thời gian chỉ là suy đoán:");
    for (const p of r.scope.suspect) console.log(`  ${p.path} (có thể của job ${p.seqs.join("/")})`);
  }
  if (r.scope.unattributable.length) {
    console.log(`\nkhông quy được cho job nào (file đã xoá hoặc không stat được), tự đọc: ${r.scope.unattributable.join(", ")}`);
  }
  console.log(`\nphạm vi ghi: ${r.scope.inScope.length} file trong phạm vi, ${r.scope.outsideWindow.length} file thay đổi ngoài khoảng job chạy (không tính)`);
  console.log("  Lưu ý: chỉ đọc working tree — file đã commit thì không thấy.");
  if (r.unchecked) console.log("  CHƯA KIỂM ĐƯỢC: không job nào có startedAt, nên không quy được file nào cho run này.");

  if (r.costGates.length) {
    console.log("\nCỔNG CHI PHÍ — không phải lỗi, đang chờ user quyết:");
    for (const g of r.costGates) {
      console.log(`  job ${g.seq} dừng ở ${g.api}. Hỏi user: "Job ${g.seq} cần gọi ${g.api} (tốn tiền). Chạy tiếp không?"`);
    }
  }

  const pass = r.rows.filter((x) => x.verdict === "PASS").length;
  const warn = r.rows.filter((x) => x.flags.includes("WARN")).length;
  const cancelled = r.rows.filter((x) => x.verdict === "CANCELLED").length;
  const counted = r.rows.length - cancelled;
  console.log(`\n${pass}/${counted} job đạt${cancelled ? `, ${cancelled} job bỏ có chủ ý` : ""}${warn ? `, ${warn} job cần đọc mắt (WARN)` : ""} — exit ${r.exitCode}`);
  if (r.exitCode === 1) console.log("Chưa được viết report tổng: còn job chưa xong hoặc đang chờ quyết định.");
  if (r.exitCode === 2) console.log("Chưa được viết report tổng: có vi phạm phạm vi ghi hoặc trùng evidence.");
  if (r.exitCode === 3) {
    console.log("Chưa được viết report tổng: vướng CẢ HAI —");
    console.log("  (1) còn job chưa xong hoặc đang chờ quyết định;");
    console.log("  (2) có vi phạm phạm vi ghi hoặc trùng evidence.");
    console.log("  Sửa xong một bên vẫn ra exit khác 0; xử cả hai rồi chạy lại.");
  }
}

/** Flags with a value, so a manifest path is never read out of one. */
function parseArgs(argv) {
  const withValue = new Set(["--abandon", "--grace"]);
  const opts = { flags: new Set(), values: new Map(), positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (withValue.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} thiếu giá trị`);
      opts.values.set(a, v);
      i += 1;
    } else if (a.startsWith("--")) opts.flags.add(a);
    else opts.positional.push(a);
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const manifestPath = opts.positional[0];
    if (!manifestPath || opts.positional.length > 1) {
      console.error(
        "usage: crew-collect.mjs <manifest.json> [--abandon <seq>] [--grace <ms>] [--dry-run]\n" +
        "exit: 0 = được report | 1 = còn job chưa xong | 2 = vi phạm phạm vi ghi | 3 = cả 1 và 2",
      );
      process.exit(2);
    }
    const dryRun = opts.flags.has("--dry-run");
    if (opts.values.has("--abandon")) {
      const seq = Number(opts.values.get("--abandon"));
      if (!Number.isInteger(seq)) throw new Error(`--abandon cần số seq, nhận "${opts.values.get("--abandon")}"`);
      if (dryRun) console.log(`(--dry-run) sẽ bỏ job ${seq}, chưa ghi gì`);
      else console.log(`đã bỏ job ${abandonJob(manifestPath, seq).seq}`);
    }
    let graceMs;
    if (opts.values.has("--grace")) {
      graceMs = Number(opts.values.get("--grace"));
      if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error(`--grace cần số ms ≥ 0, nhận "${opts.values.get("--grace")}"`);
    }
    const r = collectRun(manifestPath, { graceMs, dryRun });
    report(r);
    process.exit(r.exitCode);
  } catch (err) {
    console.error(`crew-collect: ${err.message}`);
    process.exit(2);
  }
}
