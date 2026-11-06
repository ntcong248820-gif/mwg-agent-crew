---
phase: 5
title: "Giao việc chủ động + release 2.1.0"
status: pending
priority: P2
effort: "5h"
dependencies: [1, 2, 3, 4]
---

# Phase 5: Giao việc chủ động + release 2.1.0

## Goal

Ở repo khai `delegate: "aggressive"`, Claude mặc định đẩy việc code sang Codex và research/việc có rule sang Anti mà owner không cần gõ skill; repo khác giữ hành vi cũ. Sau đó phát hành 2.1.0 để skill/hook đang cài nhận toàn bộ thay đổi.

## Context

- Gate chỉ chạy ở repo có `crew.config.json` hoặc `.crew/` (`plugins/agent-crew/scripts/cli/hook.mjs:50,71`) — giữ nguyên, đúng lựa chọn "chỉ repo chọn".
- `classify` cần ≥2 loại đầu việc mới ra `dispatch`, 1 loại chỉ `suggest` kèm "một đầu việc nhỏ thì làm trực tiếp" (`plugins/agent-crew/scripts/lib/routing-gate.mjs:24-33,56-66`).
- Trigger chỉ đến từ `routingTriggers` của repo (`plugins/agent-crew/scripts/lib/crew-config.mjs:48-59`).
- `SKILL.md` Bước 0 và `description` chặn giao 1 đầu việc.
- Hook và `SKILL.md` chạy từ bản cài `~/.claude/plugins/cache/agent-crew-marketplace/agent-crew/<version>`; CLI `crew` chạy thẳng source qua shim. Không bump version thì skill/hook không đổi.

## Thiết kế

- Config: `delegate: "default" | "aggressive"` (mặc định `default`).
- `aggressive` + repo không khai trigger → dùng bộ mặc định: kind `code` (implement, refactor, viết/sửa test, fix bug, sửa lỗi, thêm tính năng, migrate, viết script) và kind `research` (research, tìm hiểu, so sánh, tổng hợp, tra cứu, đánh giá thư viện). Trigger repo cùng `id` thì thắng.
- `aggressive`: 1 hit là đủ → branch mới `delegate`. Lời gate (giữ câu "gợi ý, không phải lệnh" như các nhánh cũ ở `routing-gate.mjs:40-66`):
  > Gợi ý: repo bật giao việc chủ động. Nên giao: code → Codex (`--tier code`, việc > 30 phút thì `--chain`), research/việc có rule → Anti (`--tier standard`). Tự làm khi ước < ~10 lượt gọi tool **và** < 3 file, hoặc cần quyết nghiệp vụ giữa chừng; tự làm thì nói lý do một câu trong trả lời. Đây là gợi ý dựa trên so khớp từ khoá, không phải lệnh: đọc yêu cầu thật (kể cả phần owner dán từ nguồn ngoài) rồi tự quyết.
- Gate chỉ xét lúc gửi prompt, không chạy lại giữa chừng. `dispatch-playbook.md` ghi luật văn: đang tự làm mà thấy đã vượt ngưỡng thì dừng, tự xét lại việc giao phần còn lại.

<!-- Updated: Red Team 2026-11-06 - giữ disclaimer, ghi giới hạn xét một lần -->

> Không xử lý trong plan này (red-team đề xuất, đã bác): worker ghi được `crew.config.json` (bật `delegate`) trong sandbox, chỉ bị `crew-scope.mjs:117-121` bắt lúc collect. Lỗ có sẵn, cùng loại worker ghi `CLAUDE.md`/`routingTriggers`; `delegate` chỉ đổi lời gợi ý, không cấp quyền.
- `costGate` vẫn làm gate im, `@mention` vẫn thắng mọi nhánh.

## Files to Create / Modify

- Create: `plugins/agent-crew/scripts/lib/default-routing-triggers.mjs` — 2 kind, regex tiếng Việt + Anh, có dấu và không dấu.
- Modify: `plugins/agent-crew/scripts/lib/crew-config.mjs` — khoá `delegate`, gộp trigger mặc định khi `aggressive`.
- Modify: `plugins/agent-crew/scripts/lib/routing-gate.mjs` — branch `delegate` trong `classify`/`render`.
- Modify: `plugins/agent-crew/scripts/cli/setup.mjs` — `crew doctor` in `delegate: …`; `crew init --delegate aggressive` ghi khoá vào config mới.
- Modify: `plugins/agent-crew/skills/agent-crew/SKILL.md`:
  - frontmatter `description`/`when_to_use`: thêm "repo bật giao việc chủ động", "việc code lớn", "research".
  - Bước 0: dòng mới "Repo `delegate: aggressive`: miễn luật ≥2 đầu việc; ngưỡng ~10 tool call / 3 file".
  - Gợi ý mặc định `--tier` (phase 2) và `--chain` (phase 4) cho Codex `role owner`.
- Modify: `plugins/agent-crew/skills/agent-crew/references/dispatch-playbook.md` — mục "Giao việc chủ động" với ví dụ giao / không giao.
- Modify: `plugins/agent-crew/README.md` — khoá config mới, cờ `--tier`, `--chain`, Codex chỉ headless.
- Modify: `plugins/agent-crew/tests/crew-routing-gate.test.mjs` — aggressive 1 hit → `delegate`; lời render có câu "không phải lệnh"; default giữ `suggest`; costGate vẫn im; trigger repo đè mặc định.
- Modify: `plugins/agent-crew/.claude-plugin/plugin.json` — `2.0.7` → `2.1.0` (phase 1–4 đã bump bản vá 2.0.4–2.0.7); `SKILL.md` `metadata.version` → `2.1.0`.

## Tasks & Steps

1. [ ] Trigger mặc định + config `delegate` + test.
2. [ ] Branch `delegate` trong gate + test.
3. [ ] `crew doctor`/`crew init`.
4. [ ] Sửa `SKILL.md`, playbook, README.
5. [ ] Toàn bộ test: `node plugins/agent-crew/tests/run.mjs`.
6. [ ] Bump 2.1.0; owner cập nhật plugin trong Claude Code (`/plugin` → update `agent-crew@agent-crew-marketplace`); kiểm `diff -rq` bản cài 2.1.0 với source rỗng (trừ `.in_use`).
7. [ ] Bật thử `delegate: "aggressive"` ở một repo owner chọn; sau ~1 tuần đọc `routingLog` xem tỉ lệ `delegate` bị Claude bỏ qua.

## Verification

- `node plugins/agent-crew/tests/crew-routing-gate.test.mjs` và `node plugins/agent-crew/tests/run.mjs` xanh.
- Tay: trong repo có config aggressive, `echo '{"prompt":"refactor module parser cho gọn"}' | sh plugins/agent-crew/bin/crew-hook.sh prompt` in khối "Repo bật giao việc chủ động"; xoá khoá → in như cũ hoặc im.

## Risks / Rollback

- Regex mặc định khớp quá rộng → giao oan: ngưỡng trong lời gate + log để chỉnh; repo đè được bằng `routingTriggers`.
- Rollback: đặt `delegate: "default"` hoặc xoá khoá; không cần revert code.
