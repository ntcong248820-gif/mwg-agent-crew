---
phase: 3
title: "Hạn mềm + handoff (Status: CONTINUE)"
status: completed
priority: P1
effort: "1d"
dependencies: []
---

# Phase 3: Hạn mềm + handoff (`Status: CONTINUE`)

## Goal

Job sắp hết giờ thì worker tự dừng và ghi handoff; worker không tự dừng thì adapter cứu bằng một lượt handoff trên cùng thread. Chưa xong việc mà còn handoff thì ra trạng thái mới `continue`, không phải `failed`.

## Context

- Hợp đồng worker được nối tự động ở `appendWorkerContract` (`plugins/agent-crew/scripts/crew-guards.mjs:492`); dòng Status ở `STATUS_LINE` (`crew-guards.mjs:439`).
- Parser status: `readWorkerStatus` (`crew-guards.mjs:360`), `STATUS_VERDICT` (`crew-collect.mjs:189`), tập PASS (`crew-collect.mjs:69`, `crew-reconcile.mjs:47`).
- Kill: Codex headless `setTimeout(kill("exceeded …"))` ở `codex-run.mjs:698`, `threadId` ghi sổ ngay khi có (comment ở `codex-run.mjs:712`). Anti app: vòng poll có `deadline` (`anti-run.mjs:318,390`). Anti headless: `spawnSync` + `agy --print-timeout` (`anti-run.mjs:80-96`), `conversation_id` chỉ có trong JSON cuối (`anti-run.mjs:163`).
- Đo 07/10: chen tin vào conversation Anti app khi worker đang chạy thì app giữ tin tới hết lượt.

## Thiết kế

**Hạn mềm.** `softDeadline = start + timeout − max(5m, 15% timeout)`; chỉ khi `timeout ≥ 10m`. Adapter nối thêm `HANDOFF_LINE`:
> Hạn mềm HH:MM (giờ máy, xem bằng `date`). Kiểm giờ sau mỗi bước lớn; còn < 5 phút thì không mở bước lớn mới. Tới hạn mềm mà chưa xong: dừng, ghi `## Handoff` gồm `### Đã xong`, `### Đang dở`, `### Bước kế tiếp`, `### File đã đụng`, rồi dòng cuối `Status: CONTINUE`.

**Trạng thái.** Thêm `CONTINUE` vào `WORKER_STATUS` → job status `continue`. Collect: `continue` không nằm trong PASS; verdict `CONTINUE` (nhóm exit 1) kèm gợi ý "bắn job `--resume` hoặc dùng `--chain`". Thiếu mục `## Handoff` → cờ `HANDOFF THIẾU`.

**Lượt cứu handoff** (chỉ khi hết hard timeout, evidence chưa có Status, có thread id):

**Seam trong `codex-run.mjs`.** `finish()` hiện chạy một lần từ `child.on("close")`, đặt `settled = true` rồi `judgeJob` → `resolveRun` (`codex-run.mjs:596-691`, các biến `settled`/`killedFor`/`exited` dùng chung closure). Lượt cứu là hàm async riêng `runHandoffRescue({threadId, evidenceAbs, sandboxMode, workspace})` có closure state riêng (watchdog, kill riêng), được `await` trong `finish()` **trước** khi đặt `settled`/gọi `judgeJob`. Test bắt buộc: `resolveRun` chạy đúng 1 lần khi có lượt cứu, cả khi lượt cứu tự hết giờ.

| Bề mặt | Cách | Trần |
|---|---|---|
| Codex headless | `codex exec resume <threadId>` với prompt `HANDOFF_RESCUE`, cùng `sandboxMode` job gốc, **không** mint token Workspace | 3m, idle 1m |
| Anti app | đợi conversation `done` (tối đa 3m), rồi `agentapi send-message` prompt cứu, poll evidence | 3m |
| Anti headless | chỉ khi probe bước 1 cho thấy `agy` tự timeout vẫn trả `conversation_id`. **Probe âm = Anti headless không có lượt cứu** (cổng quyết định, không phải chú thích): chỉ còn hạn mềm; doc và bảng rủi ro `plan.md` ghi rõ | 3m |

