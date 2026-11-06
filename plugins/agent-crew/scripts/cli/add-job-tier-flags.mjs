/**
 * `crew add-job --tier <bậc>` và `--bump-from <seq>`: đổi một chữ ra model/effort
 * mà job sẽ chạy, và ghi lý do vào notes của job.
 *
 * Cờ tay (`--model` cho Anti, `--effort` cho Codex) vẫn thắng `--tier`: có lúc
 * dispatcher biết hơn bảng. Khi đó bậc vẫn được kiểm có hợp worker/transport
 * không và vẫn ghi sổ, kèm một note nói cờ tay đã thắng.
 */
import { loadCrewConfig } from "../lib/crew-config.mjs";
import { bumpTier, codexConfigModel, liveAgyModels, resolveTier } from "../lib/model-tiers.mjs";
import { CliError } from "./run-commands.mjs";

/**
 * → `{tier, model?, effort?, notes}`. `model`/`effort` chỉ có khi bậc đã chọn
 * chúng; vắng thì add-job dùng cờ tay như cũ. `fetchAgyModels` thay được trong test.
 */
export function tierFields({ worker, flags, manifest, fetchAgyModels = liveAgyModels }) {
  const notes = [];
  let tier = flags.tier ?? null;
  const bumpFrom = flags["bump-from"];
  if (bumpFrom !== undefined) {
    if (tier) throw new CliError("--tier và --bump-from loại nhau: --bump-from tự tính bậc từ job trước");
    const src = manifest.jobs.find((j) => String(j.seq) === String(bumpFrom));
    if (!src) throw new CliError(`--bump-from: sổ không có job ${bumpFrom}`);
    if (!src.tier) throw new CliError(`--bump-from: job ${bumpFrom} không ghi tier (chọn model/effort tay) — truyền --tier`);
    tier = bumpTier(src.tier);
    notes.push(tier === src.tier
      ? `nâng bậc từ job ${bumpFrom}: ${src.tier} không có bậc trên, giữ nguyên`
      : `nâng bậc từ job ${bumpFrom} (${src.tier} → ${tier})`);
  }
  const manualFlag = worker === "codex" ? "effort" : "model";
  const manual = flags[manualFlag];
  if (!tier) {
    if (!manual) {
      throw new CliError(worker === "codex"
        ? "job Codex cần --tier (light|standard|deep|code) hoặc --effort (low|medium|high)"
        : worker === "claude"
          ? "thiếu --model (job Claude dùng model của phiên)"
          : "thiếu --tier (light|standard|deep|claude|claude-max) hoặc --model (crew doctor in tên còn sống)");
    }
    return { tier: null, notes };
  }
  const transport = flags.transport ?? "headless";
  const { modelTiers } = loadCrewConfig(manifest.workspace);
  const needNames = worker === "antigravity" && transport === "headless" && !manual;
  const resolved = resolveTier({
    worker, transport, tier, overrides: modelTiers,
    liveAgyModels: needNames ? fetchAgyModels() : null,
    codexModel: worker === "codex" ? codexConfigModel() : null,
  });
  if (manual) {
    notes.push(`--${manualFlag} tay thắng --tier ${tier}`);
    return { tier, notes };
  }
  return {
    tier,
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.effort ? { effort: resolved.effort } : {}),
    notes,
  };
}
