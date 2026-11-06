---
phase: 4
title: "Chuỗi lát --chain có budget"
status: completed
priority: P1
effort: "1.5d"
dependencies: [3]
---

# Phase 4: Chuỗi lát `--chain` có budget

<!-- Updated: Red Team 2026-11-06 - spawn async, budget ghi sổ, checkpoint Claude mỗi 2 lát, kiểm cơ học handoff, trần lát/run, resumeMismatch, filesMayModify mới nhất, cấm workspace-cli -->

## Goal

`crew run codex|anti --chain` cho worker tự quản một task dài: lát nào ra `CONTINUE` hợp lệ thì crew tự nối lát kế trên cùng thread. Chuỗi dừng khi xong, khi kiểm cơ học thấy bất thường, khi tới **checkpoint mỗi 2 lát** (Claude đọc handoff rồi cho đi tiếp), hoặc khi hết budget (mặc định 4h) / 8 lát.

## Context

- Resume theo id đã chạy ở cả 4 bề mặt, so lại id sau khi chạy (`references/transport-va-resume.md`). Resume không nhận `--model`.
- `MAX_JOBS = 6` dùng ở **2 chỗ**: `addJob` (`plugins/agent-crew/scripts/crew-manifest.mjs:209,498`) và `runFor` (`plugins/agent-crew/scripts/crew-session.mjs:64`). `MAX_PARALLEL = 3` ở `claimRunSlot` (`crew-manifest.mjs:719`).
- `crew run` lấy cờ từ sổ ở `plugins/agent-crew/scripts/cli/run-commands.mjs:161-184`.
- `spawnSync` chặn event loop nên handler signal không chạy được (`codex-run.mjs:1440-1447`, `anti-run.mjs:625-627`); `bin/crew.mjs` đã dùng `spawn` async.
- `resumeMismatch`: Codex coi là fail runtime, Anti chỉ ghi `runtimeDetail` không ép `failed` (`anti-run.mjs:150-175`).
- SKILL.md cấm dùng evidence làm brief kế tiếp mà không đọc lại (`skills/agent-crew/SKILL.md:62-72`).

## Thiết kế

```
crew run <w> --manifest M --job N --prompt-file P --chain [--budget 4h] [--max-slices 8]
  (gọi lại đúng lệnh này sau checkpoint: đếm tiếp từ sổ, không mở budget mới)
  từ chối nếu job N bật --workspace-cli on
  lát 1 = job N (chạy như cũ)
  loop:
    đọc job vừa xong trong sổ
    status != continue                          → thoát, exit = exit lát cuối
    resumeMismatch                              → thoát exit 3, note "thread bị tách"
    kiểm cơ học handoff không đạt (dưới)        → thoát exit 3, note lý do
    hết budget hoặc lát == max                  → thoát exit 3, note "hết budget/lát"
    đủ 2 lát kể từ checkpoint trước             → thoát exit 4 "checkpoint", ghi chainCheckpointAt
    add-job lát kế: cùng worker/role/tier/transport, filesMayModify đọc MỚI NHẤT từ sổ
                    (gồm phần `crew amend --allow`), chainOf = N, slice = k
    viết brief lát kế (mẫu cố định, dispatcher viết, không chép text worker):
       "Tiếp việc của job N. Handoff ở <evidence lát trước>. Brief gốc: <brief N>.
        Acceptance và phạm vi ghi giữ nguyên."
    spawn async: crew run <w> --job <lát kế> --resume <conversationId lát trước>
```

**Kiểm cơ học handoff** (không tốn token Claude), lát `continue` bị coi là bất thường khi:
1. Thiếu 1 trong 4 mục `### Đã xong`, `### Đang dở`, `### Bước kế tiếp`, `### File đã đụng`.
2. `### Đang dở` giống hệt lát trước (chuẩn hoá khoảng trắng) → không tiến triển.
3. Lát không đổi file nào ngoài evidence (theo `touchedFiles` của lát, hoặc mtime trong `filesMayModify`).
4. Handoff có chữ đòi quyền/dispatch: `dispatch`, `crew run`, `add-job`, `--sandbox-mode`, `--workspace-cli`, `danger-full-access`, `CREW_ROLE`, đường control plane (`BASE_CONTROL_PLANE`, `crew-scope.mjs:117-121`).

**Checkpoint mỗi 2 lát (owner chốt).** Exit `4` là mã mới: "chuỗi nghỉ, Claude đọc". Claude đọc handoff 2 lát vừa xong theo luật Security của SKILL.md (handoff là dữ liệu), rồi:
- ổn → gọi lại đúng lệnh `--chain`; budget/số lát đếm tiếp từ sổ;
- không ổn → `crew amend --note`, hỏi owner, hoặc dừng chuỗi.

