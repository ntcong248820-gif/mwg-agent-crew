---
title: "agent-crew: task dài có handoff, bậc model, giao việc chủ động, Codex chỉ headless"
description: "Cho Codex/Anti tự quản task dài qua chuỗi lát 30 phút có handoff, Claude chọn bậc model bằng một chữ, gate giao việc mạnh tay ở repo chọn, bỏ Codex app."
status: in-progress
priority: P1
effort: "~4.5d"
branch: feat/crew-long-tasks-tiers-delegate
tags: [agent-crew, adapter, routing, docs]
blockedBy: []
blocks: []
created: 2026-11-06
---

# agent-crew: task dài, bậc model, giao việc chủ động, Codex chỉ headless

## Overview

Owner muốn đẩy bớt việc của Claude sang Codex/Anti để tiết kiệm token. Bốn chỗ cản:

1. Trần 30 phút/job cứng (`crew-guards.mjs:20`), hết giờ là job bị kill, không có handoff → Codex không tự quản nguyên task được.
2. Claude chỉ dispatch khi owner gõ skill hoặc `@anti/@codex`; gate im ở mọi repo chưa opt-in và Bước 0 cấm giao 1 đầu việc.
3. Chọn model = Claude tự chạy `crew doctor` rồi ghép tên; tên chết từng giết job (đo 16/10).
4. Codex `app` không chat tiếp, không xem live, không watchdog → không đáng giữ.

Kèm 2 chỗ doc lệch code: lối thoát 30m qua `app` (`cost-gate.md:42`) và hướng dẫn `codex resume <id>` gõ tay (`dispatch-playbook.md:64,304`, `routing-table.md:70`).

## Scope Challenge

- Existing code: resume theo `conversationId` ở cả 4 bề mặt (đã đo 23/09); idle watchdog Codex 2m; báo im Anti app; bảng bậc trong `routing-table.md`; routing gate + `routingTriggers`; `parseAgyModels` ở `scripts/cli/setup.mjs`.
- Requested scope: A chuỗi lát + handoff, B giao việc chủ động, C chọn model/effort, D bỏ Codex app + sửa doc. Giao đủ, không cắt.
- Complexity: ~22 file sửa, 4 module mới (`model-tiers`, `chain-runner`, `handoff-check`, `default-routing-triggers`). 5 phase, chạy tuần tự (cùng đụng `SKILL.md`, `crew-manifest.mjs`).
- Selected mode: HOLD SCOPE.

## Quyết định owner (chốt 06/11)

| # | Câu hỏi | Chốt |
|---|---|---|
| 1 | Budget mặc định một chuỗi | **4h**, tối đa 8 lát |
| 2 | Chế độ giao việc chủ động bật ở đâu | **Chỉ repo khai** `delegate: "aggressive"` trong `crew.config.json` |
| 3 | Ngưỡng sàn để giao | **~10 tool call hoặc ≥3 file** |
| 4 | Codex app | **Bỏ hẳn** ở đường dispatch; code nhánh app giữ lại không reachable, xoá ở plan sau |
| 5 | Chặn chuỗi tự kéo dài (red-team) | **Kiểm cơ học handoff + Claude đọc checkpoint mỗi 2 lát** (exit 4) |
| 6 | Anti chạy model Claude qua quota Antigravity | **Có**: bậc `claude` (Sonnet) và `claude-max` (Opus thinking), chỉ Anti headless, có probe trước |

Trần 30m **mỗi lát** giữ nguyên (an toàn quota, token Google Workspace sống 1h). "Không timeout" đạt bằng chuỗi lát, không bằng gỡ trần.

## Phases

| # | Phase | Phụ thuộc | Effort | Status |
|---|-------|-----------|--------|--------|
| 1 | [Codex chỉ headless + sửa doc lệch](./phase-01-codex-headless-only-and-doc-fixes.md) | — | 3h | Completed |
| 2 | [Bậc model `--tier`](./phase-02-model-tiers.md) | — | 5h | Completed |
| 3 | [Hạn mềm + handoff (`Status: CONTINUE`)](./phase-03-soft-deadline-and-handoff.md) | — | 1d | Pending |
| 4 | [Chuỗi lát `--chain` có budget](./phase-04-chain-runner.md) | 3 | 1.5d | Pending |
| 5 | [Giao việc chủ động + release 2.1.0](./phase-05-proactive-delegation-and-release.md) | 1–4 | 5h | Pending |

