# Cài `agent-crew`

Hướng dẫn cho người — hoặc cho con AI đang setup hộ — cài crew lên một máy mới, để Claude
điều phối được Codex và Antigravity làm việc song song ở bất kỳ repo nào.

## 1. Đây là gì, và không là gì

**Là:** động cơ điều phối, cài một lần cho cả máy. Claude làm foreman, giao job cho worker
(Codex, Antigravity), gom kết quả về file evidence, và chấm bằng cổng tự động thay vì tin
lời worker tự khai.

**Không là:** luật của dự án nào. Mục tiêu, cách tạo task, API tốn tiền… là của từng repo,
khai ở `CLAUDE.md` và `crew.config.json` của repo đó (mục 5).

## 2. Yêu cầu

| Thứ | Vì sao | Kiểm |
| --- | --- | --- |
| Node.js 20+ | Chạy toàn bộ script | `node --version` |
| `git` | Cổng phạm vi ghi đọc `git status`; repo phải là git repo | `git --version` |

**Không có phụ thuộc npm.** Mọi `import` là đường tương đối trong plugin hoặc `node:`
builtin.

Muốn dùng worker nào thì cài CLI của worker đó. Không cài cả hai cũng chạy được — chỉ
là mất đường đó:

| Worker | Cần | Kiểm |
| --- | --- | --- |
| Antigravity | CLI `agy` (headless) và/hoặc `agentapi` (app mode) | `agy --version` |
| Codex headless | CLI `codex` | `codex --version` |
| Codex app | Bỏ từ 2.0.4 — Codex chỉ chạy headless, không cần cài thêm | — |

## 3. Cài plugin

Trong Claude Code:

```text
/plugin marketplace add peterpan-digital/agent-crew
/plugin install agent-crew@agent-crew-marketplace
```

Chưa có bản trên GitHub thì trỏ marketplace vào bản clone: `/plugin marketplace add
~/Documents/agent-crew`.

Plugin mang theo ba thứ: skill `agent-crew`, lệnh `crew` (`bin/crew.mjs`), và hook
(`hooks/hooks.json`) cho SessionStart / UserPromptSubmit / Stop.

Rồi cài shim để gõ `crew` ở mọi thư mục — skill gọi lệnh qua tên này:

```bash
node <thư mục plugin>/bin/crew.mjs install    # ghi ~/.local/bin/crew
crew doctor
```

`<thư mục plugin>` của bản cài từ marketplace là
`~/.claude/plugins/cache/agent-crew-marketplace/agent-crew/<version>`.

Shim gọi node bằng đường ổn định và tự đưa thư mục node lên đầu `PATH`, nên chạy được cả
khi app GUI gọi nó với `PATH=/usr/bin:/bin`. `~/.local/bin` phải nằm trong `PATH` của shell.

Shim có hai kiểu, tự chọn theo chỗ chạy `crew install`:

| Chạy `crew install` từ | Shim | Khi plugin lên bản mới |
| --- | --- | --- |
| Cache của plugin (cài từ marketplace) | **Theo** bản đang cài: mỗi lần chạy đọc `~/.claude/plugins/installed_plugins.json` | Tự lên theo, không cần cài lại |
| Bản clone của repo (người sửa crew) | **Ghim** vào `bin/crew.mjs` của bản clone | Lên theo source; `git pull` là có |

`crew doctor` dòng `shim` nói shim đang là kiểu nào.

## 3b. Cập nhật lên bản mới

Trong terminal:

```bash
claude plugin marketplace update agent-crew-marketplace
claude plugin update agent-crew@agent-crew-marketplace
```

(hoặc `/plugin` trong Claude Code → chọn plugin → cập nhật). Rồi mở phiên Claude mới: phiên
đang mở vẫn dùng skill và hook của bản cũ.

- **Lệnh `crew`** lên theo không cần làm gì, nếu shim là kiểu theo. Shim cài trước 2.3.1 là
  kiểu ghim vào thư mục cache có số version; phiên Claude đầu tiên sau khi lên 2.3.1 trở đi,
  hook SessionStart tự đổi nó sang kiểu theo. Muốn đổi ngay thì chạy lại `crew install` từ
  thư mục bản mới.
- **Marketplace trỏ vào bản clone** (`/plugin marketplace add ~/Documents/agent-crew`): lệnh
  update chép từ thư mục đó, nên `git pull` trong bản clone trước.

## 4. Hook: im lặng ở repo chưa bật crew

Hook bắn ở **mọi** repo vì plugin cài cấp máy. Mỗi nhánh tự im khi repo chưa bật:

| Hook | Làm gì | Repo chưa bật |
| --- | --- | --- |
| SessionStart | In trạng thái phiên khác + bảng crew còn dở | Không in gì |
| UserPromptSubmit | Routing gate: gợi ý chia việc khi prompt khớp trigger, hoặc owner gõ `@anti`/`@codex` | Không in gì |
| Stop | Ghi trạng thái phiên này | Không ghi gì, không tạo thư mục |

"Bật" nghĩa là repo có `crew.config.json` hoặc thư mục `.crew/`. Trạng thái phiên chỉ ghi
khi thư mục state đã tồn tại (`crew init --state on`). Hook đi qua `bin/crew-hook.sh` —
tìm node kể cả khi PATH tối thiểu, không tìm được thì thoát 0 thay vì chặn phiên.