<!-- Updated: Red Team 2026-11-06 - lượt cứu 3m, không cấp quyền mới; probe âm là cổng -->

Prompt cứu (cố định, tự đủ nghĩa — job dưới 10m chưa từng nhận `HANDOFF_LINE`): "Hết giờ. Không làm tiếp, không chạy lệnh nào khác. Ghi ngay vào <evidence> mục `## Handoff` gồm `### Đã xong`, `### Đang dở`, `### Bước kế tiếp`, `### File đã đụng`, rồi dòng cuối `Status: CONTINUE`." Ghi vào **cùng** evidence của job (vẫn là job đó). Sổ thêm `handoffRescue: {ran, ok, durationSec}`. Không cứu khi kill vì idle (process treo, cứu vô ích) hay SIGTERM của dispatcher.

## Files to Create / Modify

- Modify: `plugins/agent-crew/scripts/crew-guards.mjs` — `WORKER_STATUS.CONTINUE`, regex `readWorkerStatus`, `handoffLine(softDeadline)`, `HANDOFF_RESCUE_PROMPT`; `appendWorkerContract` nhận `softDeadline`.
- Modify: `plugins/agent-crew/scripts/codex-run.mjs` — tính hạn mềm, truyền vào contract; nhánh kill "exceeded" → lượt cứu; map status `continue`.
- Modify: `plugins/agent-crew/scripts/anti-run.mjs` — hạn mềm cho cả 2 transport; lượt cứu app; headless theo kết quả probe.
- Modify: `plugins/agent-crew/scripts/crew-collect.mjs` — `STATUS_VERDICT` thêm `CONTINUE`, verdict `CONTINUE`, cờ `HANDOFF THIẾU`.
- Modify: `plugins/agent-crew/scripts/crew-reconcile.mjs` — nhận `continue` là trạng thái kết thúc không-PASS.
- Modify: `plugins/agent-crew/scripts/lib/crew-digest.mjs` — vòng "quá hạn" ở `crew-digest.mjs:112-120` lọc bằng `pending`/`running` (grep `done_with_concerns` **không** bắt được chỗ này): thêm dòng riêng cho job `continue` ("cần `--chain`/`--resume`").
- Modify: `plugins/agent-crew/scripts/lib/derive-state.mjs` — hiển thị `continue`. Soát mọi chỗ so `j.status` bằng `grep -rn "status ===\|status !==" plugins/agent-crew/scripts`, không chỉ grep `done_with_concerns`.
- Modify docs: `SKILL.md` (bảng exit Bước 6, bảng verdict Bước 7), `references/nghiem-thu-chi-tiet.md` (verdict `CONTINUE`, cờ `HANDOFF THIẾU`), `references/worker-brief.md` (worker không cần tự viết dòng hạn mềm).
- Create: `plugins/agent-crew/tests/handoff.test.mjs` — parser, contract line, collect verdict.
- Modify: `plugins/agent-crew/tests/codex-lifecycle.test.mjs`, `tests/fixtures/fake-codex` — kịch bản: hết timeout → lượt cứu ghi handoff → job `continue`; lượt cứu cũng hết giờ → `failed` như cũ.
- Modify: `plugins/agent-crew/tests/anti-stall.test.mjs` hoặc `tests/fixtures/anti-app-harness.mjs` — lượt cứu app.

## Tasks & Steps

1. [x] **Probe** (tay, `--timeout 1m`): `agy -p --output-format json --print-timeout 1m` với việc dài hơn 1 phút; xem stdout có `conversation_id` không. Ghi kết quả vào `plugins/agent-crew/docs/transport-measurements.md`.
2. [x] Parser + contract + collect/reconcile cho `CONTINUE`; test thuần.
3. [x] Hạn mềm ở cả 2 adapter.
4. [x] Lượt cứu Codex headless (`runHandoffRescue`, seam ở trên) + test fake-codex: resolve đúng 1 lần; lượt cứu hết giờ → `failed`; idle-kill không cứu.
5. [x] Lượt cứu Anti app + test harness; Anti headless theo probe.
6. [x] Doc.
7. [x] Bump `plugin.json` bản vá (2.0.6), owner update plugin, `diff -rq` bản cài với source rỗng.

