/**
 * Trigger mặc định cho repo khai `delegate: "aggressive"` mà không khai
 * `routingTriggers` riêng (hoặc khai thiếu): hai nhóm việc owner muốn đẩy khỏi
 * Claude — `code` sang Codex, `research` sang Anti.
 *
 * Viết sẵn cả có dấu lẫn không dấu (owner gõ cả hai), và neo bằng ranh giới chữ
 * Unicode: `\b` của JS chỉ hiểu [A-Za-z0-9_], nên "sửa lỗi" đứng sau chữ có dấu
 * sẽ khớp lung tung. Trigger repo cùng `id` thì thắng (crew-config gộp).
 *
 * Khớp từ khoá chỉ đẻ ra lời gợi ý, không cấp quyền gì: khớp rộng thì giao oan
 * một lần, lời gate có ngưỡng tự làm và log để chỉnh.
 */
const word = (alts) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{N}])`, "iu");

export const DEFAULT_ROUTING_TRIGGERS = Object.freeze([
  Object.freeze({
    id: "default-code",
    kind: "code",
    re: word([
      "implement", "refactor(?:ing)?", "migrate", "migration",
      "fix(?:ing)? (?:the )?bugs?", "bug ?fix", "write (?:unit |integration )?tests?",
      "viết (?:unit |)test", "viet (?:unit |)test", "sửa test", "sua test",
      "sửa lỗi", "sua loi", "fix lỗi", "fix loi",
      "thêm tính năng", "them tinh nang", "add (?:a |the )?feature",
      "viết script", "viet script", "write (?:a )?script",
    ]),
  }),
  Object.freeze({
    id: "default-research",
    kind: "research",
    re: word([
      "research", "tìm hiểu", "tim hieu", "so sánh", "so sanh", "compare",
      "tổng hợp", "tong hop", "tra cứu", "tra cuu",
      "đánh giá (?:các |)thư viện", "danh gia (?:cac |)thu vien", "evaluate (?:the )?librar(?:y|ies)",
    ]),
  }),
]);

/**
 * Trigger repo + mặc định chưa bị đè (theo `id`). Mặc định nào khớp tên API tốn
 * tiền thì bỏ, cùng luật trigger repo bị từ chối lúc nạp — nhưng ở đây là bỏ im
 * chứ không làm hỏng config, vì repo không viết ra nó.
 */
export function withDefaultTriggers(repoTriggers, costGate) {
  const taken = new Set(repoTriggers.map((t) => t.id));
  const defaults = DEFAULT_ROUTING_TRIGGERS.filter((t) => !taken.has(t.id) && !costGate.some(({ api }) => t.re.test(api)));
  return [...repoTriggers, ...defaults];
}
