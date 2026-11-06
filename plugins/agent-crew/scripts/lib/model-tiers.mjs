/**
 * Bậc model: Claude chọn một chữ, crew đổi ra tên model còn sống hoặc `--effort`.
 *
 * Trước đây dispatcher phải chạy `crew doctor`, đọc danh sách `agy models`, rồi tự
 * ghép tên vào `--model`. Tên ghép từ trí nhớ đã giết job (đo 16/10: hai job đầu
 * của một run chết ngay lượt đầu vì tên trong tài liệu đã hết hạn). Ở đây tên được
 * chọn từ chính danh sách `agy models` trả về lúc ghi sổ, nên không thể là tên chết.
 *
 * Luật chọn tên cho Anti headless:
 *   - mọi regex neo đầu-cuối, để `flash` không khớp nhầm `flash-lite`;
 *   - regex đi lần lượt, regex đầu có khớp thì dừng;
 *   - trong một regex khớp nhiều model thì lấy số phiên bản cao nhất;
 *   - không khớp gì thì báo lỗi kèm tên còn sống. KHÔNG rơi sang model của bậc
 *     khác: `light` mà ra `flash-high` là âm thầm đổi giá và đổi chất lượng.
 *
 * Bậc `claude`/`claude-max` chạy model Claude bằng quota Antigravity (chỉ Anti
 * headless, đo 06/11 trong docs/transport-measurements.md). Chúng nằm ngoài chuỗi
 * nâng bậc: đổi nhà cung cấp là quyết định có chủ ý, không phải bước tự động.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class TierError extends Error {}

export const TIERS = Object.freeze(["light", "standard", "deep", "code", "claude", "claude-max"]);

/** Bậc mà `agentapi` (Anti app) nhận. */
export const APP_TIERS = Object.freeze(["flash_lite", "flash", "pro", "inherit"]);
export const EFFORTS = Object.freeze(["low", "medium", "high"]);

/**
 * `agy`: regex (chuỗi, neo ^...$) theo thứ tự ưu tiên; null = bậc không dành cho
 * Anti headless. `app`: bậc agentapi; null = không dùng được ở Anti app.
 * `effort`: mức Codex; null = không dành cho Codex.
 */
export const DEFAULT_TIER_MAP = Object.freeze({
  light: { agy: ["^gemini-[\\d.]+-flash-lite$", "^gemini-[\\d.]+-flash-low$"], app: "flash_lite", effort: "low" },
  standard: { agy: ["^gemini-[\\d.]+-flash-medium$"], app: "flash", effort: "low" },
  deep: { agy: ["^gemini-[\\d.]+-pro-high$", "^gemini-[\\d.]+-pro$", "^gemini-[\\d.]+-flash-high$"], app: "pro", effort: "medium" },
  code: { agy: null, app: null, effort: "high" },
  claude: { agy: ["^claude-sonnet-[\\d-]+$"], app: null, effort: null },
  "claude-max": { agy: ["^claude-opus-[\\d-]+(-thinking)?$"], app: null, effort: null },
});

/** Chuỗi nâng bậc khi job trước chưa đạt. Bậc ngoài chuỗi đứng yên. */
const BUMP = Object.freeze({ light: "standard", standard: "deep" });

export function bumpTier(tier) {
  assertTier(tier);
  return BUMP[tier] ?? tier;
}

function assertTier(tier) {
  if (!TIERS.includes(tier)) throw new TierError(`--tier phải là ${TIERS.join("|")}, nhận "${tier ?? ""}"`);
}

/** Tên model `agy models` còn liệt kê: cột đầu mỗi dòng, bỏ dòng thông báo. */
export function parseAgyModels(text) {
  return String(text).split("\n").map((l) => l.split("\t")[0].trim()).filter((s) => /^[a-z0-9][a-z0-9.-]+$/.test(s));
}

