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

| Worker | Việc |
| --- | --- |
| **Claude** | `seo-gsc-category-review`, `seo-action-impact-review`, `seo-daily-reporter`, `seo-task-state-audit`, viết report chính thức, `seo-log-cv`, `seo-log-weekly-work` |
| **Codex** | tool trong `mwg-seo-analytics/`, `mwg-seo-planning/scripts/`, workflow n8n, dedup/clustering, `batch-llm-skill` runs, transform data phức tạp |
| **Antigravity** | `seo-keyword-research`, `seo-gsc-rank-check` (bulk), `image-seo-pipeline`, `content-html-optimizer`, readback/export Sheet, chuẩn hoá bảng, fill metadata theo mẫu, research đối thủ, audit outline nhiều URL, việc cần browser tools |

Bảng này chỉ trả lời **ai làm**. Nó không còn cột mode: transport không phải thuộc
tính của loại việc, nó là thuộc tính của **vai trò worker trong run đó** — cùng một
việc `seo-gsc-rank-check` có thể là owner hay assist tuỳ ai chịu trách nhiệm về đầu ra.

## Transport

| Vai trò | Nghĩa là | Transport |
| --- | --- | --- |
| **owner** | Worker là người đảm nhiệm chính. Evidence của nó **chính là** deliverable được nghiệm thu | **app** — mở box chat để owner kiểm soát bằng mắt |
| **assist** | Worker làm nguyên liệu cho deliverable mà Claude mới là người viết (Anti chạy browser lấy trang, Codex research song song nhiều nhánh) | **headless** |

Phép thử duy nhất:

> **Ai chịu trách nhiệm về acceptance của đầu ra job này?**
> Chính worker → `role: owner` → app. Claude → `role: assist` → headless.

**Không** phải "việc nặng hay nhẹ", **không** phải "lâu hay nhanh". Job assist chạy
20 phút vẫn headless; job owner chạy 2 phút vẫn mở box chat.

Tiêu chí cũ dựa vào việc user có thích theo dõi trong app hay không — đó không phải
rule, vì không có cách nào kiểm.
Kết quả: 34 job lịch sử chia 10 app / 24 headless mà không truy được vì sao job nào đi
đường nào. `addJob` giờ đòi `role` và ghi cả `role` lẫn `transport` vào manifest: `role`
là **lý do**, `transport` là **hệ quả**, tách ra để sau này đổi mặc định vẫn còn dữ liệu
biết quyết định cũ dựa trên gì.

Ghi đè được, nhưng phải kèm `note` nói vì sao. Ghi đè không note bị từ chối — đó đúng là
đường quay lại chọn theo cảm tính.

Job `worker: claude` có `role` nhưng `transport: null`: không có process nào được bắn,
ghi transport vào đó là ghi một box chat chưa từng mở.

| Transport | Cơ chế | Có stdout? |
| --- | --- | --- |
| `headless` | Anti: `agy -p --output-format json`. Codex: `codex exec` | **Có** — trả về Claude |
| `app` | Anti: `agentapi new-conversation` → session hiện trong Antigravity 2.0, adapter poll bằng file evidence. Codex: companion `task --background` → thread thật trong app | Anti **không**; Codex **có** (`result <job-id>`) |

Hai runtime lệch nhau chỗ stdout — đừng suy từ Anti sang Codex. Cả hai đều lấy **file
evidence** làm phán quyết, stdout chỉ là tiện.

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

Chọn bậc theo **lượng phán đoán cần để đi từ input sang output**, không theo cảm
giác việc nặng hay nhẹ.

| Loại việc | Anti headless (`agy`) | Anti app (`agentapi`) | Codex (cả 2 transport) |
| --- | --- | --- | --- |
| Điền theo mẫu, chuẩn hoá bảng, readback/export Sheet | `gemini-3.7-flash-low` | `flash_lite` | — |
| Thi hành skill nhiều case, crawl + phân loại theo whitelist | `gemini-3.7-flash-medium` | `flash` | `--effort low` |
| Suy luận từ dữ liệu sang output chưa có mẫu sẵn | `gemini-3.1-pro-high` | `pro` | `--effort medium` |
| Code/pipeline nhiều bước, refactor tool | — | — | `--effort high` |

Bậc chỉ là điểm khởi đầu. Job fail vì model yếu thì **nâng đúng 1 bậc và ghi note**,
không nhảy thẳng lên `pro-high` cho mọi thứ — làm vậy thì lần sau không ai biết việc
nào thật sự cần bậc cao.

Ràng buộc từng runtime:

| Runtime | Ghi chú |
| --- | --- |
| `agy` | nhận tên model đầy đủ; `agy models` liệt kê bản còn sống |
| `agentapi` | **chỉ** nhận `flash_lite\|flash\|pro\|inherit`, không nhận tên đầy đủ |
| Codex | Bậc đặt bằng `--effort`; vẫn truyền `-m` (mặc định config hiện tại `gpt-5.5`) — để trống thì manifest không ghi được model nào đã chạy, đúng cái field này sinh ra để đo. Đo 2026-08-24: codex **im lặng bỏ qua** `model_reasoning_effort` sai chính tả, nên adapter tự whitelist để bắt typo |

**Không truyền `--model` thì không dispatch.** Trước phase 03, mọi job trong mọi
manifest đều `"model": null` — knob có mà chưa ai bật, nên không có cách nào đo model
nào hay fail ngoài đoán. `addJob` ghi `model` (và `effort` cho Codex) để lần sau đo được.

Dispatch Codex đi qua `codex-run.mjs`, **không** qua subagent `codex:codex-rescue`.
Lý do không phải transport của subagent tệ — nó lái app-server thật và mở thread thật
trong app. Lý do là **subagent bị cấm quan sát**: `agents/codex-rescue.md` cấm nó
poll, monitor, fetch result, cancel. Runtime `codex-companion.mjs` bên dưới có đủ
`status`/`result`/`cancel`, chỉ tầng agent là mù. Đo 2026-08-24: pid chết ở phút 2,
manifest không có field `failure` nào, phát hiện ở phút 22 — job chết mà không ai ghi
sổ vì không ai được phép nhìn.

## Khi KHÔNG dùng crew

- Request chỉ có **1 đầu việc** → làm trực tiếp. Dispatch cho có là thêm 5.5s startup vô ích.
- Job nhỏ hơn ~30s xử lý → gom vào một job, đừng chẻ. Overhead khởi động `agy` là 5.5s/lần.
- Việc cần quyết định nghiệp vụ giữa chừng → Claude tự làm, không giao đi rồi hỏi lại.
