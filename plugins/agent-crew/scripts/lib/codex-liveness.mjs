/**
 * Codex im lặng thì còn sống không? Bộ canh im lặng của codex-run hỏi ở đây
 * trước khi giết job.
 *
 * Vì sao (08/11): `codex exec --json` chỉ in một event khi xong một bước. Lúc
 * chờ model — model nghĩ lâu (effort high) hay mạng chậm làm câu trả lời về nhỏ
 * giọt — nó im hoàn toàn. Bộ canh cũ chỉ đếm event nên giết hai job đang chờ
 * model qua mạng chậm (log có "request timed out"), sau 2 phút im.
 *
 * Tín hiệu, xét theo thứ tự; job chỉ bị coi là chết khi không cái nào nói sống:
 *   1. CPU — tổng thời gian CPU của cây tiến trình Codex tăng trong cửa sổ đo:
 *      đang chạy lệnh (script, build, test) hay chính Codex đang xử lý. Không
 *      nhận diện lệnh qua `zsh -lc`: zsh thay mình bằng lệnh cuối (đo 08/11),
 *      nên `python3 …` hiện ra trần trụi, không còn shell cha.
 *   2. Byte mạng — cây tiến trình nhận thêm byte giữa hai lần đo nettop (macOS,
 *      không cần root): model đang trả lời, dù chậm.
 *   3. Kết nối đang mở — chờ model mà model chưa gửi gì (đang nghĩ). Có trần
 *      MODEL_WAIT_MAX_MS: Codex tự cắt luồng model im quá 5 phút rồi thử lại
 *      (lần thử lại in event), nên im lâu hơn trần mà chỉ còn kết nối là treo.
 *
 * Server MCP cũng là con của Codex; lúc rảnh nó gần như không tốn CPU, nên
 * ngưỡng CPU_MIN_SEC lọc nó ra. Giới hạn đã biết: Codex treo mà vẫn nhận byte
 * keepalive từ đâu đó trông như còn sống; trần `--timeout` của job là chốt cuối.
 *
 * Không throw: đọc tín hiệu hỏng thì coi như tín hiệu đó im.
 */
import { execFileSync, spawn } from "node:child_process";

/** Còn sống mà vẫn im thì cách bao lâu hỏi lại. */
export const LIVENESS_RECHECK_MS = 30_000;
/** Chỉ còn kết nối mở (chờ model nghĩ) thì cho im tối đa chừng này. */
export const MODEL_WAIT_MAX_MS = 10 * 60_000;
/** CPU tăng từ ngần này trong cửa sổ đo mới tính là đang làm (server MCP rảnh tốn ~0). */
export const CPU_MIN_SEC = 0.2;
/** Cửa sổ đo CPU khi không có kết nối mạng (có kết nối thì cửa sổ là hai lần nettop). */
const CPU_WINDOW_MS = 3_000;
const NETTOP_TIMEOUT_MS = 12_000;

/** "1-02:03:04.5" | "02:03:04" | "3:04.50" → giây. */
export function parseCpuTime(text) {
  const [days, rest] = String(text).includes("-") ? String(text).split("-") : ["0", String(text)];
  const parts = rest.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  const sec = parts.reduce((acc, n) => acc * 60 + n, 0);
  return Number(days) * 86_400 + sec;
}

/** `ps -A -o pid=,ppid=,time=,command=` → Map pid → { ppid, cpu, cmd }. */
export function parsePs(text) {
  const procs = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), cpu: parseCpuTime(m[3]), cmd: m[4] });
  }
  return procs;
}