## Verification

- `node plugins/agent-crew/tests/handoff.test.mjs`, `node plugins/agent-crew/tests/codex-lifecycle.test.mjs`, rồi `node plugins/agent-crew/tests/run.mjs` xanh.
- Tay, job Codex thật `--timeout 3m` giao việc cố ý dài: evidence có `## Handoff` + `Status: CONTINUE`, sổ có `handoffRescue` hoặc worker tự dừng trước hạn.

## Risks / Rollback

- Worker lạm dụng `CONTINUE` thay `DONE_WITH_CONCERNS`: câu contract chỉ cho phép khi chưa xong và có handoff; collect gắn cờ khi thiếu mục.
- Lượt cứu kéo job thêm 3m: slot nhả sau `timeoutMs + 10m` (`crew-manifest.mjs:673`) vẫn đủ; lượt cứu không mint token Workspace mới.
- Lượt cứu vẫn là một lượt sống của worker (prompt không ép được): giới hạn 3m, cùng sandbox, không thêm quyền. Chấp nhận.

## Ghi chú khi cook (2026-11-06)

- Probe bước 1 **dương**: `agy` hết `--print-timeout` → exit 3, stdout vẫn có JSON với `conversation_id`, `finished_reason: print_timeout` (ghi ở `docs/transport-measurements.md`). Anti headless có lượt cứu qua `--conversation <id>`, không truyền `--model`. `anti-run` giờ đọc JSON cả khi exit ≠ 0; job fail vẫn ghi `conversationId`.
- Trần lượt cứu = `min(3m, timeout job)`, im = `min(1m, idle job)`: không dài hơn chính job, và test chạy nhanh mà không cần núm riêng.
- Lượt cứu Codex tách ra `scripts/codex-handoff-rescue.mjs`; `finish()` thành async, đặt `settled` trước khi await nên resolve đúng 1 lần (test cả ca lượt cứu tự hết giờ).
- Lượt cứu thành công thì `runtimeOk` = true (timeout chính là nghĩa của CONTINUE), `killedFor` vẫn ghi. Job `continue` ra exit 3 ở cả hai adapter.
- Collect: ngoài `CONTINUE` và `HANDOFF THIẾU`, thêm `CHAINED` ngay ở phase này: job `CONTINUE` mà job sau trong run có `resumedFrom` = `conversationId` của nó (không `resumeMismatch`) thì thôi chặn. Không có cái này thì run có job CONTINUE không bao giờ qua cổng dù đã làm tiếp. Phase 4 dùng lại (lát nối nhau bằng chính `resumedFrom`).
- `derive-state.mjs` không đọc trạng thái job nên không sửa; `crew-reconcile` không cần sửa (continue không nằm trong TERMINAL_PASS nên được vá theo evidence như mọi trạng thái khác).

- Kiểm tay (Verification), job Codex thật `--tier light --timeout 3m`, brief đếm 300 lần `sleep 1`: bị cắt ở 3m (89/300 dòng), lượt cứu 32s ghi đủ 4 mục `## Handoff` + `Status: CONTINUE`; sổ `status: continue`, `handoffRescue {ran, ok: true, durationSec: 32}`, adapter exit 3; collect ra `CONTINUE`. Phát hiện: worker chép tin cứu vào `## Thay đổi từ owner` (collect bật BRIEF ĐỔI oan) → prompt cứu giờ nói rõ "Tin từ crew (không phải owner)" và cấm ghi vào mục đó.
- Bump 2.0.6, cài plugin bằng `claude plugin marketplace update` + `claude plugin update`.
