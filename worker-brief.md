# Worker Brief Contract

Một profile cho cả 3 worker. Brief nói **WHAT + NEED**, không nói HOW.

Phép thử: chỉ viết thứ worker **không tự suy ra được** từ file + `SKILL.md`. Trần 2 KB.
Lưu bản đã gửi tại `{reports_path}/brief-{runtime}-{seq}.md`.

## Template

```markdown
# Job {run_id}#{job_seq} — {runtime}

## Tình hình
{Đang có gì, ở đâu, số liệu nền. Không kể lịch sử task.}

## Cần gì
{Hình dạng output cần đạt. Không mô tả bằng các bước.}

## Bối cảnh & file
- {entry point để worker tự scout, file bắt buộc đọc}

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
- Sheet read-only trừ khi brief ghi rõ. Không dispatch worker khác (`MWG_CREW_ROLE=worker`).
- Cost gate {cost_gate}: gặp thì DỪNG, trả BLOCKED / COST_GATE.

## Kết thúc

Dòng **cuối cùng** của evidence phải là một dòng `Status:` mang **đúng một** giá
trị: `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, hoặc `NEEDS_CONTEXT`. Dòng liệt kê
nhiều giá trị bị từ chối. Ngay trên nó là `Summary:` và `Concerns/Blockers:`.

Thiếu 3 dòng này thì cổng nghiệm thu đọc job là **chưa xong**, kể cả khi việc đã
làm đúng. Đừng kết bằng mục khác.
```

Cách viết từng mục, và ví dụ outcome vs kê bước:
`.claude/skills/seo-crew/references/dispatch-playbook.md`.