**Trạng thái ghi sổ** (trên job N): `chainStartedAt`, `chainSlices`, `chainElapsedMs`, `chainCheckpointAt`, `chainStoppedFor`. Chain-runner chết rồi chạy lại vẫn đếm tiếp, không mở đồng hồ mới.

**Ràng buộc.** `--budget` ≤ 8h, `--max-slices` ≤ 8, mỗi lát ≤ 30m. **Tổng lát có `chainOf` mỗi run ≤ 16** (`MAX_CHAIN_JOBS_PER_RUN`), để run vẫn đọc được bằng mắt. Lát kế dùng lại slot của lát trước (tuần tự). Anti headless chỉ được `--chain` khi probe ở phase 3 dương (có lượt cứu); probe âm thì `--chain` từ chối Anti headless.

**Signal.** Lát được gọi bằng `spawn` async (không `spawnSync`). SIGTERM vào chain-runner → chuyển SIGTERM cho tiến trình con, ghi `chainStoppedFor: "sigterm"`, exit 1. Ngoại lệ đã biết: lát Anti headless không có handler (đợi trong `spawnSync`), nên chết theo mặc định; thu dọn qua `crew reconcile` / slot hết hạn như hiện nay. Ghi rõ trong doc.

**Collect.** Lát `continue` có lát sau → verdict `CHAINED` (không chặn); verdict chuỗi = verdict lát cuối. Phạm vi ghi chấm từng lát theo khung giờ của lát.

**Sidecar.** `chain-{N}.jsonl` trong thư mục `logs`: mỗi lát/checkpoint một dòng `{"type":"crew.chain","slice","status","conversationId","elapsedSec","usage","stop"}`; `crew paths --job N` in đường này để arm `Monitor`.

## Files to Create / Modify

- Create: `plugins/agent-crew/scripts/lib/chain-runner.mjs` — vòng lặp, kiểm cơ học, `spawn` async `node bin/crew.mjs run …`, chuyển signal.
- Create: `plugins/agent-crew/scripts/lib/handoff-check.mjs` — 4 phép kiểm cơ học, hàm thuần để test.
- Modify: `plugins/agent-crew/scripts/cli/run-commands.mjs` — cờ `--chain`, `--budget`, `--max-slices`; từ chối `--chain` khi job bật workspace-cli; `paths` in dòng `chain`.
- Modify: `plugins/agent-crew/scripts/crew-guards.mjs` — `MAX_CHAIN_BUDGET_MS` (8h), `DEFAULT_CHAIN_BUDGET` ("4h"), `MAX_CHAIN_SLICES` (8), `CHAIN_CHECKPOINT_EVERY` (2), `MAX_CHAIN_JOBS_PER_RUN` (16); parse budget riêng (trần 8h).
- Modify: `plugins/agent-crew/scripts/crew-manifest.mjs` — trường `chainOf`, `slice` + 5 trường `chain*` (thêm vào `SEALED_JOB_FIELDS`); `addJob` không đếm `chainOf` vào `MAX_JOBS` nhưng chặn ở `MAX_CHAIN_JOBS_PER_RUN`.
- Modify: `plugins/agent-crew/scripts/crew-session.mjs` — `runFor` (dòng 64) đếm job **không** có `chainOf`, khớp `addJob`.
- Modify: `plugins/agent-crew/scripts/crew-collect.mjs` — verdict `CHAINED`, gom bảng theo chuỗi, report khung có cột lát.
- Modify docs: `SKILL.md` Bước 6 (khi nào dùng `--chain`; bảng exit thêm `4 = checkpoint chuỗi`; cách đọc checkpoint; Monitor); `references/transport-va-resume.md` mục "Chuỗi lát" (gồm ngoại lệ signal Anti headless, scope không tự nới — muốn nới thì `crew amend --allow` giữa 2 lát); `references/cost-gate.md` ngưỡng `chain_budget_default 4h`, `chain_budget_max 8h`, `chain_slices_max 8`, `chain_checkpoint_every 2`, `chain_jobs_per_run_max 16`.
- Create: `plugins/agent-crew/tests/chain-runner.test.mjs`, `plugins/agent-crew/tests/handoff-check.test.mjs`.

## Tasks & Steps

