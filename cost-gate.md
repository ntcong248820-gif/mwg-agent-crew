# Cost Gate

Hai loại chi phí, hai cơ chế khác nhau.

## Loại 1 — API tốn tiền theo lần gọi: PHẢI XIN XÁC NHẬN

Worker gặp một trong các đường dưới đây thì **dừng**, trả `Status: BLOCKED` với
`Concerns/Blockers: COST_GATE — {tên API}`. Claude hỏi user, được đồng ý mới dispatch lại.

| API | Đường vào |
| --- | --- |
| **Ahrefs API** | skill `seo-keyword-research` |
| **DataForSEO** | workflow n8n trong `mwg-workflow-n8n/` |
| **Gemini API** | skill `image-seo-pipeline` (sinh alt text), `batch-llm-skill` |
| **OpenAI / Anthropic batch API** | skill `batch-llm-skill` |

Miễn gate (free quota, cứ chạy): Google Search Console, GA4, Google Sheets, Drive, Docs,
Gmail, crawl web thường.

## Loại 2 — Credit của chính worker: NGƯỠNG CỨNG, KHÔNG HỎI

Hỏi từng lần dispatch thì mất luôn ý nghĩa tự động. Chặn bằng ngưỡng.

| Ngưỡng | Giá trị | Căn cứ |
| --- | --- | --- |
| `max_parallel` | **3** | đo 2026-08-18: 3 job song song 16s vs tuần tự 33s, per-job không degrade |
| `max_jobs_per_run` | **6** | vượt thì báo user, không tự chạy tiếp |
| `print_timeout_default` | **15m** | mặc định của `agy` là 5m, quá ngắn cho job thật |
| `print_timeout_max` | **30m** | job cần hơn thì phải chẻ nhỏ hoặc chuyển `transport: app` |
| `min_job_size` | ~30s xử lý | dưới ngưỡng này thì gom job — overhead khởi động `agy` là 5.5s/lần |

## Vì sao phải dùng ngưỡng thay vì đọc quota

`agy --help` **không** expose subcommand `credits` (docs của Google có trang credits nhưng
CLI này không có). Không đọc được quota còn lại từ CLI → ngưỡng cứng là cơ chế kiểm soát
duy nhất. Nếu Google thêm `agy credits` về sau thì thay bằng đọc quota thật.

## Job thất bại vẫn tốn tiền

Bẫy đã đo: `agy` thiếu permission trả `status: SUCCESS` + `response` rỗng — vẫn tính token
(33.912 input / 770 output trong lần đo). Nên adapter phải fail loudly ngay lần đầu, không
retry mù. Retry tối đa **1 lần**, và chỉ khi nguyên nhân fail không phải permission.
