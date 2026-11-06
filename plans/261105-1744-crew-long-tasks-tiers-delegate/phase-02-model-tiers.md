---
phase: 2
title: "Bậc model --tier"
status: completed
priority: P1
effort: "5h"
dependencies: []
---

# Phase 2: Bậc model `--tier`

## Goal

Claude chọn một chữ (`light|standard|deep|code|claude|claude-max`); crew tự đổi ra tên model còn sống hoặc `--effort`, ghi cả bậc lẫn model vào sổ.

## Context

- Hiện `add-job` bắt `--model` (Anti/Claude) hoặc `--effort` (Codex): `plugins/agent-crew/scripts/cli/run-commands.mjs:105-120`.
- Bảng bậc theo loại việc đã có ở `references/routing-table.md` mục `## Model` nhưng cố ý không ghi tên; Claude phải tự ghép từ `crew doctor`.
- `parseAgyModels`, `codexConfigModel` có sẵn ở `plugins/agent-crew/scripts/cli/setup.mjs:30,35`.
- `agy models` ngày 06/11: `gemini-3.8-flash-{high,medium,low}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. Không có Gemini Pro.

## Bảng bậc mặc định

| Tier | Loại việc (routing-table) | Anti headless (regex ưu tiên trên `agy models`) | Anti app | Codex |
|---|---|---|---|---|
| `light` | điền mẫu, chuẩn hoá, readback | `/^gemini-[\d.]+-flash-lite$/`, `/^gemini-[\d.]+-flash-low$/` | `flash_lite` | `--effort low` |
| `standard` | thi hành skill nhiều case, crawl + phân loại | `/^gemini-[\d.]+-flash-medium$/` | `flash` | `--effort low` |
| `deep` | suy luận chưa có mẫu | `/^gemini-[\d.]+-pro-high$/`, `/^gemini-[\d.]+-pro$/`, `/^gemini-[\d.]+-flash-high$/` | `pro` | `--effort medium` |
| `code` | code/pipeline nhiều bước | lỗi: "tier code chỉ cho Codex" | lỗi | `--effort high` |
| `claude` | phán đoán sâu Claude muốn giao đi để đỡ token Claude; viết/tổng hợp cần giọng tốt | `/^claude-sonnet-[\d-]+$/` | lỗi: "agentapi chỉ nhận flash_lite\|flash\|pro" | lỗi |
| `claude-max` | như trên, việc khó nhất (suy luận nhiều bước, review thiết kế) | `/^claude-opus-[\d-]+(-thinking)?$/` | lỗi | lỗi |

<!-- Updated: owner 2026-11-06 - thêm bậc Claude chạy qua quota Antigravity -->
Bậc `claude`/`claude-max` chạy model Claude **bằng quota Antigravity**, không tốn token Claude của owner. Chỉ Anti headless. Không nằm trong chuỗi `bumpTier` (`deep` không tự nâng lên `claude`): đổi nhà cung cấp là quyết định có chủ ý, ghi bằng `--tier` tay. Với list 06/11: `claude` → `claude-sonnet-4-6`, `claude-max` → `claude-opus-4-6-thinking`. So phiên bản: tách số trong tên (`4-6` → 4.6) rồi lấy cao nhất.

<!-- Updated: Red Team 2026-11-06 - neo regex, không fallback chéo bậc -->
Luật chọn: mọi regex neo đầu-cuối; trong một regex khớp nhiều model thì lấy **số phiên bản cao nhất**; regex đi lần lượt, regex đầu có khớp thì dừng. **Không** có fallback sang model của bậc khác: cả chuỗi regex không khớp → lỗi liệt kê tên sống, gợi `--model` tay hoặc `modelTiers` trong config. Với list 06/11, `deep` ra `gemini-3.8-flash-high` (không có Pro) — đó là regex thứ 3 của chính bậc `deep`, không phải fallback chéo.

Bậc `light`–`deep` chỉ khớp Gemini; Claude chỉ qua bậc `claude`/`claude-max`; GPT-OSS không vào bảng. Codex: `-m` lấy từ `~/.codex/config.toml` như hiện nay.

## Files to Create / Modify

- Create: `plugins/agent-crew/scripts/lib/model-tiers.mjs` — `TIERS`, `DEFAULT_TIER_MAP`, `resolveTier({worker, transport, tier, liveAgyModels, codexModel, overrides})` → `{tier, model, effort}`; `bumpTier(tier)` (`light→standard→deep`; `deep`, `code`, `claude`, `claude-max` đứng yên). Không khớp model sống → lỗi liệt kê tên sống.
- Modify: `plugins/agent-crew/scripts/lib/crew-config.mjs` — khoá tuỳ chọn `modelTiers` (ghi đè regex/bậc app/effort theo tier), validate như `routingTriggers`.
- Modify: `plugins/agent-crew/scripts/cli/run-commands.mjs` — `add-job` nhận `--tier`, `--bump-from <seq>`:
  - Cần `--tier` **hoặc** `--model`/`--effort` như cũ; cờ tay thắng `--tier` (ghi note).
  - `--bump-from N`: tier = `bumpTier(job N.tier)`, note "nâng bậc từ job N".
  - Chỉ gọi `agy models` khi worker anti + headless (timeout 30s như doctor); lỗi gọi → báo rõ, gợi `--model` tay.
- Modify: `plugins/agent-crew/scripts/crew-manifest.mjs` — `addJob` ghi `tier` (null khi không dùng).
- Modify: `plugins/agent-crew/scripts/cli/setup.mjs` — `crew doctor` in bảng tier → model đang resolve ra.
- Modify docs: `SKILL.md` Bước 4 (bảng cờ: `--tier` là cách mặc định; `--model` để ép tay), `references/routing-table.md` mục Model (thêm cột tier, giữ luật "nâng đúng 1 bậc" và trỏ `--bump-from`).
- Create: `plugins/agent-crew/tests/model-tiers.test.mjs`.
- Modify: `plugins/agent-crew/tests/cli.test.mjs` — add-job `--tier`, `--bump-from`, lỗi tier code cho anti.

## Tasks & Steps

0. [x] **Probe** (tay): `agy -p --output-format json --model claude-sonnet-4-6 "ghi 'ok' vào /tmp/x"` và tương tự `claude-opus-4-6-thinking`: chạy được headless không, JSON có `usage`/`conversation_id` như model Gemini không, tốn credit Antigravity bao nhiêu so với `flash-medium` (xem trang quota trong app). Ghi vào `plugins/agent-crew/docs/transport-measurements.md`. Probe âm → bỏ 2 bậc Claude khỏi phase, báo owner.
1. [x] Viết `model-tiers.mjs` + test thuần (thêm: `claude`/`claude-max` resolve đúng; Anti app hoặc Codex với 2 bậc này → lỗi; `bumpTier("deep")` vẫn là `deep`) (fixture list 06/11; list không có flash-low → `light` báo lỗi, **không** ra flash-medium/high; list có 2 phiên bản flash-medium → lấy bản cao; list rỗng).
2. [x] Thêm `modelTiers` vào config loader + test khoá lạ.
3. [x] Nối `--tier`/`--bump-from` vào `add-job`; manifest ghi `tier`.
4. [x] Job resume: tier vẫn resolve và ghi sổ, nhưng `crew run` không truyền `--model` khi có `--resume` (giữ hành vi `run-commands.mjs:181-184`). Thêm test.
5. [x] `crew doctor` in bảng tier.
6. [x] Sửa `SKILL.md` + `routing-table.md`.
7. [x] Bump `plugin.json` bản vá (2.0.5), owner update plugin, `diff -rq` bản cài với source rỗng.

## Verification

- `node plugins/agent-crew/tests/model-tiers.test.mjs` và `node plugins/agent-crew/tests/run.mjs` xanh.
- Tay: `crew add-job "$MP" --worker anti --role assist --tier standard --title t` → sổ có `"tier":"standard","model":"gemini-3.8-flash-medium"`.
- Tay: `crew doctor` in đủ 4 dòng tier.

## Risks / Rollback

- Nhà cung cấp đổi lược đặt tên → regex trượt: lỗi liệt kê tên sống, repo ghi đè qua `modelTiers` không cần sửa code.
- `agy models` chậm làm `add-job` chậm ~vài giây: chấp nhận; chỉ gọi cho anti headless.

## Ghi chú khi cook (2026-11-06)

- Probe bước 0 dương: `claude-sonnet-4-6`, `claude-opus-4-6-thinking` chạy headless, JSON cùng hình dạng Gemini (ghi ở `docs/transport-measurements.md`). Credit Antigravity mỗi lượt chưa đo được từ CLI. Lưu ý: `agy -p --output-format json ...` bị agy từ chối; `-p` phải đứng cuối.
- Codex qua `--tier` ghi `model` = model trong `~/.codex/config.toml` (để sổ đo được model đã chạy, `crew run` truyền `-m` từ sổ). `codexConfigModel`, `parseAgyModels` dời sang `scripts/lib/model-tiers.mjs`, `setup.mjs` re-export.
- Logic cờ `--tier`/`--bump-from` nằm ở `scripts/cli/add-job-tier-flags.mjs` (giữ `run-commands.mjs` gọn). Cờ tay thắng thì vẫn kiểm bậc hợp worker/transport, không gọi `agy models`.
- `crew doctor` in 6 dòng tier (thêm `claude`, `claude-max`), và bỏ dòng "codex app" còn sót từ phase 1.
- Bump 2.0.5, cài plugin bằng `claude plugin marketplace update` + `claude plugin update`, `diff -rq` rỗng.