/** Mọi tiến trình con cháu của `root` (không gồm root). */
export function descendantsOf(root, procs) {
  const children = new Map();
  for (const [pid, { ppid }] of procs) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const seen = new Set();
  const queue = [...(children.get(root) ?? [])];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * CPU cây tiến trình tăng bao nhiêu giữa hai ảnh ps, và tiến trình nào tốn nhiều
 * nhất. Tiến trình mới sinh trong cửa sổ tính trọn CPU của nó.
 */
export function cpuDelta(root, before, after) {
  const tree = (procs) => new Set([root, ...descendantsOf(root, procs)]);
  const was = tree(before);
  let total = 0;
  let top = null;
  for (const pid of tree(after)) {
    const now = after.get(pid);
    if (!now) continue;
    const d = now.cpu - (was.has(pid) ? (before.get(pid)?.cpu ?? 0) : 0);
    if (d > 0) total += d;
    if (d > 0 && (!top || d > top.d)) top = { d, cmd: now.cmd };
  }
  return { sec: Math.round(total * 100) / 100, top: top ? top.cmd.replace(/\s+/g, " ").slice(0, 60) : null };
}

/** CSV của `nettop -P -L 1 -J bytes_in -x` → Map pid → byte đã nhận. Dòng dạng `curl.30707,292737,`. */
export function parseNettop(text) {
  const bytes = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^.*\.(\d+),(\d+),/);
    if (m) bytes.set(Number(m[1]), Number(m[2]));
  }
  return bytes;
}

function readPs() {
  try {
    return execFileSync("ps", ["-A", "-o", "pid=,ppid=,time=,command="], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Cây tiến trình có kết nối mạng đang mở không. lsof nhanh (~0.2s), nettop chậm (~5s): hỏi lsof trước. */
function hasSockets(pids) {
  try {
    const out = execFileSync("lsof", ["-nP", "-a", "-i", "-p", pids.join(",")], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    return /ESTABLISHED/.test(out);
  } catch {
    return false; // lsof exit 1 khi không có dòng nào
  }
}

function readNettop() {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try {
      p = spawn("nettop", ["-P", "-L", "1", "-J", "bytes_in", "-x"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      end(null);
      return;
    }
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* đã thoát */ } end(null); }, NETTOP_TIMEOUT_MS);
    p.stdout.on("data", (c) => { out += c; });
    p.on("error", () => { clearTimeout(timer); end(null); });
    p.on("close", (code) => { clearTimeout(timer); end(code === 0 ? out : null); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Probe cho một job. `check({ silentMs })` → { alive, kind, reason }.
 * `deps` để test thay ps/lsof/nettop/đồng hồ chờ.
 */
export function createLivenessProbe(rootPid, deps = {}) {
  const ps = deps.ps ?? readPs;
  const sockets = deps.hasSockets ?? hasSockets;
  const nettop = deps.nettop ?? readNettop;
  const wait = deps.wait ?? sleep;
  const modelWaitMaxMs = deps.modelWaitMaxMs ?? MODEL_WAIT_MAX_MS;
  return {
    async check({ silentMs = 0 } = {}) {
      try {
        const before = parsePs(ps());
        const pids = [rootPid, ...descendantsOf(rootPid, before)];
        const online = sockets(pids);
        // Có kết nối: hai lần nettop (~10s) vừa đo byte vừa làm cửa sổ CPU.
        let grew = null;
        if (online) {
          const sum = (text) => (text == null ? null : pids.reduce((s, pid) => s + (parseNettop(text).get(pid) ?? 0), 0));
          const a = sum(await nettop());
          const b = sum(await nettop());
          if (a != null && b != null) grew = b - a;
        } else {
          await wait(CPU_WINDOW_MS);
        }
        const cpu = cpuDelta(rootPid, before, parsePs(ps()));
        if (cpu.sec >= CPU_MIN_SEC) {
          return { alive: true, kind: "cpu", reason: `vẫn dùng CPU (+${cpu.sec}s${cpu.top ? `, nhiều nhất: ${cpu.top}` : ""})` };
        }
        if (grew > 0) return { alive: true, kind: "network", reason: `vẫn nhận dữ liệu mạng (+${grew} byte)` };
        if (online && silentMs < modelWaitMaxMs) {
          return { alive: true, kind: "waiting-model", reason: `giữ kết nối mạng, đang chờ model (cho im tối đa ${Math.round(modelWaitMaxMs / 60_000)} phút)` };
        }
        return {
          alive: false,
          reason: online
            ? `không dùng CPU, không nhận byte nào, chỉ còn kết nối mở sau ${Math.round(silentMs / 60_000)} phút im`
            : "không dùng CPU, không có kết nối mạng",
        };
      } catch {
        return { alive: false, reason: "không đọc được tín hiệu sống" };
      }
    },
  };
}
