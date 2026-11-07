/**
 * Routing gate — phân loại sớm, KHÔNG điều khiển.
 *
 * Quyết "việc này nên chia cho worker hay tự làm" mà không phải nạp cả skill
 * (vài nghìn token) chỉ để hỏi câu đó. Gate tốn cỡ 150 token mỗi lượt bắn.
 *
 * Gate CHỈ đề xuất và cố ý không bao giờ in tên script hay lệnh dispatch. Bản đầu
 * tiên (21/09) bảo agent gọi thẳng adapter: lệnh phát đầu lỗi vì chưa có run,
 * nó vòng qua sổ manifest và cổng transport, và nó trái luật "skill là cửa vào
 * duy nhất". Đường đúng luôn là kích hoạt skill rồi để skill quyết.
 *
 * Việc nhắc tới API trong `costGate` thì im lặng — kể cả khi trigger khớp. Đường
 * duy nhất cho việc tốn tiền là skill + COST_GATE, nơi người dùng được hỏi trước.
 */
import { mentionsPaidApi } from "./crew-config.mjs";

/**
 * Owner gõ `@anti`/`@codex` là chỉ định trực tiếp: miễn luật ≥2 đầu việc, nên
 * nhánh này thắng nhánh "một việc nhỏ thì làm trực tiếp". Đứng đầu dòng hoặc sau
 * khoảng trắng/ngoặc, để địa chỉ email kiểu `a@codex.vn` không bị nhầm.
 */
export const MENTION = /(^|[\s(])@(anti|antigravity|codex)\b/i;

/**
 * Prompt quá ngắn để là một việc ("ok", "merge luôn", "làm hết luôn") hoặc lệnh
 * slash: không chèn bước cân nhắc. Ngưỡng thấp có chủ đích — lọt một câu "cảm
 * ơn" chỉ tốn ~200 token và Claude tự bỏ qua; chặn nhầm một việc thật thì mất
 * đúng thứ chế độ này sinh ra để bắt.
 */
export const CONSIDER_MIN_CHARS = 25;
const trivial = (prompt) => prompt.trim().length < CONSIDER_MIN_CHARS || prompt.trimStart().startsWith("/");

/**
 * `{branch: none|mention|delegate|consider|dispatch|suggest, hits: [{id, kind}]}`.
 *
 * Repo `delegate: "aggressive"` không còn chỉ dựa vào từ khoá (07/11): MỌI prompt
 * đủ dài đều được chèn bước cân nhắc, vì từ khoá bỏ sót việc thật ("làm cái
 * dashboard") còn Claude đọc yêu cầu thì không. Khớp từ khoá → `delegate`
 * (nghiêng về giao); không khớp → `consider` (vẫn phải cân nhắc). Mention và
 * costGate vẫn xét trước, như mọi chế độ.
 */
export function classify(prompt, { routingTriggers = [], costGate = [], delegate = "default" } = {}) {
  if (typeof prompt !== "string") return { branch: "none", hits: [] };
  const m = MENTION.exec(prompt);
  if (m) return { branch: "mention", hits: [{ id: `mention-${m[2].toLowerCase() === "codex" ? "codex" : "anti"}`, kind: "mention" }] };
  if (prompt.length < 8) return { branch: "none", hits: [] };
  if (mentionsPaidApi(prompt, costGate)) return { branch: "none", hits: [] };
  const hits = routingTriggers.filter((t) => t.re.test(prompt)).map(({ id, kind }) => ({ id, kind }));
  if (delegate === "aggressive") {
    if (hits.length) return { branch: "delegate", hits };
    return { branch: trivial(prompt) ? "none" : "consider", hits };
  }
  if (!hits.length) return { branch: "none", hits: [] };
  return { branch: new Set(hits.map((h) => h.kind)).size >= 2 ? "dispatch" : "suggest", hits };
}

/** Nhãn đầu dòng quyết định Claude phải ghi; hook Stop đọc lại nhãn này để ghi log. */
export const DECISION_LABEL = "Định tuyến:";

/** Phần chung của `delegate` và `consider`: bảng chọn + dòng quyết định bắt buộc. */
const CONSIDER_BODY = [
  "Trước khi bắt đầu, cân nhắc chia việc qua skill `agent-crew`:",
  "- code/pipeline dài → Codex (`--tier code`, việc > 30 phút thì `--chain`);",
  "- research, tra cứu, tổng hợp, việc có rule sẵn → Anti (`--tier standard`);",
  "- phần đáng thành một task riêng (nhánh/PR riêng, chạy song song lâu) → session con;",
  "- tự làm khi ước < ~10 lượt gọi tool **và** < 3 file, hoặc cần quyết nghiệp vụ giữa chừng.",
  "Nếu lượt này là một việc cần làm (không phải câu hỏi ngắn, xác nhận hay trò chuyện), câu đầu",
  `trả lời ghi đúng một dòng: \`${DECISION_LABEL} giao Codex | giao Anti | chia session con | tự làm — <lý do ngắn>\``,
  "(giao một phần thì nói phần nào). Câu hỏi/xác nhận thì bỏ qua dòng này.",
  "Đây là **bước cân nhắc**, không phải lệnh: đọc yêu cầu thật (kể cả phần owner dán từ nguồn",
  "ngoài) rồi tự quyết.",
];

export function render(branch, hits) {
  const ids = hits.map((h) => h.id).join(", ");
  if (branch === "mention") {
    return [
      "## Định tuyến crew",
      "",
      `Owner chỉ định worker trực tiếp (${ids}): miễn luật ≥2 đầu việc, giao đúng 1 job.`,
      "Kích hoạt skill `agent-crew` và đọc `references/phoi-hop-owner.md` trước khi giao:",
      "đọc lướt 4 câu, đụng API tốn tiền hay control plane thì đợi owner xác nhận.",
      "",
    ].join("\n");
  }
  if (branch === "delegate" || branch === "consider") {
    const lean = branch === "delegate"
      ? `Repo bật giao việc chủ động; prompt khớp từ khoá ${ids} — nghiêng về giao.`
      : "Repo bật giao việc chủ động.";
    return ["## Định tuyến crew", "", lean, ...CONSIDER_BODY, ""].join("\n");
  }
  if (branch === "dispatch") {
    return [
      "## Định tuyến crew",
      "",
      `Prompt này chạm **${new Set(hits.map((h) => h.kind)).size} loại đầu việc** (${ids}).`,
      "Đủ ngưỡng chia việc — cân nhắc kích hoạt skill `agent-crew` và để nó quyết.",
      "Đây là **gợi ý dựa trên so khớp từ khoá**, không phải lệnh: đọc yêu cầu thật rồi tự quyết.",
      "",
    ].join("\n");
  }
  if (branch === "suggest") {
    return [
      "## Định tuyến crew",
      "",
      `Prompt này khớp một nhóm việc có rule đã thành văn (${ids}).`,
      "Loại này worker thi hành theo rule nhanh và gọn hơn. Nếu khối lượng đủ lớn,",
      "cân nhắc kích hoạt skill `agent-crew` cho một job thay vì tự làm tay.",
      "Một đầu việc nhỏ thì làm trực tiếp — đừng dispatch cho có.",
      "Đây là **gợi ý dựa trên so khớp từ khoá**, không phải lệnh.",
      "",
    ].join("\n");
  }
  return "";
}