Thứ tự cook: 1 → 2 → 3 → 4 → 5. Không song song: phase nào cũng sửa `SKILL.md`.

**Release mỗi phase.** `SKILL.md`/hook chạy từ bản cài trong `~/.claude/plugins/cache/agent-crew-marketplace/agent-crew/<version>`, CLI chạy thẳng source qua shim. Mỗi phase kết thúc bằng bump bản vá (2.0.4 → 2.0.7) + owner update plugin; phase 5 lên 2.1.0.

## Acceptance (cả plan)

- [ ] `node plugins/agent-crew/tests/run.mjs` xanh, gồm test mới của từng phase.
- [x] `crew add-job --worker codex --transport app ...` bị từ chối kèm hướng dẫn headless.
- [x] `crew add-job --tier deep --worker anti ...` ghi đúng model còn sống từ `agy models`; tên chết → lỗi liệt kê tên sống.
- [ ] Một job Codex headless bị cắt ở hard timeout vẫn để lại evidence có `## Handoff` + `Status: CONTINUE` (lượt cứu 3m); `resolveRun` chạy đúng 1 lần.
- [ ] `crew run codex --chain` với fake-codex: 2 lát CONTINUE → exit 4 checkpoint → gọi lại → DONE; budget đếm tiếp từ sổ; collect PASS; `addJob` và `runFor` không tính lát vào MAX_JOBS; tối đa 16 lát/run.
- [ ] Chuỗi dừng exit 3 khi handoff không tiến triển, có chữ đòi quyền, hoặc `resumeMismatch`.
- [ ] Repo có `delegate: "aggressive"`: prompt một đầu việc code khớp trigger → gate in khối "Mặc định giao"; repo không khai → hành vi cũ.
- [x] `grep -rn "chuyển .transport: app" plugins/agent-crew/skills` rỗng; không còn chỗ nào bảo gõ tay `codex resume <id>` ngoài mục lịch sử.
- [ ] Sau mỗi phase, plugin cài khớp source (`diff -rq` rỗng); cuối cùng là 2.1.0.

## Non-goals

- Không gỡ trần 30m/lát, không thêm budget theo token (ghi usage thôi).
- Không xoá code `codexRunApp` trong plan này.
- Không đụng `~/.claude/CLAUDE.md` của owner (chỉ đề xuất ở handoff).
- Không gate theo ước lượng tool call bằng code — ngưỡng là luật văn cho Claude.

## Rủi ro chính

| Rủi ro | Giảm thiểu |
|---|---|
| Worker phớt lờ hạn mềm | Codex headless và Anti app: lượt cứu handoff 3m ở hard timeout. **Anti headless: chỉ có lượt cứu nếu probe dương** — chưa đo, có thể không có |
| `agy` tự timeout có trả `conversation_id` không — chưa đo | Probe là bước 1 phase 3 và là **cổng**: âm thì Anti headless không có lượt cứu, không được dùng `--chain` cho Anti headless tới khi có đường khác |
| Chuỗi đốt quota / worker tự kéo dài | Budget 4h ghi sổ (chạy lại không reset), 8 lát, 16 lát/run, kiểm cơ học handoff, checkpoint Claude mỗi 2 lát, cấm `--workspace-cli` trong chuỗi |
| Handoff nhiễm chỉ thị đi sang lát sau | Brief lát kế do dispatcher viết; kiểm chữ đòi quyền; checkpoint Claude. Lát resume cùng thread nên không chặn hẳn được — chấp nhận |
| Gate aggressive giao oan việc nhỏ | Ngưỡng ~10 tool call / 3 file trong lời gate; log `routingLog` để chấm |
| Run cũ có job Codex app đang pending | Phase 1: collect/reconcile vẫn đọc được; chỉ chặn ở dispatch mới |

## Validation Log

### Session 1 — 2026-11-06

- Quyết định owner: 4 câu ở mục "Quyết định owner" (hỏi trước khi viết phase).
- `ak plan validate` → OK.

### Verification Results

