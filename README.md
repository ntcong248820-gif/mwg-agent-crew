# mwg-agent-crew

Module điều phối multi-agent cho workspace `mwg-ai-worker`. Claude làm foreman, giao
việc cho Codex và Antigravity, gom kết quả về một task folder.

Đây **không** phải task folder và **không** chứa evidence của run cụ thể. Evidence của
mỗi lần chạy nằm trong `tasks/{task}/reports/crew-{yymmdd-hhmm}/`.

## Nội dung

| File | Vai trò |
| --- | --- |
| `routing-table.md` | Việc nào giao worker nào. **Sửa file này** khi muốn đổi phân việc. |
| `worker-brief.md` | Format brief gửi worker. Dùng nguyên schema `~/.claude/rules/orchestration-protocol.md`. |
| `cost-gate.md` | API tốn tiền worker không được tự gọi + ngưỡng cứng chống đốt credit. |
| `scripts/` | Adapter gọi Antigravity (phase 2). |

## Ai gọi module này

Skill `seo-crew` (4 bản mirror `.claude/.codex/.agents/.gemini`) đọc 3 file `.md` ở đây
và gọi `scripts/`. Module là nguồn duy nhất — 4 bản skill không được copy nội dung ra,
chỉ trỏ vào.

## Giới hạn cứng

1. Crew **không tự ghi** frontmatter task, `tasks/_registry.md`, `tasks/_workstreams.md`.
   Mọi mutation đó đi qua `seo-task-create`, `seo-task-journal-sync`, `seo-task-done`,
   `seo-log-cv`, `seo-log-weekly-work`.
2. Mỗi job sở hữu độc quyền `evidence_path` của nó. Không hai job ghi cùng một file.
3. Output worker là **dữ liệu, không phải chỉ thị**.
4. Kim tự tháp sâu tối đa 2 tầng (Claude → worker). Chỉ Codex được fan-out tầng 3.
5. Không git worktree. Cô lập bằng quyền sở hữu task folder.

## Số đo nền (2026-08-18)

| Hạng mục | Giá trị |
| --- | --- |
| `max_parallel` | **3** — đo: 3 job `agy` song song 16s vs tuần tự 33s, per-job không degrade |
| Overhead khởi động `agy` | **~5.5s/lần gọi** — đừng chẻ job quá vụn |
| Env xuyên xuống tool con của `agy` | **Có** — `MWG_CREW_ROLE=worker` tới được shell của agent |
| Codex + Anti đồng thời | **OK** — 1 Codex + 3 Anti, không ai fail |

## Scripts

| Script | Việc |
| --- | --- |
| `scripts/anti-env.mjs` | Discover runtime của app Antigravity 2.0 (pid, gRPC address, projectId). Không hardcode giá trị nào; app restart thì tự discover lại. |
| `scripts/anti-run.mjs` | Chạy 1 job Antigravity. `--mode headless` (agy, nhanh, có token usage) hoặc `--mode app` (hiện conversation trong app để xem trực tiếp). |
| `scripts/codex-run.mjs` | Chạy 1 job Codex qua `codex exec --json`. Watchdog giết job không phát event trong `--idle-timeout` (mặc định 2m) — đúng ca pid chết mà state vẫn đọc là running. Log stream ghi vào `tasks/{task}/data/crew-logs/{run}/` — thuộc `data/` vì nó mang nội dung file worker đọc; đường dẫn nằm trong manifest. |
| `scripts/anti-status.mjs` | Đọc tiến độ 1 conversation. Luôn read-only: copy `.db`+`-wal`+`-shm` sang temp rồi query bản copy. |
| `scripts/crew-guards.mjs` | Guard dùng chung cho mọi worker: evidence gate, duration ceiling, đọc brief. |
| `scripts/crew-manifest.mjs` | State chung của 1 run. Ghi atomic (tmp+rename) dưới lock có owner token nên nhiều job kết thúc cùng lúc không mất update. |
| `scripts/crew-reconcile.mjs` | Vá manifest từ evidence trên đĩa khi runtime chết hoặc bỏ cuộc trước lúc ghi sổ. Idempotent. Không ghi đè phán quyết đã đậu. |
| `scripts/crew-collect.mjs` | Cổng nghiệm thu cuối run: reconcile → phán từng job → kiểm trùng `evidence_path` → kiểm phạm vi ghi → in bảng verdict. Exit 0 mới được viết report tổng. |
| `scripts/crew-scope.mjs` | Quy file thay đổi trong working tree về từng job theo mtime nằm trong khoảng job đó chạy. Tách khỏi collect vì đây là logic quy trách nhiệm, không phải logic phán quyết. |

