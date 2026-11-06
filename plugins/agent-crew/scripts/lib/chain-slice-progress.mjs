/**
 * Lát chuỗi có đổi file nào ngoài evidence không — phép kiểm "có tiến triển"
 * của chain-runner, phần phải đụng đĩa (handoff-check.mjs giữ phần thuần).
 *
 * Hai nguồn, nguồn đầu thắng: `touchedFiles` runtime Codex khai (đáng tin nhất),
 * rồi mtime dưới thư mục run và `filesMayModify` của lát. Anti không khai
 * `touchedFiles`, nên với Anti chỉ còn mtime — một lát chỉ `touch` file vẫn qua,
 * đó là giới hạn chấp nhận: checkpoint Claude mỗi 2 lát là lớp sau.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__"]);
const MAX_ENTRIES = 20_000;

/** File (đệ quy) dưới `root` có mtime ≥ `sinceMs`, trừ `excluded`. Dừng ở MAX_ENTRIES. */
function newestUnder(root, sinceMs, excluded, budget) {
  let st;
  try { st = statSync(root); } catch { return false; }
  if (st.isFile()) return !excluded(root) && st.mtimeMs >= sinceMs;
  if (!st.isDirectory()) return false;
  let names;
  try { names = readdirSync(root); } catch { return false; }
  for (const name of names) {
    if (budget.left-- <= 0) return false;
    if (SKIP_DIRS.has(name)) continue;
    if (newestUnder(join(root, name), sinceMs, excluded, budget)) return true;
  }
  return false;
}

/**
 * `slice`: job lát trong sổ (đã xong). `manifestPath`, `workspace`, `logsDir` để
 * loại những thứ crew tự ghi: sổ, brief, evidence (của mọi job — job khác chạy
 * song song cũng ghi vào thư mục run), log thô, sidecar.
 */
export function sliceChangedFiles({ slice, manifestPath, workspace, logsDir }) {
  const evidenceAbs = resolve(workspace, ...slice.evidence.split("/"));
  const runDir = dirname(manifestPath);
  const toAbs = (p) => (isAbsolute(p) ? p : resolve(workspace, ...p.split("/")));

  const touched = (slice.touchedFiles ?? []).map(toAbs).filter((p) => p !== evidenceAbs);
  if (touched.length) return true;

  const sinceMs = Date.parse(slice.startedAt ?? "");
  if (!Number.isFinite(sinceMs)) return false;
  const inside = (p, dir) => { const r = relative(dir, p); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
  const excluded = (p) => p === evidenceAbs
    || p === resolve(manifestPath)
    || (logsDir && inside(p, logsDir))
    || (dirname(p) === runDir && /^(brief-|manifest|chain-|worker-.*\.md$)|\.lock$/.test(basename(p)));
  const roots = [runDir, ...(slice.filesMayModify ?? []).map((p) => resolve(workspace, ...p.split("/").filter(Boolean)))];
  const budget = { left: MAX_ENTRIES };
  return roots.some((root) => newestUnder(root, sinceMs, excluded, budget));
}
