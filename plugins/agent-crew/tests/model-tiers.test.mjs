#!/usr/bin/env node
/**
 * Bậc model `--tier`: một chữ đổi ra tên model còn sống hoặc `--effort`.
 *
 * Ca đáng giữ nhất là ca KHÔNG chọn: list thiếu model của bậc thì phải lỗi, không
 * được trượt sang model bậc khác. Một `light` ra `flash-high` vẫn chạy được, nên
 * không ai thấy giá và chất lượng đã đổi.
 *
 * Run: node plugins/agent-crew/tests/model-tiers.test.mjs
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  DEFAULT_TIER_MAP, TIERS, TierError, bumpTier, normalizeModelTiers, parseAgyModels, pickModel, resolveTier,
} from "../scripts/lib/model-tiers.mjs";
import { loadCrewConfig } from "../scripts/lib/crew-config.mjs";
import { makeChecker, tmpWorkspace } from "./helpers.mjs";

const t = makeChecker("model-tiers");

/** `agy models` đo ngày 06/11. Không có Gemini Pro, không có flash-lite. */
const LIST_1106 = [
  "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
  "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium",
];
const anti = (tier, names = LIST_1106, extra = {}) => resolveTier({ worker: "antigravity", tier, liveAgyModels: names, ...extra });
const err = (fn) => {
  try { fn(); return "no throw"; } catch (e) { return e instanceof TierError ? e.message : `wrong error: ${e.message}`; }
};

// --- Anti headless, list 06/11 ---------------------------------------------
t.check("light → flash-low (flash-lite chưa có)", anti("light").model, "gemini-3.8-flash-low");
t.check("standard → flash-medium", anti("standard").model, "gemini-3.8-flash-medium");
t.check("deep → flash-high (không có Pro: regex thứ 3 của chính bậc deep)", anti("deep").model, "gemini-3.8-flash-high");
t.check("claude → claude-sonnet-4-6", anti("claude").model, "claude-sonnet-4-6");
t.check("claude-max → claude-opus-4-6-thinking", anti("claude-max").model, "claude-opus-4-6-thinking");
t.check("...và không ghi effort cho Anti", `${anti("claude").effort}`, "null");
t.check("code ở Anti → lỗi chỉ Codex", err(() => anti("code")), "tier code chỉ cho Codex");
t.check("gpt-oss không vào bậc nào", TIERS.some((tier) => { try { return /gpt-oss/.test(anti(tier).model); } catch { return false; } }), false);

// --- không fallback chéo bậc ------------------------------------------------
{
  const noLow = ["gemini-3.8-flash-high", "gemini-3.8-flash-medium"];
  const msg = err(() => anti("light", noLow));
  t.check("list không có flash-low/lite → light lỗi", msg.startsWith("tier light không khớp"), true);
  t.check("...không ra flash-medium hay high", /flash-(medium|high)$/.test(String(msg.split("\n")[0])), false);
  t.check("...và lỗi liệt kê tên còn sống", msg.includes("gemini-3.8-flash-high, gemini-3.8-flash-medium"), true);
  t.check("...gợi --model tay hoặc modelTiers", /--model <tên>/.test(msg) && /modelTiers/.test(msg), true);
  t.check("list rỗng → lỗi, không throw kiểu khác", err(() => anti("standard", [])).startsWith("tier standard không khớp"), true);
  // Regex neo: "flash" không được khớp "flash-lite" khi bảng ghi đè dùng regex lỏng.
  t.check("regex neo: flash-medium không khớp flash-medium-preview", pickModel(DEFAULT_TIER_MAP.standard.agy, ["gemini-3.8-flash-medium-preview"]), "null");
}

// --- chọn bản cao nhất trong một regex, regex trước thắng -----------------------
t.check("hai bản flash-medium → lấy bản cao", anti("standard", ["gemini-3.5-flash-medium", "gemini-3.10-flash-medium", "gemini-3.8-flash-medium"]).model, "gemini-3.10-flash-medium");
t.check("có Pro thì deep ra Pro, không ra flash-high", anti("deep", ["gemini-3.8-flash-high", "gemini-4.0-pro-high"]).model, "gemini-4.0-pro-high");
t.check("flash-lite thắng flash-low (regex trước)", anti("light", ["gemini-3.8-flash-low", "gemini-3.1-flash-lite"]).model, "gemini-3.1-flash-lite");
t.check("claude: bản 4-7 thắng 4-6", anti("claude", ["claude-sonnet-4-6", "claude-sonnet-4-7"]).model, "claude-sonnet-4-7");
t.check("claude-max nhận cả opus không -thinking", anti("claude-max", ["claude-opus-5-0"]).model, "claude-opus-5-0");

