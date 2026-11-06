---
phase: 1
title: "Codex chỉ headless + sửa doc lệch"
status: pending
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Codex chỉ headless + sửa doc lệch

## Goal

Đường dispatch mới không còn tạo được job Codex `app`; tài liệu hết chỉ sai về trần 30m và resume Codex.

## Context

- Owner chốt: Codex app không chat tiếp được thì bỏ. Đo 25/08: không live, không watchdog, `exitCode: null`.
- Ca 3 của `app` ("resume buổi sau") với Codex đã làm tốt hơn bằng headless `--resume` (đo 23/09, thread app cũng tiếp được bằng headless).
- `resolveRouting` ở `plugins/agent-crew/scripts/crew-manifest.mjs:359`; `assertTransport` ở `crew-manifest.mjs:853`, gọi từ `codex-run.mjs:1489`.

## Files to Create / Modify

- Modify: `plugins/agent-crew/scripts/crew-manifest.mjs` — `resolveRouting`: `worker === "codex" && transport === "app"` → `ManifestError` ("Codex chỉ chạy headless; cần thread làm tiếp thì `--resume <conversationId>` ở headless"). Hint 3 ca của `app` đổi thành "chỉ Antigravity".
- Modify: `plugins/agent-crew/scripts/codex-run.mjs` — `mode === "app"` → lỗi cùng câu, đặt ở chỗ kiểm `MODES` (`codex-run.mjs:235`), **không** lồng trong nhánh `if (opts.manifest && opts.job)` (`codex-run.mjs:1483-1489`), để chạy tay không có manifest cũng bị chặn. `codexRunApp` giữ nguyên, thêm comment "không reachable từ CLI từ 2.0.4, chờ xoá". <!-- Updated: Red Team 2026-11-06 - chặn vô điều kiện -->
- Modify: `plugins/agent-crew/.claude-plugin/plugin.json` — `2.0.3` → `2.0.4`. <!-- Updated: Red Team 2026-11-06 - release mỗi phase vì SKILL.md/hook chạy từ bản cài -->

> Doc trong `skills/` và hook chạy từ bản cài trong `~/.claude/plugins/cache/agent-crew-marketplace/agent-crew/<version>`, còn CLI chạy thẳng source. Không release ngay thì CLI chặn Codex app trong khi doc Claude đọc vẫn bảo dùng. Nên mỗi phase kết thúc bằng bump bản vá + owner update plugin.
- Modify: `plugins/agent-crew/tests/collect-gate.test.mjs:756-760` — case codex app giờ kỳ vọng lỗi headless-only; giữ case "with no reason" bằng worker anti.
- Modify: `plugins/agent-crew/tests/codex-lifecycle.test.mjs:237,260,359` — các test `codexRunApp` seed job app thẳng vào manifest (helper `seedLegacyJob` trong `tests/helpers.mjs`), mô phỏng run cũ. Đây cũng là test tương thích run cũ.
- Modify docs (`plugins/agent-crew/skills/agent-crew/`):
  - `SKILL.md` Bước 3 (3 ca `app` → ghi "chỉ Anti"), Bước 6 đoạn **Codex** (bỏ câu `--mode app`), bảng cờ Bước 4.
  - `references/cost-gate.md:42` → "job cần hơn thì chẻ nhỏ hoặc dùng `--chain` (phase 4)". Trước phase 4 xong ghi "chẻ nhỏ, hoặc nối job `--resume`".
  - `references/dispatch-playbook.md:64,304`, `references/routing-table.md:70` → `crew run codex --resume <conversationId>` (headless), bỏ "chỉ thread app có".
  - `references/transport-va-resume.md` — mục Codex app (bảng dòng ~225, "Resume cho Codex app", "guard tiền-kiểm") gom về mục `## Lịch sử: Codex app (bỏ từ 2.1.0)`; giữ số đo.
  - `references/phoi-hop-owner.md:43` — bỏ nhánh "Codex app", chỉ còn headless.

## Tasks & Steps

1. [ ] Sửa `resolveRouting` + câu lỗi; chạy `node plugins/agent-crew/tests/collect-gate.test.mjs` thấy đỏ đúng chỗ.
2. [ ] Chặn `--mode app` ở entry `codex-run.mjs`.
3. [ ] Thêm `seedLegacyJob` vào `tests/helpers.mjs`; chuyển 3 test lifecycle sang dùng nó.
4. [ ] Cập nhật test `collect-gate` dòng 756-760.
5. [ ] Sửa 6 file doc ở trên.
6. [ ] Kiểm collect/reconcile một manifest có job Codex app `done` cũ vẫn ra verdict như trước (test trong `collect-gate`).
7. [ ] Test: `node plugins/agent-crew/scripts/codex-run.mjs --mode app ...` không kèm `--manifest` cũng bị từ chối.
8. [ ] Bump 2.0.4, owner update plugin (`/plugin` → update `agent-crew@agent-crew-marketplace`), `diff -rq` bản cài với source rỗng (trừ `.in_use`).

## Verification

- `node plugins/agent-crew/tests/run.mjs` xanh.
- `grep -rn "chuyển .transport: app" plugins/agent-crew/skills` → rỗng.
- `grep -rn "codex resume <id>" plugins/agent-crew/skills` → chỉ còn trong mục lịch sử.
- Tay: `crew add-job "$MP" --worker codex --role owner --transport app --note x --effort low --title t` → exit ≠ 0, câu lỗi nhắc headless `--resume`.

## Risks / Rollback

- Run đang dở có job Codex app `pending` sẽ fail ở dispatch: chấp nhận, lỗi nói rõ cách làm lại bằng headless. Rollback = revert commit phase.
