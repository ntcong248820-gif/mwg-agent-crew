#!/usr/bin/env node
/**
 * Shim `crew` theo bản plugin đang cài.
 *
 * Dựng một HOME giả có cache plugin hai version (2.2.1, 2.3.0) như máy người
 * cài từ GitHub, rồi kiểm: `crew install` chạy từ cache ra shim kiểu "theo";
 * shim đó chạy đúng bản mà `installed_plugins.json` ghi, kể cả sau khi
 * registry đổi version; shim cũ ghim vào 2.2.1 được hook SessionStart của
 * 2.3.0 tự đổi; shim ghim vào bản nguồn không bị đụng.
 *
 * Run: node plugins/agent-crew/tests/crew-shim.test.mjs
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginInstallOf, readShim, shimScript } from "../scripts/cli/crew-shim.mjs";
import { MODULE_ROOT, makeChecker } from "./helpers.mjs";

const t = makeChecker("crew-shim");
const BARE_PATH = "/usr/bin:/bin";
const KEY = "agent-crew@crew-mkt";

const home = mkdtempSync(join(tmpdir(), "shimhome-"));
const cache = join(home, ".claude", "plugins", "cache", "crew-mkt", "agent-crew");
const copy = (version) => {
  const dir = join(cache, version);
  cpSync(MODULE_ROOT, dir, { recursive: true, filter: (src) => !src.includes(`${MODULE_ROOT}/tests`) });
  // Dấu để biết shim đã chạy bản nào: dòng đầu của --help.
  const bin = join(dir, "bin", "crew.mjs");
  writeFileSync(bin, readFileSync(bin, "utf8").replace("dùng: crew", `dùng(${version}): crew`));
  return bin;
};
const old = copy("2.2.1");
const cur = copy("2.3.0");
const registry = (version) => {
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { [KEY]: [{ scope: "user", installPath: join(cache, version), version }] },
  }));
};
const env = { HOME: home, PATH: `${process.env.PATH}` };
const shim = join(home, ".local", "bin", "crew");
const runShim = (args, extraEnv = {}) => {
  const p = spawnSync(shim, args, { env: { HOME: home, PATH: BARE_PATH, ...extraEnv }, encoding: "utf8" });
  return { code: p.status, out: p.stdout ?? "", err: p.stderr ?? "" };
};
const ranVersion = (r) => r.out.match(/^dùng\(([^)]+)\)/)?.[1] ?? `(không rõ: ${r.err.trim().split("\n")[0]})`;

t.check("đường cache được nhận ra", pluginInstallOf(old)?.key, KEY);
t.check("...kèm version", pluginInstallOf(old)?.version, "2.2.1");
t.check("bản nguồn không phải cache", pluginInstallOf(join(MODULE_ROOT, "bin", "crew.mjs")), null);

// --- install từ cache → shim theo bản đang cài -------------------------------
{
  registry("2.2.1");
  const r = spawnSync(process.execPath, [old, "install"], { env, encoding: "utf8" });
  t.check("install từ cache: exit 0", r.status, 0);
  t.check("...in plugin nó theo", JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf("}") + 1)).follows, KEY);
  t.check("shim là kiểu theo", readShim(shim).kind, "follow");
  t.check("shim không ghi version nào ở lệnh exec", /exec "\$NODE" '\/.*2\.2\.1/.test(readFileSync(shim, "utf8")), false);
  t.check("registry 2.2.1 → chạy 2.2.1", ranVersion(runShim(["--help"])), "2.2.1");
  registry("2.3.0");
  t.check("/plugin update đổi registry → shim chạy 2.3.0, không cần cài lại", ranVersion(runShim(["--help"])), "2.3.0");
  t.check("PATH tối thiểu vẫn chạy", runShim(["--help"]).code, 0);
  t.check("exit code đi nguyên qua shim", runShim(["run", "gemini"]).code, 2);
  t.check("tham số giữ nguyên thứ tự", /worker phải là anti\|codex, nhận "gemini"/.test(runShim(["run", "gemini"]).err), true);
  const moved = mkdtempSync(join(tmpdir(), "shimcfg-"));
  t.check("CLAUDE_CONFIG_DIR không có registry → về bản lúc cài", ranVersion(runShim(["--help"], { CLAUDE_CONFIG_DIR: moved })), "2.2.1");
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "{ hỏng");
  t.check("registry hỏng → về bản lúc cài", ranVersion(runShim(["--help"])), "2.2.1");
}

// --- shim ghim kiểu cũ → hook SessionStart của bản mới tự đổi -----------------
const hook = (bin) => spawnSync(process.execPath, [bin, "hook", "session-start"], {
  input: "{}", env: { ...env, CLAUDE_PROJECT_DIR: home }, encoding: "utf8",
});
{
  registry("2.3.0");
  const oldStyle = shimScript("/usr/bin/false-node", old).split("\n").filter((l) => !l.startsWith("# crew-shim: theo")).join("\n")
    .replace(/^exec .*$/m, `exec "$NODE" '${old}' "$@"`)
    .replace("NODE='/usr/bin/false-node'", `NODE='${process.execPath}'`);
  writeFileSync(shim, oldStyle, { mode: 0o755 });
  t.check("shim kiểu cũ đọc ra là ghim vào 2.2.1", readShim(shim).target, old);
  t.check("...và chạy 2.2.1 dù registry là 2.3.0", ranVersion(runShim(["--help"])), "2.2.1");
  t.check("hook session-start luôn exit 0", hook(cur).status, 0);
  t.check("hook của bản mới đổi shim sang kiểu theo", readShim(shim).kind, "follow");
  t.check("...giữ đường node cũ", readShim(shim).node, process.execPath);
  t.check("...từ giờ chạy bản đang cài", ranVersion(runShim(["--help"])), "2.3.0");
}
{
  const source = join(MODULE_ROOT, "bin", "crew.mjs");
  writeFileSync(shim, shimScript(process.execPath, source), { mode: 0o755 });
  const before = readFileSync(shim, "utf8");
  hook(cur);
  t.check("shim ghim vào bản nguồn (owner) không bị hook đụng", readFileSync(shim, "utf8"), before);
  writeFileSync(shim, "#!/bin/sh\necho người khác\n");
  hook(cur);
  t.check("shim của người khác không bị đụng", readFileSync(shim, "utf8").includes("người khác"), true);
}

process.exit(t.finish() ? 0 : 1);
