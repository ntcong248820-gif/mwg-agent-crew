/**
 * Shim `~/.local/bin/crew`: viết, đọc, và tự nâng shim cũ.
 *
 * Hai kiểu shim, chọn theo chỗ `crew install` được chạy:
 *
 *   ghim     `crew install` chạy từ bản nguồn (repo clone) → shim trỏ cứng vào
 *            `bin/crew.mjs` của bản đó. Owner sửa source là `crew` đổi theo ngay.
 *   theo     `crew install` chạy từ cache của plugin
 *            (`~/.claude/plugins/cache/<marketplace>/agent-crew/<version>/`) →
 *            shim không ghi version: mỗi lần chạy nó đọc
 *            `installed_plugins.json` để lấy bản đang cài.
 *
 * Vì sao có kiểu "theo" (07/11): trước 2.3.1 shim nào cũng ghim. Người cài từ
 * GitHub thì ghim vào thư mục cache có số version, nên `/plugin update` xong
 * skill đã là bản mới mà lệnh `crew` vẫn chạy code bản cũ: skill bảo gọi
 * `crew quota`, lệnh trả "lệnh lạ". Đường của shim vẫn đứng yên
 * (`~/.local/bin/crew`) cho hook của Codex/Antigravity; chỉ đích của nó đi theo
 * bản cài.
 *
 * Shim ghim vào cache cũ đã nằm sẵn trên máy người dùng, nên hook SessionStart
 * gọi `upgradePinnedShim` để đổi nó sang kiểu "theo" một lần, không cần ai chạy
 * lại `crew install`.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";

export const SHIM_MARK = "# crew-shim: sinh bởi `crew install`";
const FOLLOW_MARK = "# crew-shim: theo bản plugin đang cài";

export const shimPath = (home = homedir()) => join(home, ".local", "bin", "crew");

/**
 * Đường node ổn định cho shim. `process.execPath` của Homebrew là đường có số
 * version (`.../Cellar/node/25.2.1/bin/node`): ghi cứng nó thì `brew upgrade
 * node` xong là shim gãy, đúng lúc PATH tối thiểu không còn chỗ nào để dò lại.
 * Lấy symlink ổn định nào trỏ về cùng file node đang chạy.
 */
export function stableNode(execPath = process.execPath, envPath = process.env.PATH ?? "") {
  const real = (p) => { try { return realpathSync(p); } catch { return null; } };
  const target = real(execPath);
  const candidates = [
    ...envPath.split(delimiter).filter(Boolean).map((d) => join(d, "node")),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  return candidates.find((c) => !c.includes("/Cellar/") && existsSync(c) && real(c) === target) ?? execPath;
}

/** `bin/crew.mjs` nằm trong cache plugin → `{ marketplace, version, key }`; bản nguồn → null. */
export function pluginInstallOf(crewBin) {
  const parts = crewBin.split(sep);
  const i = parts.lastIndexOf("cache");
  if (i < 1 || parts[i - 1] !== "plugins" || parts[i + 2] !== "agent-crew" || parts.at(-2) !== "bin") return null;
  return { marketplace: parts[i + 1], version: parts[i + 3], key: `agent-crew@${parts[i + 1]}` };
}

/**
 * JS chạy bằng `node -e` trong shim kiểu "theo". Chỉ dùng nháy kép: cả đoạn được
 * bọc nháy đơn cho sh. Thứ tự: bản `installed_plugins.json` ghi (scope user
 * trước) → bản lúc cài → báo lỗi kèm cách sửa.
 */
export function followResolverJs({ key, fallback }) {
  return [
    `const fs = await import("node:fs"), path = await import("node:path"), os = await import("node:os"), url = await import("node:url");`,
    `const key = ${JSON.stringify(key)}, fallback = ${JSON.stringify(fallback)};`,
    `const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");`,
    `let bin = null;`,
    `try {`,
    `  const reg = JSON.parse(fs.readFileSync(path.join(base, "plugins", "installed_plugins.json"), "utf8"));`,
    `  const rows = (reg.plugins ?? reg)[key] ?? [];`,
    `  const row = rows.find((r) => r.scope === "user") ?? rows[0];`,
    `  const b = row?.installPath && path.join(row.installPath, "bin", "crew.mjs");`,
    `  if (b && fs.existsSync(b)) bin = b;`,
    `} catch {}`,
    `if (!bin && fs.existsSync(fallback)) bin = fallback;`,
    `if (!bin) { process.stderr.write("crew: không thấy plugin " + key + " đã cài — cài lại bằng /plugin install " + key + "\\n"); process.exit(127); }`,
    // `node -e code -- a b` cho argv = [node, a, b]; crew.mjs đọc argv.slice(2).
    `process.argv.splice(1, 0, bin);`,
    `await import(url.pathToFileURL(bin).href);`,
  ].join("\n");
}

export function shimScript(nodeBin = stableNode(), crewBin) {
  const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
  const plugin = pluginInstallOf(crewBin);
  const run = plugin
    ? `exec "$NODE" --input-type=module -e ${q(followResolverJs({ key: plugin.key, fallback: crewBin }))} -- "$@"`
    : `exec "$NODE" ${q(crewBin)} "$@"`;
  return [
    "#!/bin/sh",
    SHIM_MARK,
    ...(plugin ? [`${FOLLOW_MARK} (${plugin.key})`] : []),
    `NODE=${q(nodeBin)}`,
    '[ -x "$NODE" ] || for c in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node)"; do [ -x "$c" ] && NODE="$c" && break; done',
    '[ -x "$NODE" ] || { echo "crew: không tìm thấy node" >&2; exit 127; }',
    'PATH="$(dirname "$NODE"):$PATH"; export PATH',
    run,
    "",
  ].join("\n");
}

/**
 * Shim trên đĩa là gì: `{ kind: "none" | "foreign" | "follow" | "pinned", key?, target?, node? }`.
 * `target` là đường crew.mjs của shim ghim; `node` là đường node nó ghi.
 */
export function readShim(path = shimPath()) {
  if (!existsSync(path)) return { kind: "none" };
  const body = readFileSync(path, "utf8");
  if (!body.includes(SHIM_MARK)) return { kind: "foreign" };
  const unq = (s) => s.replaceAll("'\\''", "'");
  const node = body.match(/^NODE='((?:[^']|'\\'')*)'$/m)?.[1];
  const follow = body.match(new RegExp(`^${FOLLOW_MARK} \\((.+)\\)$`, "m"));
  if (follow) return { kind: "follow", key: follow[1], node: node && unq(node) };
  const target = body.match(/^exec "\$NODE" '((?:[^']|'\\'')*)' "\$@"$/m)?.[1];
  return { kind: "pinned", target: target && unq(target), node: node && unq(node) };
}

/**
 * Shim ghim vào cache của chính plugin này (một version cũ) → ghi lại kiểu
 * "theo". Shim ghim vào bản nguồn, shim của người khác, hay bản đang chạy không
 * phải từ cache thì không đụng. Trả true khi đã ghi. Không throw.
 */
export function upgradePinnedShim({ crewBin, path = shimPath() } = {}) {
  try {
    const me = pluginInstallOf(crewBin);
    if (!me) return false;
    const shim = readShim(path);
    if (shim.kind !== "pinned" || !shim.target) return false;
    const pinned = pluginInstallOf(shim.target);
    if (!pinned || pinned.key !== me.key) return false;
    const node = shim.node && existsSync(shim.node) ? shim.node : stableNode();
    writeFileSync(path, shimScript(node, crewBin), { mode: 0o755 });
    chmodSync(path, 0o755);
    return true;
  } catch {
    return false;
  }
}