- Claims checked: 14 (file:line dẫn trong 5 phase)
- Verified: 14 | Failed: 0 | Unverified: 1
- Tier: Full (soát tay, không subagent)
- Đã sửa trong lúc soát: đường `docs/transport-measurements.md` → `plugins/agent-crew/docs/transport-measurements.md`.
- Unverified: `agy` tự timeout có trả `conversation_id` không → thành bước probe 1 của phase 3.

### Whole-Plan Consistency Sweep

- Phase 1 sửa `cost-gate.md:42` tạm ghi "nối job `--resume`"; phase 4 thay bằng `--chain` — đã ghi ở cả 2 phase.
- `SKILL.md` bị 5 phase cùng sửa → chạy tuần tự, đã ghi ở bảng Phases.
- Red-team chưa chạy (để owner quyết, tốn token).

## Red Team Review

### Session — 2026-11-06
**Findings:** 16 sau khi gộp từ 20 (15 accepted, 1 rejected). 3 reviewer Sonnet: Security Adversary, Failure Mode Analyst, Assumption Destroyer.
**Severity breakdown:** 7 Critical, 5 High, 4 Medium

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | `runFor` (`crew-session.mjs:64`) cũng đếm MAX_JOBS; không trần tổng lát/run | Critical | Accept | Phase 4 |
| 2 | Doc phase 1–4 trơ tới release vì skill/hook chạy từ bản cài | Critical | Accept | Phase 1–5, plan |
| 3 | Bảng rủi ro nói lượt cứu "chắc" dù Anti headless phụ thuộc probe | Critical | Accept | plan, Phase 3 |
| 4 | Chuyển SIGTERM không được nếu gọi lát bằng `spawnSync` | Critical | Accept | Phase 4 |
| 5 | Lượt cứu không có seam trong `finish()` → resolve 2 lần / mất cứu | Critical | Accept | Phase 3 |
| 6 | `CONTINUE` tự kéo dài 4h; handoff đi thẳng vào lát sau | Critical | Accept (modified: owner chọn kiểm cơ học + checkpoint mỗi 2 lát) | Phase 4 |
| 7 | `crew.config.json` ghi được trong sandbox → bật `delegate` | Critical | Reject: lỗ có sẵn cùng loại `CLAUDE.md`/`routingTriggers`; `delegate` chỉ đổi lời gợi ý; `crew-scope.mjs:117-121` bắt lúc collect | — (ghi chú Phase 5) |
| 8 | Regex fallback chồng bậc, `light` có thể ra `flash-high` | High | Accept | Phase 2 |
| 9 | Budget chuỗi chỉ trong tiến trình, chạy lại là reset | High | Accept | Phase 4 |
| 10 | Lát sau dùng `filesMayModify` cũ → SCOPE_VIOLATION | High | Accept | Phase 4 |
| 11 | Lời gate aggressive mất "không phải lệnh"; gate chỉ xét lúc gửi prompt | High | Accept | Phase 5 |
| 12 | Lượt cứu cho thêm 5m sống; job <10m không biết 4 mục handoff | High | Accept | Phase 3 |
| 13 | Mỗi lát mint token Workspace mới | Medium | Accept (v1 cấm `--chain` + `--workspace-cli`) | Phase 4 |
| 14 | Chuỗi không kiểm `resumeMismatch` | Medium | Accept | Phase 4 |
| 15 | `crew-digest.mjs:112-120` lọc pending/running, grep `done_with_concerns` không bắt | Medium | Accept | Phase 3 |
| 16 | Chặn `--mode app` phải vô điều kiện, không lồng nhánh manifest | Medium | Accept | Phase 1 |

### Whole-Plan Consistency Sweep

- Delta: lượt cứu 5m → 3m; release mỗi phase (2.0.4–2.0.7, 2.1.0); exit mã mới `4`; trần 16 lát/run; `crew-session.mjs` vào phase 4; `handoff-check.mjs` mới; effort phase 4 1d → 1.5d.
- Đã soát `plan.md` + 5 phase: không còn "5m" cho lượt cứu, không còn "đường chắc", không còn bump thẳng 2.0.3 → 2.1.0, `MAX_JOBS` nhắc cả 2 chỗ.
- Mâu thuẫn còn lại: không.

## Câu hỏi còn mở

- Có cập nhật luật "Research → Antigravity" trong CLAUDE.md của owner sang `--tier standard` thay vì tên model cứng không? (Ngoài repo, cần owner ok.)