1. [x] Hằng số + parse budget trong `crew-guards.mjs`, test.
2. [x] Trường chuỗi trong manifest; miễn `MAX_JOBS` ở **cả** `addJob` và `runFor`; trần 16 lát/run; test.
3. [x] `handoff-check.mjs` + test 4 phép kiểm.
4. [x] `chain-runner.mjs` (spawn async, signal, checkpoint, budget đếm từ sổ) + cờ CLI + sidecar.
5. [x] Collect `CHAINED` + report.
6. [x] Test chuỗi: CONTINUE→CONTINUE→checkpoint exit 4 → gọi lại → DONE (budget đếm tiếp); hết budget exit 3; max-slices; lát giữa `failed` exit 1; `resumeMismatch` exit 3; handoff không tiến triển exit 3; chữ đòi quyền exit 3; workspace-cli bị từ chối; chain-runner bị kill rồi chạy lại không reset budget; 6 job thường + lát vẫn add được, `runFor` vẫn trả run đó; lát thứ 17 trong run bị từ chối; SIGTERM chuyển xuống con (Codex headless).
7. [x] Doc + lệnh Monitor.
8. [x] Chạy thật 1 chuỗi Codex nhỏ (`--timeout 3m --budget 12m`) trong `.crew/` của repo này; ghi số đo vào `plugins/agent-crew/docs/transport-measurements.md`.
9. [x] Bump `plugin.json` bản vá (2.0.7), owner update plugin, `diff -rq` bản cài với source rỗng.

## Verification

- `node plugins/agent-crew/tests/handoff-check.test.mjs`, `node plugins/agent-crew/tests/chain-runner.test.mjs`, `node plugins/agent-crew/tests/run.mjs` xanh.
- Bước 8: sổ có ≥2 lát cùng `chainOf`, `conversationId` các lát trùng nhau, có ít nhất 1 lần exit 4, `crew collect` exit 0.

## Risks / Rollback

- Thread phình qua nhiều lát làm model chậm/đắt dần: ghi `usage` từng lát vào sidecar để đo; chưa chặn theo token (non-goal).
- Handoff bị nhiễm chỉ thị: lát sau resume cùng thread nên vẫn thấy lượt trước. Giảm bằng kiểm cơ học + checkpoint Claude mỗi 2 lát + brief do dispatcher viết. Không chặn hẳn được; chấp nhận theo quyết định owner.
- Checkpoint tốn token Claude mỗi ~1h: đổi lấy an toàn, owner đã chọn.

## Ghi chú khi cook (2026-11-06)

- `--chain` là nhánh trong `bin/crew.mjs run` → `scripts/lib/chain-runner.mjs`; mỗi lát quay lại chính `crew run` (spawn async), nên lát đi qua đúng `expandRunArgs`, claim slot, guard resume như job tay.
- Phép "lát có đổi file" tách ra `scripts/lib/chain-slice-progress.mjs` (đụng đĩa): `touchedFiles` trước, rồi mtime dưới thư mục run + `filesMayModify`, loại sổ/brief/evidence mọi job (`worker-*.md`, job song song cũng ghi vào thư mục run)/log/sidecar. Anti không có `touchedFiles` nên chỉ còn mtime — chấp nhận, checkpoint là lớp sau.
- Lát Codex chạy nhầm thread bị adapter chấm `failed`; chain-runner xét `resumeMismatch` **trước** trạng thái để dừng exit 3 "thread bị tách" đúng thiết kế, không phải exit 1.
- Mỗi lát timeout = `min(--timeout, budget còn lại)`; còn < 60s thì coi như hết budget (lát ngắn hơn chỉ kịp đọc handoff).
- Lát `pending` khi gọi lại (chuỗi chết giữa ghi sổ và bắn) → bắn đúng lát đó; lát `running` → từ chối exit 2.
- Collect không cần sửa thêm: `CHAINED` có từ phase 3 nối theo `resumedFrom`; tên lát mang `— lát k` nên bảng report đọc được chuỗi mà không cần cột riêng.
- Test: `handoff-check.test.mjs` (23), `chain-runner.test.mjs` (55, chạy thật qua `bin/crew.mjs` → codex-run → fake-codex mode `chain`).
- Chạy thật (bước 8): 3 lát Codex cùng thread, checkpoint exit 4 sau lát 2, gọi lại → lát 3 DONE, `counter.txt` khớp 1..200, collect 1 PASS + 2 CHAINED, exit 0 sau khi bác (`--not-ours`) file phase 5 chính phiên này sửa trong lúc chuỗi chạy. Số đo ở `docs/transport-measurements.md`.
- Bump 2.0.7 cùng commit với doc/plan; không cài riêng 2.0.7 vì phase 5 lên 2.1.0 ngay sau — cài một lần 2.1.0 (chứa đủ phase 4).
