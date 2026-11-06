/**
 * Which Google Workspace CLI profile a `--workspace-cli on` job mints its token
 * from, and which account that token actually belongs to.
 *
 * Measured 07/11: a machine with two profiles (`~/.config/gws` for one Google
 * account, `~/.config/gws-personal` for another) minted from the default one,
 * because the dispatcher's env did not name a profile. The worker then pointed
 * the CLI at the profile its brief wanted; that profile's cached token had
 * expired, refreshing it means writing into `~/.config/gws-personal`, and the
 * Codex sandbox refused the write -- `401` plus "Operation not permitted". It
 * read as the old "token cache expired" flake and was retried twice, and the
 * one command that did pass may have run as the wrong account.
 *
 * So the profile is chosen explicitly (flag > crew.config.json > env > default),
 * the same directory is handed to the worker, and the minted token is asked who
 * it belongs to before anything spawns.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** `~` and `~/x` expand; anything else must already be absolute. */
export function expandProfileDir(value, home = homedir()) {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  if (v === "~") return home;
  if (v.startsWith("~/")) return join(home, v.slice(2));
  return isAbsolute(v) ? resolve(v) : null;
}

/**
 * The profile directory for this job, with where the choice came from.
 *
 * Order: the job's own `--workspace-profile`, then `workspaceCliConfigDir` in
 * crew.config.json, then `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` in the dispatcher's
 * env, then the CLI's own default.
 */
export function resolveWorkspaceProfile({ flag, configDir, env = process.env, home = homedir() } = {}) {
  if (flag !== undefined) {
    const dir = expandProfileDir(flag, home);
    if (!dir) throw new Error(`--workspace-profile cần đường tuyệt đối hoặc bắt đầu bằng ~/, nhận "${flag}"`);
    return { dir, source: "--workspace-profile" };
  }
  if (configDir) return { dir: expandProfileDir(configDir, home), source: "crew.config.json" };
  const fromEnv = expandProfileDir(env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR, home);
  if (fromEnv) return { dir: fromEnv, source: "GOOGLE_WORKSPACE_CLI_CONFIG_DIR" };
  return { dir: join(home, ".config", "gws"), source: "mặc định" };
}

/** Profile directories under ~/.config that hold a credential store. */
export function listWorkspaceProfiles(home = homedir()) {
  const base = join(home, ".config");
  try {
    return readdirSync(base)
      .filter((name) => name === "gws" || name.startsWith("gws-"))
      .map((name) => join(base, name))
      .filter((dir) => existsSync(join(dir, "credentials.enc")) || existsSync(join(dir, "credentials.json")));
  } catch {
    return [];
  }
}

/**
 * The email the access token was issued to, or null when Google will not say.
 *
 * Only the email leaves this function. The response also carries a subject id
 * and profile fields the crew has no use for.
 */
export async function tokenEmail(token, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const email = (await res.json())?.email;
    return typeof email === "string" && email.includes("@") ? email : null;
  } catch {
    return null;
  }
}

/**
 * Refuses a token that belongs to someone other than the declared account.
 *
 * With no declared account there is nothing to compare against, so it only
 * reports; with one, an unreadable identity is a refusal too -- "could not
 * check" must not pass as "checked".
 */
export function assertAccount({ expected, actual, dir }) {
  if (!expected) return { verified: false };
  if (!actual) {
    throw new Error(
      `không đọc được tài khoản của token từ hồ sơ ${dir}, nên không kiểm được nó có phải ${expected}`,
    );
  }
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `hồ sơ ${dir} là tài khoản ${actual}, không phải ${expected} như crew.config.json khai\n`
      + "  → chọn đúng hồ sơ bằng --workspace-profile hoặc workspaceCliConfigDir",
    );
  }
  return { verified: true };
}
