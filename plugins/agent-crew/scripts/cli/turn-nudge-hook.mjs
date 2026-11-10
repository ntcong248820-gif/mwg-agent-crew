/**
 * Hook PostToolUse của plugin. Đi đường riêng, không qua `crew.mjs`: hook này
 * bắn ở mọi lượt gọi tool của mọi repo, nên chỉ nạp đúng module nó cần. Không có
 * bộ đếm của session (repo chưa bật aggressive) thì thoát sau một lần stat.
 * Luôn exit 0.
 */
import { readFileSync } from "node:fs";
import { onToolUse } from "../lib/turn-nudge.mjs";

try {
  const raw = readFileSync(0, "utf8");
  const text = raw.trim() ? onToolUse(JSON.parse(raw)) : null;
  if (text) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
  }
} catch { /* fail open */ }