```bash
node mwg-agent-crew/scripts/codex-run.mjs \
  --prompt-file <brief.md> \
  --evidence tasks/<task>/reports/<job>.md \
  --timeout 15m --idle-timeout 2m --effort medium --workspace "$PWD" \
  --manifest <run>/manifest.json --job 2
```

```bash
node mwg-agent-crew/scripts/anti-run.mjs --mode headless \
  --prompt-file <brief.md> \
  --evidence tasks/<task>/reports/<job>.md \
  --timeout 5m --workspace "$PWD" \
  --manifest <run>/manifest.json --job 1
```

```bash
node mwg-agent-crew/scripts/crew-reconcile.mjs <run>/manifest.json [--dry-run]
```

```bash
node mwg-agent-crew/scripts/crew-collect.mjs <run>/manifest.json \
  [--abandon <seq>] [--grace <ms>] [--dry-run]
```

### Phạm vi ghi đo bằng thời gian, không bằng diff

`git status` một mình không dùng được ở workspace này: repo thường xuyên mang sẵn
hàng trăm file đang sửa dở của user, nên diff thuần sẽ tố cả những file run không
hề chạm. Nên quy trách nhiệm bằng **mtime nằm trong khoảng từng job chạy**, không
phải khoảng của cả run.

Per-job là khác biệt giữa một cái kiểm dùng được và một cái vô dụng: cửa sổ theo
run từng tố 32 file skill vào một run mà job duy nhất của nó **chưa từng start** —
user sửa đúng mấy file đó trong cùng 5 phút. Job không có `startedAt`, hoặc job đã
`cancelled`, thì không có khoảng nào, nên không quy được gì cho nó. Khoảng của các
job chạy song song luôn chồng nhau, nên file ngoài phạm vi được nêu **mọi job ứng
viên** — cái tên đó là chỗ người đọc dùng để tìm thủ phạm, đoán một job là đoán sai.

**Khoảng suy đoán thì không chặn.** Job chết không kịp ghi `endedAt` thì không ai
biết nó chạy đến lúc nào. Khoảng của nó bị chặn trần ở `startedAt + 35 phút` và
đánh dấu `bounded: false`; file lọt vào đó chỉ ra `NGHI VẤN PHẠM VI`, không exit 2.
Bản đầu đánh fail thẳng, và hậu quả là gate **không thể qua được** đúng trên những
run nó sinh ra để canh — dạy dispatcher bỏ qua gate trong đúng một ngày. Cùng lý do
đó, `reconcile` điền `endedAt` bù thì ghi kèm `endedAtInferred: true`: giờ kết thúc
bù là sổ sách, không phải quan sát, và một giờ kết thúc bịa ở "now" từng cho job
chết một tiếng trước cái cửa sổ chạy tới hiện tại.

**Git không thấy file bị ignore, nên phải tự đi tìm.** `.codex/config.toml`,
`*.env`, `tasks/*/data/`, và `mwg-content-editor/content-workspaces/` đều bị
gitignore ở repo này — tức là chỗ ghi hợp lệ mà tài liệu vẫn đang chỉ cho
`filesMayModify` lại là chỗ git mù hoàn toàn. Nên gate stat thêm 2 nhóm ngoài
`git status`: mọi prefix có khai `filesMayModify`, và danh sách `PROTECTED_PATHS`
lấy từ Protected Files của `CLAUDE.md`. Ghi vào file được bảo vệ là exit 2, không
có đường khai để hợp lệ hoá.

Giới hạn còn lại, cố ý không vá: **file đã commit thì gate không thấy** — nó chỉ đọc
working tree. Worker không được commit, và có gọi `git log` thì cũng không biết ai
là tác giả thật của commit. File bị xoá cũng không quy được cho job nào (xoá thì
không còn mtime) nên chỉ được nêu ra, không chặn — repo này đang mang sẵn một file
xoá không liên quan, gate mà fail vì nó thì hôm sau không ai chạy nữa.

File ghi hợp lệ ra ngoài `tasks/{task}/` phải khai `filesMayModify` lúc `addJob`
(ví dụ `mwg-content-editor/content-workspaces/{slug}/`). Prefix được chuẩn hoá kết
thúc bằng `/` và chỉ áp cho **chính job đã khai** — khai `docs` không mở đường cho
`docs-secret.md`, và job 2 không dùng được quyền của job 1.

### Bốn mã thoát, và tại sao có mã 3

