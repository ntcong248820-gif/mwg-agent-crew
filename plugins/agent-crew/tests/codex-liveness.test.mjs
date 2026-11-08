#!/usr/bin/env node
/**
 * Bộ canh im lặng của codex-run: im ≠ chết. Codex không in gì lúc chờ model, nên
 * job chỉ bị giết khi im VÀ không tốn CPU VÀ không nhận thêm byte mạng VÀ
 * (không giữ kết nối nào, hoặc đã im quá trần chờ model).
 *
 * Phần đầu kiểm bộ đọc tín hiệu với ps/lsof/nettop giả; phần sau chạy codex-run
 * thật với fake codex: một job im 8s vì đang chạy lệnh tốn CPU (không được
 * giết), một job im mà không làm gì (phải giết, nêu lý do).
 *
 * Run: node plugins/agent-crew/tests/codex-liveness.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CPU_MIN_SEC, cpuDelta, createLivenessProbe, descendantsOf, parseCpuTime, parseNettop, parsePs } from "../scripts/lib/codex-liveness.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("codex-liveness");

// --- đọc ps / nettop ------------------------------------------------------------
/** Ảnh ps giả: [pid, ppid, cpu, cmd]. */
const ps = (rows) => rows.map(([pid, ppid, cpu, cmd]) => `${pid} ${ppid} ${cpu} ${cmd}`).join("\n");
const TREE = [
  [100, 1, "0:01.00", "node /opt/homebrew/bin/codex exec --json"],
  [101, 100, "0:02.00", "/opt/homebrew/lib/codex/codex exec --json"],
  [102, 101, "0:00.50", "node /Users/x/.codex/mcp/server.js"],     // server MCP rảnh
  [200, 1, "5:00.00", "python3 khác-cây.py"],                       // không thuộc cây Codex
];
{
  t.check("giờ CPU dạng m:ss.cc", parseCpuTime("3:04.50"), 184.5);
  t.check("...dạng ngày-hh:mm:ss", parseCpuTime("1-02:03:04"), 93_784);
  const procs = parsePs(ps(TREE));
  t.check("ps: đọc đủ dòng, giữ cmd có khoảng trắng", `${procs.size}/${procs.get(101).cmd}`, "4//opt/homebrew/lib/codex/codex exec --json");
  t.check("cây con cháu của codex", descendantsOf(100, procs).sort().join(), "101,102");
  const after = parsePs(ps([...TREE.slice(0, 2), [102, 101, "0:00.52", TREE[2][3]], [200, 1, "9:00.00", "python3 khác-cây.py"]]));
  t.check("server MCP rảnh (+0.02s) dưới ngưỡng; cây khác không tính", cpuDelta(100, procs, after).sec < CPU_MIN_SEC, true);
  const busy = parsePs(ps([...TREE, [103, 101, "0:04.00", "python3 -"]]));
  const d = cpuDelta(100, procs, busy);
  t.check("lệnh mới sinh (zsh đã exec thành python3) tính trọn CPU", `${d.sec}/${d.top}`, "4/python3 -");
  t.check("nettop: tên có dấu chấm vẫn lấy đúng pid", parseNettop(",bytes_in,\ncodex.app.101,5000,\ncurl.9,1,\n").get(101), 5000);
}