## 5. Bật crew cho một repo

```bash
cd <repo>
crew init            # .crew/ + .gitignore cho log thô; --state on để bật file trạng thái phiên
```

Luật riêng của repo chia hai chỗ:

| Chỗ | Khai gì |
| --- | --- |
| `CLAUDE.md` / `AGENTS.md` | Mục tiêu và đơn vị đo, phạm vi, cách tạo/đóng task, công cụ crew **không** được tự gọi, connector bị cấm, skill nào giao worker nào |
| `crew.config.json` | Thứ máy phải đọc: bố cục thư mục, file bảo vệ thêm, API tốn tiền, trigger routing gate |

`crew.config.json` đầy đủ các khoá: mục *Bố cục thư mục* và *Luật máy đọc* của
`README.md`. Không có file này vẫn chạy: run nằm ở `.crew/runs/{run}`, không cost gate,
routing gate chỉ nói khi owner gõ `@anti`/`@codex`.

Chưa khai mục tiêu ở `CLAUDE.md` vẫn chạy được — crew sẽ nói thẳng là nó đang xếp ưu
tiên mà không có mục tiêu để bám, thay vì tự bịa ra một cái.

## 6. Codex app mode (bỏ từ 2.0.4)

`crew add-job --worker codex --transport app` và `codex-run.mjs --mode app` bị từ chối từ
2.0.4, code của nó đã xoá ở 2.1.3; làm tiếp thread thì `crew run codex --resume <conversationId>`
ở headless. Phần dưới chỉ còn để hiểu run cũ, và cho `crew-reconcile --cancel-orphans` khi
phải hỏi companion về job app của run cũ.

App mode từng đi qua `codex-companion.mjs` của plugin `openai-codex`. Crew tìm nó ở:

1. `$CLAUDE_PLUGIN_ROOT/scripts/codex-companion.mjs`
2. `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs`

Máy nào chỉ có bản cache (`~/.claude/plugins/cache/...`) thì khai tay:

```bash
export CREW_CODEX_COMPANION=/duong/dan/den/codex-companion.mjs
```

Không tìm thấy thì adapter từng **ném lỗi**, không lặng lẽ rơi về headless — đổi transport
ngầm là cách tạo ra kết quả sai mà không ai biết.

## 7. Kiểm sau khi cài

```bash
node <thư mục plugin>/tests/run.mjs
```

Mong đợi: mọi file test pass, ở cả hai bố cục (`.crew/` và sổ task kiểu `tasks/`).

Thử một run thật, nhỏ nhất, trong một repo đã `git init`:

```bash
MP="$(crew new-run)"
crew add-job "$MP" --worker anti --role assist --model <tên từ crew doctor> --title "smoke"
printf 'Ghi đúng một dòng: hello\n' > /tmp/brief.md
crew run anti --manifest "$MP" --job 1 --prompt-file /tmp/brief.md --timeout 5m
crew collect "$MP"
```

## 8. Biến môi trường

| Biến | Việc |
| --- | --- |
| `CREW_ROLE=worker` | Guard chống đệ quy: worker không được dispatch worker. Adapter tự đặt cho tiến trình con. Tên cũ `MWG_CREW_ROLE` vẫn nhận |
| `CREW_CODEX_COMPANION` | Khai tay đường dẫn companion (mục 6). Tên cũ `MWG_CODEX_COMPANION` vẫn nhận |
| `CLAUDE_PLUGIN_ROOT` | Do Claude Code đặt cho hook của plugin |
| `CLAUDE_PROJECT_DIR` | Do Claude Code đặt; hook lấy làm gốc repo |
| `CREW_GATE_LOG` | Rẽ log routing gate sang file khác (cho test) |
| `MWG_STATE_DEBUG` | In thêm log khi suy trạng thái phiên |

## 9. Lỗi hay gặp

| Triệu chứng | Nguyên nhân |
| --- | --- |
| `crew: command not found` | Chưa chạy `crew install`, hoặc `~/.local/bin` không nằm trong `PATH` |
| `--evidence is required` | Mọi job phải ghi file evidence dưới `evidenceRoot`; dùng `crew run --manifest --job` để lấy từ sổ |
| `evidence path is outside the evidence root` | Evidence nằm ngoài `evidenceRoot`, hoặc `--workspace` trỏ sai gốc |
| `workspace is not a git work tree` | Chạy `git init` ở repo |
| `crew.config.json: khoá lạ …` | Gõ sai tên khoá; thông báo in danh sách khoá hợp lệ |
| `routingTriggers[…] khớp API tốn tiền` | Trigger trùng tên trong `costGate`; việc tốn tiền không được gợi ý chia việc |
| `evidence file already exists` | Dùng đường dẫn mới cho mỗi job — file cũ sẽ bị nhầm là bằng chứng của lần này |
| `unknown flag --xxx` | Gõ sai cờ. Thông báo lỗi in ra danh sách cờ hợp lệ |
| `could not run agy` | Chưa cài CLI Antigravity, hoặc nó không có trong `PATH` |
| Companion không tìm thấy | Đặt `CREW_CODEX_COMPANION` (mục 6) |
