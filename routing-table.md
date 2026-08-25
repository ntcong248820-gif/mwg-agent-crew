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

Bảng này chỉ trả lời **ai làm**. Nó không có cột transport: transport không phải thuộc
tính của loại việc. Cùng một việc `seo-gsc-rank-check` có thể là owner hay assist tuỳ ai
chịu trách nhiệm về đầu ra — và cả hai đều chạy `headless` trừ khi có lý do viết ra.

## Transport

**`headless` là mặc định cho cả `owner` và `assist`.** Chọn `app` là ghi đè, và ghi đè
phải kèm `note` nói vì sao — không note thì `addJob` từ chối.

| Vai trò | Nghĩa là | Transport mặc định |
| --- | --- | --- |
| **owner** | Worker là người đảm nhiệm chính. Evidence của nó **chính là** deliverable được nghiệm thu | **headless** |
| **assist** | Worker làm nguyên liệu cho deliverable mà Claude mới là người viết (Anti chạy browser lấy trang, Codex research song song nhiều nhánh) | **headless** |

`role` không còn quyết transport, nhưng **vẫn bắt buộc** và vẫn là phép thử:

> **Ai chịu trách nhiệm về acceptance của đầu ra job này?**
> Chính worker → `role: owner`. Claude → `role: assist`.

`role` quyết cách **chấm** output. `transport` quyết harness **thấy được gì**. Hai trục
khác nhau — rule 25/08 trước đó nối chúng lại là nối sai, và phép đo phase 3 của
`260825-1203-crew-transport-mode-split` cho thấy vì sao.

### Vì sao headless là mặc định (đo 2026-08-25, 6 job app thật)

| Đo được | Nghĩa là |
| --- | --- |
| Anti app truyền `runtimeOk: true` vô điều kiện; không `usage`, không `response`, không `numTurns` | Mất khả năng phát hiện silent-fail mà headless có (`SUCCESS` + `response` rỗng = bị chặn ở prompt permission) |
| Codex app: `exitCode: null`, **không watchdog**, không gọi `result` | Job treo chỉ chết khi hết trần timeout; text reply của worker bị bỏ |
| Thread app **không hiện live** — rollout trên đĩa ở +8s, mắt chỉ thấy sau khi tắt/mở lại app | "Mở app ngồi xem cho chắc" không mua được cái nó hứa |

Nói gọn: `app` **quan sát yếu hơn** `headless` ở cả hai runtime. Nên nó phải là ngoại lệ
có lý do, không phải mặc định.

### Ba ca `app` đáng giá (user chốt 25/08)

1. **Job Anti sẽ gặp prompt permission cần người trả.** Anti app cho người bấm đồng ý;
   headless gặp prompt là silent-fail. Đây là ca app mạnh nhất còn lại.
2. **Việc mở/khám phá, chưa viết nổi acceptance trước.** Không có tiêu chí chấm thì mất
   evidence-first cũng không mất gì; đổi lại owner nhìn được quá trình.
3. **Cần thread resume làm tiếp buổi sau.** `codex resume <id>` chỉ có với thread app.

Ngoài 3 ca này, chọn `app` là đang trả giá quan sát để lấy một thứ chưa nêu được.

### Lịch sử: vì sao có `role`

Tiêu chí cũ hơn nữa dựa vào việc user có thích theo dõi trong app hay không — đó không
phải rule, vì không có cách nào kiểm. Kết quả: 34 job lịch sử chia 10 app / 24 headless
mà không truy được vì sao job nào đi đường nào. `addJob` giờ đòi `role` và ghi cả `role`
lẫn `transport` vào manifest: `role` là **lý do**, `transport` là **hệ quả**. Chính vì
tách ra mà lần đổi mặc định này không làm run cũ thành vô nghĩa — run cũ vẫn đọc được
quyết định của nó dựa trên gì.

Job `worker: claude` có `role` nhưng `transport: null`: không có process nào được bắn,
ghi transport vào đó là ghi một box chat chưa từng mở.

| Transport | Cơ chế | Có stdout? |
| --- | --- | --- |
| `headless` | Anti: `agy -p --output-format json`. Codex: `codex exec` | **Có** — trả về Claude |
| `app` | Anti: `agentapi new-conversation` → session **hiện trong Antigravity 2.0**; adapter poll bằng file evidence. Codex: `codex-run.mjs --mode app` → companion `task --background` → thread **hiện trong app Codex**, tên `Codex Companion Task: {dòng đầu brief}`; chờ bằng `status --wait`. Cả hai đã kiểm bằng mắt 25/08 | Anti **không**; Codex **có** (`result <job-id>`) |

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

### `result` của companion — đo 2026-08-25 (bản 1.0.5)

`codex-run.mjs --mode app` giờ gọi `result <job-id>` sau khi job settle. Hình dạng thật:

| Field | Là gì |
| --- | --- |
| `storedJob.result.rawOutput` | Câu trả lời của worker. Đây là cái adapter lưu, ghi ra `{job}.codex-app-reply.md`, manifest trỏ qua `lastMessage` |
| `storedJob.rendered` | Cùng nội dung + footer "Resume in Codex" của companion. Fallback khi `rawOutput` rỗng |
| `storedJob.result.status` | **Exit status thật** (0 trên cả 2 job đo được). Ghi vào `companionExitStatus`, **không** vào `exitCode` — job fail trả gì thì chưa đo được |
| `storedJob.result.touchedFiles` | **Danh sách file runtime tự khai đã ghi**, per-job. Job thật 25/08 trả đúng 1 file khớp evidence path |
| `job.summary` vs `storedJob.summary` | Hai thứ khác nhau: `job.summary` là trích câu trả lời; `storedJob.summary` là dòng đầu brief bị cắt. Cái app hiển thị là `storedJob.summary` |