/** Model Codex đang đặt trong config máy, hoặc null. */
export function codexConfigModel(home = homedir()) {
  try {
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(home, ".codex", "config.toml"), "utf8"));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Gọi `agy models` (30s như doctor). Không đọc được thì lỗi nói rõ đường tay. */
export function liveAgyModels() {
  const p = spawnSync("agy", ["models"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  const names = p.status === 0 ? parseAgyModels(p.stdout) : [];
  if (!names.length) {
    const why = p.error?.message ?? (`${p.stderr ?? ""}`.trim().split("\n")[0] || "không có tên model nào");
    throw new TierError(`không đọc được \`agy models\` để đổi --tier ra tên model: ${why}\n  → truyền --model <tên> tay (crew doctor in tên còn sống)`);
  }
  return names;
}

/** Số phiên bản trong tên: `gemini-3.8-flash-medium` → [3,8]; `claude-sonnet-4-6` → [4,6]. */
const versionOf = (name) => (name.match(/\d+/g) ?? []).map(Number);

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/** Tên đầu tiên khớp theo thứ tự regex, bản cao nhất trong regex đó; không có thì null. */
export function pickModel(patterns, names) {
  for (const p of patterns) {
    const re = new RegExp(p);
    const hits = names.filter((n) => re.test(n));
    if (hits.length) return hits.reduce((best, n) => (compareVersions(versionOf(n), versionOf(best)) > 0 ? n : best));
  }
  return null;
}

/** Bảng mặc định với phần ghi đè `modelTiers` của repo (đã validate ở crew-config). */
export function tierMap(overrides = {}) {
  return Object.fromEntries(TIERS.map((t) => [t, { ...DEFAULT_TIER_MAP[t], ...(overrides[t] ?? {}) }]));
}

/**
 * Đổi một bậc ra thứ adapter nhận: `{tier, model, effort}`. Anti headless cần
 * `liveAgyModels`, Codex nhận `codexModel` (model trong ~/.codex/config.toml). `liveAgyModels: null` chỉ kiểm
 * bậc có hợp worker/transport không (dùng khi cờ tay đã chọn model), không chọn tên.
 */
export function resolveTier({ worker, transport = "headless", tier, liveAgyModels: names = [], codexModel = null, overrides = {} }) {
  assertTier(tier);
  const row = tierMap(overrides)[tier];
  if (worker === "claude") {
    throw new TierError("job Claude không nhận --tier: Claude tự làm bằng model của phiên, truyền --model");
  }
  if (worker === "codex") {
    if (!row.effort) throw new TierError(`tier ${tier} chỉ cho Anti headless (model Claude chạy qua quota Antigravity); Codex nhận light|standard|deep|code`);
    // Bậc Codex là effort; model vẫn ghi (lấy từ config máy) để sổ đo được model nào đã chạy.
    return { tier, model: codexModel, effort: row.effort };
  }
  if (tier === "code" && !row.agy && !row.app) throw new TierError("tier code chỉ cho Codex");
  if (transport === "app") {
    if (!row.app) throw new TierError(`tier ${tier} không dùng được ở Anti app: agentapi chỉ nhận ${APP_TIERS.join("|")}`);
    return { tier, model: row.app, effort: null };
  }
  if (!row.agy) throw new TierError(`tier ${tier} không có model cho Anti headless`);
  if (names === null) return { tier, model: null, effort: null };
  const model = pickModel(row.agy, names);
  if (!model) {
    throw new TierError(
      `tier ${tier} không khớp model nào \`agy models\` còn liệt kê (${row.agy.join(", ")})\n` +
      `  → model còn sống: ${names.join(", ") || "(không có)"}\n` +
      "  → truyền --model <tên> tay, hoặc khai modelTiers trong crew.config.json",
    );
  }
  return { tier, model, effort: null };
}

/**
 * Validate `modelTiers` trong crew.config.json: `{ "<tier>": {agy?, app?, effort?} }`.
 * `fail(msg)` ném lỗi theo kiểu của config loader.
 */
export function normalizeModelTiers(value, fail) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail("modelTiers phải là object {tier: {agy?, app?, effort?}}");
  const out = {};
  for (const [tier, row] of Object.entries(value)) {
    if (!TIERS.includes(tier)) fail(`modelTiers: tier lạ "${tier}" (nhận: ${TIERS.join(", ")})`);
    if (!row || typeof row !== "object" || Array.isArray(row)) fail(`modelTiers.${tier} phải là {agy?, app?, effort?}`);
    const extra = Object.keys(row).filter((k) => !["agy", "app", "effort"].includes(k));
    if (extra.length) fail(`modelTiers.${tier}: khoá lạ ${extra.join(", ")} (nhận: agy, app, effort)`);
    const entry = {};
    if ("agy" in row) {
      if (!Array.isArray(row.agy) || !row.agy.length) fail(`modelTiers.${tier}.agy phải là mảng regex dạng chuỗi, không rỗng`);
      row.agy.forEach((p, i) => {
        if (typeof p !== "string" || !p.startsWith("^") || !p.endsWith("$")) fail(`modelTiers.${tier}.agy[${i}] phải là regex neo ^...$: ${JSON.stringify(p)}`);
        try { new RegExp(p); } catch (err) { fail(`modelTiers.${tier}.agy[${i}] không phải regex hợp lệ: ${err.message}`); }
      });
      entry.agy = Object.freeze([...row.agy]);
    }
    if ("app" in row) {
      if (!APP_TIERS.includes(row.app)) fail(`modelTiers.${tier}.app phải là ${APP_TIERS.join("|")}: ${JSON.stringify(row.app)}`);
      entry.app = row.app;
    }
    if ("effort" in row) {
      if (!EFFORTS.includes(row.effort)) fail(`modelTiers.${tier}.effort phải là ${EFFORTS.join("|")}: ${JSON.stringify(row.effort)}`);
      entry.effort = row.effort;
    }
    out[tier] = Object.freeze(entry);
  }
  return Object.freeze(out);
}
