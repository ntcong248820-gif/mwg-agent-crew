# Worker Brief Contract

Format brief Claude gửi cho worker. Dùng **nguyên** schema của
`~/.claude/rules/orchestration-protocol.md`, thêm 4 field riêng của crew. Không phát minh
schema mới.

Brief đã gửi phải được lưu lại tại `{reports_path}/brief-{runtime}-{seq}.md` để audit.

## Template

```markdown
# Job {run_id}#{job_seq} — {runtime}

## Task
{Một đầu việc duy nhất, mô tả bằng kết quả cần đạt, không phải bằng các bước.}

## Skill to use
{Tên skill trong workspace, ví dụ `seo-gsc-rank-check`. Skill đã có mặt ở surface của
mày — đọc SKILL.md rồi làm theo, đừng tự nghĩ lại quy trình.}

## Files to read
- {đường dẫn tuyệt đối hoặc relative từ repo root}

## Files it may modify
- {evidence_path}
- {các file data job này tự sinh, đều nằm trong tasks/{task}/}

KHÔNG được ghi bất kỳ file nào ngoài danh sách trên.

## Acceptance criteria
- [ ] {bằng chứng quan sát được, không phải "đã làm xong"}

## Constraints
- Không đọc `.env`, client secret, token, credential.
- Không sửa file trong danh sách Protected Files của `CLAUDE.md`.
- Google Sheet là read-only, trừ khi brief này ghi rõ được ghi.
- Không dispatch worker khác. Mày là worker (`MWG_CREW_ROLE=worker`).
- Cost gate: {danh sách từ cost-gate.md}. Gặp API này thì DỪNG, trả BLOCKED / COST_GATE,
  không tự gọi.

## Work context path
{repo root}

## Reports path
{tasks/{task}/reports/crew-{run_id}/}

## Evidence path
{tasks/{task}/reports/crew-{run_id}/worker-{runtime}-{seq}.md}

Ghi kết quả vào đúng file này. Evidence phải có: việc đã làm, số liệu thô, đường dẫn
file output, và thời gian bắt đầu/kết thúc.

## Kết thúc bằng đúng 3 dòng này

Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
Summary: {một hai câu}
Concerns/Blockers: {nếu có}
```

## Field riêng của crew

| Field | Ý nghĩa |
| --- | --- |
| `run_id` | `{yymmdd-hhmm}` của lần dispatch, dùng làm tên folder `crew-{run_id}` |
| `job_seq` | Số thứ tự job trong run, bắt đầu từ 1 |
| `evidence_path` | File **duy nhất** job được ghi kết quả. Hai job không bao giờ trùng path này. |
| `cost_gate` | Danh sách API tốn tiền job không được tự gọi |

## Quy tắc viết brief

1. **Một job = một đầu việc = một acceptance.** Không viết nổi acceptance quan sát được
   thì đó không phải một job — chẻ lại hoặc gộp lại.
2. **Mô tả kết quả, không mô tả các bước**, trừ khi thứ tự thực sự quan trọng. Worker có
   skill rồi, đừng lặp lại quy trình trong brief.
3. **Trỏ skill bằng tên**, đừng nhồi nội dung `SKILL.md` vào prompt. 13 skill `seo-*` đã
   mirror đủ 4 surface nên worker đọc được.
4. **Danh sách files it may modify là hàng rào duy nhất** có hiệu lực với Antigravity
   (chạy `--dangerously-skip-permissions`, không sandbox được). Viết cụ thể, không viết
   "các file liên quan".