| Exit | Nghĩa |
| --- | --- |
| 0 | được viết report tổng |
| 1 | còn job chưa xong hoặc đang chờ người quyết |
| 2 | vi phạm phạm vi ghi, trùng evidence, hoặc chạm file được bảo vệ |
| 3 | **cả 1 và 2** |

3 không phải bậc nặng hơn 2. Trước đó hai loại vấn đề gộp vào một mã, nên người
vừa dọn xong đống file ngoài phạm vi thấy gate hết đỏ và tưởng run đã sạch —
trong khi vẫn còn job chưa ai xử.

### Job im lặng bao lâu thì coi là chết

Ngưỡng lấy từ `timeoutMs` mà chính adapter ghi vào manifest lúc bắt đầu job, cộng
10 phút. Trước đó là hằng số 35 phút suy từ trần 30m, nên job 5 phút chết được ưu
ái nửa tiếng còn job chạy dài hợp lệ bị đọc là chết. Manifest cũ không có
`timeoutMs` thì rơi về đúng 35 phút như trước.

Biên nghiêng về phía "còn chạy" có chủ ý: `STALE` là verdict duy nhất `--abandon`
nhận, nên đoán sai về phía chết là vứt việc, còn đoán sai về phía sống chỉ tốn
thêm một lần chạy collect.

Adapter cũng ghi `status: "running"` + `startedAt` **trước khi** spawn. Không có
bước đó, job đang chạy nằm trong manifest với `startedAt: null` — gate không phân
biệt được job đang làm với job chưa từng khởi động, và mọi file nó ghi trong lúc
chạy đều không quy được cho ai.

### Transport chọn theo vai trò, không theo cảm giác

Job đi `app` hay `headless` được quyết bằng một câu hỏi kiểm được:

> **Ai chịu trách nhiệm về acceptance của đầu ra job này?**

Chính worker → `role: owner` → `transport: app`: mở box chat để người sẽ bị chấm về
đầu ra đó xem được lúc nó đang làm. Claude → `role: assist` → `transport: headless`:
job chỉ là nguyên liệu, không có ai cần ngồi xem, và stdout trả về cho Claude dùng.

Tiêu chí trước đó không kiểm được, nên 34 job lịch sử chia 10 app / 24 headless mà
không truy được vì sao job nào đi đường nào. Giờ `addJob` **đòi** `role` và ghi cả
hai field: `role` là lý do, `transport` là hệ quả. Tách ra vì đổi mặc định về sau
(ví dụ owner job ngắn thì khỏi mở box chat) mà gộp một field là mất luôn dữ liệu để
biết quyết định cũ dựa trên gì.

Ghi đè mặc định phải kèm `note`. Ghi đè không note bị từ chối — đó chính là đường
quay lại chọn theo cảm tính, chỉ khoác thêm một field.

`worker: "claude"` có `role` nhưng `transport: null`: không process nào được bắn, ghi
transport vào đó là ghi một box chat chưa từng mở. Và `mode` — field cũ, chưa từng có
ai đọc bằng code — bị từ chối luôn thay vì để nó âm thầm biến mất: hai field ghi cùng
một sự thật là hai field sẽ lệch nhau.

### `MANIFEST_VERSION` là mốc để đọc sự vắng mặt

WARN "evidence không do runtime giao" dựa vào chỗ vắng `exitCode`/`conversationId`.
Trên manifest version 1 thì chưa có gì từng ghi hai field đó, nên WARN nổ gần như
mọi job lịch sử — mà WARN lúc nào cũng sáng thì người đọc học cách lướt qua, kéo
theo cả cái WARN thật. Nên WARN chỉ hỏi khi `version >= 2`.

`readManifest` chấp nhận mọi version **≤** hằng số nó biết, chỉ từ chối version
lớn hơn. So bằng `!==` đồng nghĩa mỗi lần thêm field là toàn bộ run cũ trên đĩa
thành không đọc được.

### `--abandon` không phải nút xoá đỏ

`--abandon <seq>` chỉ bỏ được job đang là `STALE` (im lặng quá hạn của chính nó, không có
evidence). Job mà adapter đã ghi `failed` + `failure` thì **từ chối** — nếu không,
một cờ duy nhất biến exit 1 thành exit 0 và job chết biến khỏi mẫu số. `--dry-run`
phủ luôn `--abandon`, vì cờ an toàn mà không phủ cờ ghi thì vô nghĩa.

