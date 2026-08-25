# Worker Brief Contract

Một profile cho cả 3 worker. Brief nói **WHAT + NEED**, không nói HOW.

Phép thử: brief chỉ chứa thứ worker **không tự suy ra được** từ file + `SKILL.md`.
Trần 2 KB. Lưu bản đã gửi tại `{reports_path}/brief-{runtime}-{seq}.md`.

## Template

```markdown
# Job {run_id}#{job_seq} — {runtime}

## Tình hình
{Đang có gì, ở đâu, số liệu nền. Không kể lịch sử task.}

## Cần gì
{Hình dạng output cần đạt. Không mô tả bằng các bước.}

## Bối cảnh & file
- {entry point để worker tự scout}
- {file bắt buộc đọc}

## Skill
{Tên skill. Đọc SKILL.md rồi làm, đừng nghĩ lại quy trình.}

## Lưu ý
- {bẫy đã biết, ràng buộc không đọc được từ file, chỗ lần trước làm sai}

## Được ghi
- {evidence_path}
- {data job tự sinh, trong tasks/{task}/}

KHÔNG ghi file nào ngoài danh sách trên.

## Acceptance
- [ ] {kiểm được bằng mắt hoặc bằng lệnh}

## Ranh giới
- Không đọc `.env`/secret/token. Không sửa Protected Files của `CLAUDE.md`.
- Google Sheet read-only trừ khi brief ghi rõ.
- Không dispatch worker khác. Mày là worker (`MWG_CREW_ROLE=worker`).
- Cost gate {cost_gate}: gặp thì DỪNG, trả BLOCKED / COST_GATE.

## Kết thúc bằng đúng 3 dòng

Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
Summary: {một hai câu}
Concerns/Blockers: {nếu có}
```

## Quy tắc

1. Một job = một acceptance. Không viết nổi acceptance quan sát được thì chẻ lại.
2. `## Lưu ý` trần 5 gạch — chỗ duy nhất chỉ Claude viết được. Quá 5 là đang kê bước
   trở lại.
3. `## Được ghi` là hàng rào duy nhất còn hiệu lực với Antigravity. Viết cụ thể.
4. `evidence_path` là file duy nhất job ghi kết quả; hai job không trùng.

Ví dụ outcome vs kê bước: `dispatch-playbook.md` của `seo-crew`.
