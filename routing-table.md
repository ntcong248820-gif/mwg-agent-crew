# Routing Table

## Tiêu chí phân việc

Không phân theo "dễ / khó". Phân theo **rule đã thành văn hay chưa**:

| Điều kiện | Worker |
| --- | --- |
| Rule đã viết thành văn trong `SKILL.md`, chỉ cần thi hành đúng và nhanh | **Antigravity** |
| Cần phán đoán ngoài văn bản: đọc số, chọn hướng, quyết định nghiệp vụ | **Claude** |
| Code, pipeline, logic nhiều bước, refactor | **Codex** |

Lý do Antigravity được nhiều việc hơn cảm giác trực quan: nó nhanh và làm rất gọn khi
bộ case đã ràng kỹ. Điểm yếu của nó là suy luận mở, không phải tốc độ hay độ chính xác
khi có mẫu.

## Bảng phân việc

| Worker | `anti_mode` | Việc |
| --- | --- | --- |
| **Claude** | — | `seo-gsc-category-review`, `seo-action-impact-review`, `seo-daily-reporter`, `seo-task-state-audit`, viết report chính thức, `seo-log-cv`, `seo-log-weekly-work` |
| **Codex** | — | tool trong `mwg-seo-analytics/`, `mwg-seo-planning/scripts/`, workflow n8n, dedup/clustering, `batch-llm-skill` runs, transform data phức tạp |
| **Antigravity** | `headless` | `seo-keyword-research`, `seo-gsc-rank-check` (bulk), `image-seo-pipeline`, `content-html-optimizer`, readback/export Sheet, chuẩn hoá bảng, fill metadata theo mẫu |
| **Antigravity** | `app` | việc dài muốn ngồi xem trong Antigravity 2.0: research đối thủ, audit outline nhiều URL, việc cần browser tools |

## Chọn `anti_mode`

| Mode | Khi nào | Cơ chế |
| --- | --- | --- |
| `headless` | **Mặc định.** Claude cần kết quả để xử lý tiếp | `agy -p --output-format json`, trả stdout về Claude |
| `app` | User nói muốn xem/chat tiếp trong app, hoặc việc mở, khám phá | `agentapi new-conversation` → session hiện trong Antigravity 2.0; Claude poll bằng `anti-status.mjs` |

Job `app` **không** trả kết quả về stdout. Đừng chọn `app` cho việc mà Claude cần output
để làm bước sau.

### Đo được về app mode (2026-08-19)

Worker app mode ghi xong report sau 23 giây, nhưng để step `write_to_file` ở status `7`
suốt 8 phút còn lại. Nếu phát hiện "xong" bằng step status thì job đã hoàn thành vẫn bị
coi là đang chạy rồi bị đánh fail. Vì vậy `anti-run.mjs` lấy **file evidence** làm tín
hiệu hoàn thành, step chỉ là dự phòng. Sau khi sửa, cùng job đó chạy 55 giây.

Hệ quả khi dùng app mode:

- Luôn chạy `crew-reconcile.mjs` sau một run có job app. Job app có thể hoàn thành sau
  khi adapter đã bỏ cuộc; evidence trên đĩa mới là sự thật.
- Job app từng dừng hẳn sau 1 tool call mà không ghi gì (conversation 6 step, không có
  error, không có permission blob). Evidence gate bắt được. Đừng giao việc bắt buộc phải
  ra file cho app mode nếu không ai ngồi xem.

## Model

| Runtime | Mặc định | Ghi chú |
| --- | --- | --- |
| `agy` | `gemini-3.7-flash-medium` | nhận tên model đầy đủ; đổi sang `gemini-3.1-pro-high` khi việc cần nặng |
| `agentapi` | `flash` | **chỉ** nhận `flash_lite\|flash\|pro\|inherit`, không nhận tên đầy đủ |
| Codex | để trống | plugin tự chọn; chỉ pin `--model` khi user yêu cầu |

## Khi KHÔNG dùng crew

- Request chỉ có **1 đầu việc** → làm trực tiếp. Dispatch cho có là thêm 5.5s startup vô ích.
- Job nhỏ hơn ~30s xử lý → gom vào một job, đừng chẻ. Overhead khởi động `agy` là 5.5s/lần.
- Việc cần quyết định nghiệp vụ giữa chừng → Claude tự làm, không giao đi rồi hỏi lại.