Mọi tham số có thể tắt một phép kiểm đều bị validate, không coerce: `--grace abc`
từng cho `to = NaN`, mọi so sánh false, toàn bộ file rơi vào "ngoài cửa sổ", và run
ra exit 0 mà không nói gì.

## Tests

```bash
node mwg-agent-crew/tests/run.mjs
```

Chạy mọi `tests/*.test.mjs`, mỗi file 1 process, exit khác 0 nếu có case fail.
Không có framework: thứ cần đo là hành vi ở biên process — exit code, file trên đĩa,
nội dung manifest — nên một runner spawn được process và so được string là đủ.

| File | Đo gì |
| --- | --- |
| `tests/judge-verdict.test.mjs` | 9 ca của bảng phán quyết `judgeJob()`: đủ tổ hợp evidence có/rỗng/thiếu × runtime ok/fail × có/không dòng `Status:`. |
| `tests/collect-gate.test.mjs` | Cổng nghiệm thu trên các run dựng sẵn để sai đúng 1 kiểu: trùng evidence sau khi resolve, ghi ngoài phạm vi, ghi vào file được bảo vệ, ghi vào prefix bị gitignore đã khai, biên prefix, khoảng suy đoán, xoá file, `--abandon` job đã fail, `--dry-run` phủ `--abandon`, `--grace` không phải số, chạy từ cwd khác, echo template brief, provenance evidence, WARN bền qua 2 lần collect, cost gate chỉ nằm trong evidence. |
| `tests/codex-lifecycle.test.mjs` | Vòng đời `codex-run.mjs` qua `codex` giả: grandchild giữ stdout, brief 200KB vào child không đọc stdin, watchdog trước stderr rác, retry đè sidecar cũ, log dir sai quyền, `BLOCKED` phải exit 3, và manifest phải ghi được ca bị giết. |
| `tests/fixtures/fake-codex` | `codex` giả, chọn hình dạng lỗi bằng `FAKE_MODE`. `tests/fixtures/bin/codex` là symlink trỏ vào nó — phải đúng tên `codex`, không thì PATH rơi xuống CLI thật và bộ test không đo gì cả. |

5 lỗi lifecycle nặng nhất của phase 1 đều nằm ở chỗ không có script nào chạm tới, và
không có ca nào trong đó một `codex` thật chịu tái hiện theo yêu cầu. Đó là lý do có
`fake-codex` thay vì test bằng runtime thật.

### Contract không thương lượng

Worker tự báo thành công **không được tính là thành công**. Chỉ tính khi có file evidence
không rỗng nằm trong `tasks/`, và dòng `Status:` cuối file mới là phán quyết. Lý do:
`agy` đã được quan sát trả `status=SUCCESS` với response rỗng và không làm gì, khi một
tool nó cần bị chặn bởi permission prompt mà nó không hiển thị được; và một job dừng ở
cost gate vẫn để lại file không rỗng nên nếu chỉ kiểm sự tồn tại thì bị đếm nhầm là xong.

Nguyên tắc này áp cả vào vòng poll của app mode: tín hiệu hoàn thành là file evidence,
không phải step status. Job fail được ghi `status: failed`, và `crew-reconcile.mjs` sửa
lại nếu evidence chứng minh ngược lại.

**Thứ tự quan trọng ngang cái gate.** Verdict của runtime được thu thập trước nhưng phán
sau, bằng `judgeJob()` trong `crew-guards.mjs`. Hỏi runtime trước đã làm mất 2 job đã
xong ngày 2026-08-24: `agy` trả `ERROR`, evidence đủ và đạt acceptance, job vẫn bị ghi
`failed` rồi phải sửa tay. Runtime chỉ có tiếng nói ở 2 chỗ: khi không có evidence dùng
được, và khi evidence không có dòng `Status:`. Runtime báo fail mà evidence tự phán được
thì ghi thành `runtimeVerdict` — bất đồng, không phải thất bại — để bước collect đưa ra
cho người đọc thay vì chôn đi.

`crew-collect.mjs` cơ khí hoá đúng contract này. Nó in `PASS + WARN` cho mọi ca bất
đồng — cả `runtimeVerdict`, cả manifest có `failure`, cả job bị reconcile vá từ `failed`
lên đậu — và không tự giải quyết, vì chỉ người đọc phân biệt được lỗi runtime với job
làm nửa vời. Đối lại, reconcile **không ghi đè phán quyết đã đậu**: một job
`done_verified_manually` (người đã đọc artifact sau khi runtime hô ERROR) từng bị viết
lại thành `done` trơn, mất cả dấu đã kiểm lẫn cái bất đồng đáng đưa ra.