// --- probe với tín hiệu giả ---------------------------------------------------------------
{
  const idleTree = ps(TREE);
  const burning = ps([...TREE.slice(0, 1), [101, 100, "0:09.00", TREE[1][3]], TREE[2]]);
  const seq = (...xs) => { let i = 0; return () => xs[Math.min(i++, xs.length - 1)]; };
  const probe = (over) => createLivenessProbe(100, { ps: seq(idleTree, idleTree), hasSockets: () => false, wait: async () => {}, ...over });

  const cpu = await probe({ ps: seq(idleTree, burning) }).check();
  t.check("CPU cây Codex tăng 7s → sống, kind cpu", `${cpu.alive}/${cpu.kind}`, "true/cpu");

  let bytes = [1000, 4000];
  const net = await probe({ hasSockets: () => true, nettop: async () => `,bytes_in,\ncodex.101,${bytes.shift()},\n` }).check({ silentMs: 20 * 60_000 });
  t.check("byte tăng giữa hai lần nettop → sống dù đã im 20 phút", `${net.alive}/${net.kind}/${/\+3000 byte/.test(net.reason)}`, "true/network/true");

  const flat = () => async () => ",bytes_in,\ncodex.101,1000,\n";
  const thinking = await probe({ hasSockets: () => true, nettop: flat() }).check({ silentMs: 3 * 60_000 });
  t.check("chỉ còn kết nối mở, im 3 phút → sống (đang chờ model)", `${thinking.alive}/${thinking.kind}`, "true/waiting-model");
  const stuck = await probe({ hasSockets: () => true, nettop: flat() }).check({ silentMs: 11 * 60_000 });
  t.check("chỉ còn kết nối mở, im quá 10 phút → chết", `${stuck.alive}/${/chỉ còn kết nối mở/.test(stuck.reason)}`, "false/true");

  const offline = await probe().check({ silentMs: 120_000 });
  t.check("không CPU, không kết nối → chết, nêu lý do", `${offline.alive}/${offline.reason}`, "false/không dùng CPU, không có kết nối mạng");
  const blind = await probe({ hasSockets: () => true, nettop: async () => null }).check({ silentMs: 11 * 60_000 });
  t.check("nettop không chạy được, quá trần chờ model → không coi là sống", blind.alive, false);
  const broken = await probe({ ps: () => { throw new Error("x"); } }).check();
  t.check("tín hiệu hỏng → không throw, coi như chết", broken.alive, false);
}

// --- codex-run thật với fake codex -------------------------------------------------------
const ADAPTER = join(MODULE_ROOT, "scripts", "codex-run.mjs");
const RUN_DIR_REL = join("tasks", "t", "reports", "crew-live");
const ws = tmpWorkspace("liveness-");
const brief = writeFile(join(ws, "brief.md"), "do the thing\n");
mkdirSync(join(ws, RUN_DIR_REL), { recursive: true });
function run(mode, evidence, idle) {
  const started = Date.now();
  const p = spawnSync("node", [ADAPTER, "--prompt-file", brief, "--evidence", evidence, "--workspace", ws, "--timeout", "60s", "--idle-timeout", idle], {
    encoding: "utf8", timeout: 90_000,
    env: { ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: mode, FAKE_EVIDENCE: join(ws, evidence) },
  });
  let json = null;
  try { json = JSON.parse(p.stdout); } catch { /* lỗi: stdout rỗng */ }
  return { exit: p.status, seconds: (Date.now() - started) / 1000, stderr: p.stderr ?? "", json };
}
{
  const busy = run("silent_command", join(RUN_DIR_REL, "busy.md"), "2s");
  t.check("im 8s nhưng đang chạy lệnh tốn CPU, idle 2s → không bị giết, xong DONE", `${busy.exit}/${busy.json?.status}`, "0/done");
  const stream = busy.json?.stream ? readFileSync(busy.json.stream, "utf8") : "";
  t.check("...sidecar ghi lý do còn sống (CPU, nêu tiến trình tốn nhất)", /còn sống: vẫn dùng CPU \(\+[\d.]+s, nhiều nhất: yes\)/.test(stream), true);

  const dead = run("silent_dead", join(RUN_DIR_REL, "dead.md"), "2s");
  t.check("im, không lệnh, không mạng → bị giết", dead.exit, 1);
  t.check("...gần mốc idle, không đợi tới timeout", dead.seconds < 15, true);
  t.check("...lý do nói rõ các tín hiệu cùng im", /no stdout event for \d+s — không dùng CPU, không có kết nối mạng/.test(dead.stderr), true);
}

process.exit(t.finish() ? 0 : 1);