`touchedFiles` là tín hiệu tác giả mà cổng write-scope hôm nay không có. Nó quy kết bằng
mtime, nên một session khác sửa file trong lúc run là gate báo oan — đúng ca Run A exit 2
ngày 25/08.

Mọi lỗi của `result` đều **không** làm job fail: ghi vào `replyError` rồi đi tiếp. Job đã
ghi evidence hợp lệ thì không được fail vì mất phần ghi chép.

### Ba job app song song — đo 2026-08-25

3 job app cùng lúc (2 Codex `--effort low` + 1 Anti `flash`): 3/3 xong, **0 job mất,
0 job fail**, cổng nghiệm thu exit 0. Tổng 132 giây so với 228 giây khi chạy tuần tự 2
job — song song ăn được thật.

Nhưng số app-server đi từ 1 lên **2**: một job Codex dùng app-server con của broker
(ppid = pid broker), job kia có process companion **detached** (ppid 1) tự spawn
app-server riêng. Đường phân nhánh ở `codex.mjs:623-637` có thật. `broker.log` rỗng nên
chưa biết cơ chế là `BROKER_BUSY` fallback hay mỗi background job vốn tự mở runtime.
App-server riêng tự dọn khi job xong. Chưa đo 3 job Codex cùng lúc.

### Codex app transport — đo 2026-08-25

Đường vào app của Codex là `codex-companion.mjs` trong plugin `codex-plugin-cc`, gọi
**thẳng**, không qua subagent. Hình dạng đã đo với companion 1.0.5:

| Lệnh | Trả về |
| --- | --- |
| `task --background --json` | `{ jobId, status:"queued", title, summary, logFile }` |
| `status <id> --wait --json` | `{ workspaceRoot, job, waitTimedOut, timeoutMs }` |
| `job.status` | `queued` / `running` / `completed` / `failed` / `cancelled` |
| `job.threadId` | id thread trong app — đã có sẵn lúc job settle, dùng làm `conversationId` |

Khác app mode của Anti ở một chỗ quan trọng: Codex **có tín hiệu hoàn thành thật**
(`--wait` chặn tới khi settle), nên adapter không phải poll file evidence để đoán. Trần
timeout vẫn giữ riêng vì `--wait` cũng treo được nếu broker chết; hết trần thì gọi
`cancel` trước khi báo lỗi.

Ba chỗ đã đo và **không** suy diễn được:

- Field `title` trong JSON luôn là `"Codex Task"`, không có cờ đặt tên — **nhưng app
  hiển thị theo `summary`**: danh sách thread hiện `Codex Companion Task: {dòng đầu brief}`
  (kiểm bằng mắt 25/08). Nên dòng đầu brief phải là title job; đó là thứ duy nhất phân biệt
  các thread trong app. Đừng kết luận từ riêng field `title` như phase 2 từng làm.
- Thread **hiện trong app Codex**, và 2 job Codex song song thì **hiện đủ 2**, không cái
  nào bị nuốt (đo 25/08, run B). Thread cũng lưu trên đĩa ở
  `~/.codex/sessions/.../rollout-*.jsonl` và resume được bằng `codex resume <id>`.
- **Nhưng KHÔNG hiện live.** Đo 25/08 bằng một job sống 224 giây: rollout có trên đĩa sau
  **8 giây**, app vẫn không thấy suốt cả job; phải **tắt app rồi mở lại** mới hiện. Cơ chế
  khớp dữ liệu (suy luận, chưa đo trực tiếp): app làm chủ backend riêng và chỉ đọc lại
  session store lúc khởi động, nên thread do backend khác ghi thì nó không hay.

  Hệ quả vận hành, khác nhau rõ giữa hai runtime:

  | | Anti app | Codex app |
  | --- | --- | --- |
  | Xem tiến trình lúc job chạy | **Được** — session hiện live trong Antigravity 2.0 | **Không** |
  | Mở lại sau khi xong | được | được, nhưng phải restart app; hoặc `codex resume <id>` |
  | Can thiệp giữa chừng | được | không |

  Nên với Codex, `transport: app` mua được **biên bản mở lại được + `conversationId` làm
  provenance**, không mua được **mặt điều khiển**. Đừng chọn `app` cho Codex vì nghĩ sẽ
  ngồi xem được.
- **Cảnh báo cho lần đo sau:** companion `spawn("codex", ["app-server"])`
  (`app-server.mjs:190`) nên process app-server đó *không phải* process của app desktop.
  Từ đó **không** suy ra được thread vắng mặt trong app: app đọc rollout theo yêu cầu, nên
  `lsof` không thấy handle và storage app không chứa thread id. Cả hai đều là bằng chứng
  vắng mặt vô giá trị — 25/08 đã kết luận sai một lần vì chúng. Chỉ mắt người mới trả lời
  được câu này.
- `sessionRuntime` **không** có ở `status <job-id>` (trả `null`). Nó chỉ có ở lệnh
  `setup` (`codex-companion.mjs:208`), nên adapter không ghi được transport mode từ đó.
  Tự tính thay: `broker.json` có `endpoint` → `shared` (`codex.mjs:906-922`).
- **Broker được dựng bởi chính lệnh dispatch**, không phải có sẵn hay không. Đo 25/08:
  trước job nào thì `direct`; sau job đầu thì broker sống và mọi job sau là `shared`.
  Đừng đo trạng thái broker khi chưa chạy job rồi kết luận máy không có broker.
- `--write` là **bắt buộc**, không theo `role`: mọi job crew đều phải tự ghi file
  evidence, nên app mode read-only thì không job nào qua được cổng evidence.

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