// --- Anti app, Codex, Claude ------------------------------------------------
t.check("anti app standard → flash", anti("standard", [], { transport: "app" }).model, "flash");
t.check("anti app deep → pro", anti("deep", [], { transport: "app" }).model, "pro");
t.check("anti app claude → lỗi agentapi", err(() => anti("claude", [], { transport: "app" })).includes("agentapi chỉ nhận flash_lite|flash|pro"), true);
t.check("anti app claude-max → lỗi", err(() => anti("claude-max", [], { transport: "app" })).startsWith("tier claude-max không dùng được ở Anti app"), true);
const codex = (tier) => resolveTier({ worker: "codex", tier });
t.check("codex light/standard/deep/code → effort", ["light", "standard", "deep", "code"].map((x) => codex(x).effort).join(","), "low,low,medium,high");
t.check("...model Codex lấy từ config máy, không có thì null", `${resolveTier({ worker: "codex", tier: "code", codexModel: "gpt-x" }).model}|${codex("code").model}`, "gpt-x|null");
t.check("codex claude → lỗi", err(() => codex("claude")).startsWith("tier claude chỉ cho Anti headless"), true);
t.check("codex claude-max → lỗi", err(() => codex("claude-max")).startsWith("tier claude-max chỉ cho Anti headless"), true);
t.check("job Claude không nhận --tier", err(() => resolveTier({ worker: "claude", tier: "deep" })).includes("job Claude không nhận --tier"), true);
t.check("tier lạ → lỗi liệt kê bậc", err(() => anti("huge")).includes("light|standard|deep|code|claude|claude-max"), true);
t.check("liveAgyModels null chỉ kiểm, không chọn", `${anti("standard", null).model}`, "null");
t.check("...nhưng vẫn chặn bậc sai worker", err(() => anti("code", null)), "tier code chỉ cho Codex");

// --- nâng bậc ---------------------------------------------------------------
t.check("bumpTier light → standard", bumpTier("light"), "standard");
t.check("bumpTier standard → deep", bumpTier("standard"), "deep");
t.check("bumpTier deep đứng yên (không tự sang claude)", bumpTier("deep"), "deep");
t.check("bumpTier code/claude/claude-max đứng yên", ["code", "claude", "claude-max"].map(bumpTier).join(","), "code,claude,claude-max");

// --- modelTiers ghi đè ------------------------------------------------------
{
  const fail = (msg) => { throw new Error(msg); };
  const over = normalizeModelTiers({ standard: { agy: ["^gemini-[\\d.]+-flash-high$"] }, deep: { effort: "high" } }, fail);
  t.check("ghi đè regex của một bậc", anti("standard", LIST_1106, { overrides: over }).model, "gemini-3.8-flash-high");
  t.check("...các trường khác giữ mặc định", anti("standard", [], { transport: "app", overrides: over }).model, "flash");
  t.check("ghi đè effort Codex", resolveTier({ worker: "codex", tier: "deep", overrides: over }).effort, "high");
  const bad = (value) => { try { normalizeModelTiers(value, fail); return "no throw"; } catch (e) { return e.message; } };
  t.check("tier lạ trong modelTiers bị từ chối", bad({ huge: {} }).startsWith('modelTiers: tier lạ "huge"'), true);
  t.check("khoá lạ trong một bậc bị từ chối", bad({ light: { model: "x" } }).includes("khoá lạ model"), true);
  t.check("regex không neo bị từ chối", bad({ light: { agy: ["flash"] } }).includes("neo ^...$"), true);
  t.check("regex hỏng bị từ chối", bad({ light: { agy: ["^(flash$"] } }).includes("không phải regex hợp lệ"), true);
  t.check("bậc app lạ bị từ chối", bad({ light: { app: "ultra" } }).includes("flash_lite|flash|pro|inherit"), true);
  t.check("effort lạ bị từ chối", bad({ code: { effort: "max" } }).includes("low|medium|high"), true);
}

// --- crew.config.json nạp modelTiers ------------------------------------------
{
  const ws = tmpWorkspace("tiers-config-");
  const raw = JSON.parse(JSON.stringify(loadCrewConfig(ws).layout));
  writeFileSync(join(ws, "crew.config.json"), JSON.stringify({ ...raw, modelTiers: { light: { agy: ["^gemini-[\\d.]+-flash-medium$"] } } }));
  t.check("config có modelTiers được nạp", loadCrewConfig(ws).modelTiers.light.agy[0], "^gemini-[\\d.]+-flash-medium$");
  writeFileSync(join(ws, "crew.config.json"), JSON.stringify({ ...raw, modelTiers: { light: { agy: ["flash"] } } }));
  let msg = "no throw";
  try { loadCrewConfig(ws); } catch (e) { msg = e.message; }
  t.check("config có regex không neo → lỗi lúc nạp, kèm tên file", msg.startsWith("crew.config.json: modelTiers.light.agy[0]"), true);
  t.check("không khai modelTiers → rỗng", JSON.stringify(loadCrewConfig(tmpWorkspace("tiers-none-")).modelTiers), "{}");
}

t.check("parseAgyModels bỏ dòng thông báo", parseAgyModels("Fetching available models...\ngemini-3.8-flash-low\tGemini\n").join(","), "gemini-3.8-flash-low");

process.exit(t.finish() ? 0 : 1);
