#!/usr/bin/env node
/**
 * Which gws profile a `--workspace-cli on` job mints from, and the account check.
 *
 * The incident behind it (07/11): two profiles on one machine, crew minted from
 * the default one, the worker pointed the CLI at the other, refreshing that
 * profile needed a write the sandbox refused -- 401 that read as a flaky cache.
 *
 * The live mint and the live userinfo call are not faked into a "happy path"
 * here, for the reason workspace-cli-auth.test.mjs gives: a mock of Google would
 * only prove the mock. What is tested is the choice of profile, the comparison,
 * and that the adapter really asks the CLI for the profile it chose.
 *
 * Run: node plugins/agent-crew/tests/workspace-cli-profile.test.mjs
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAccount, expandProfileDir, listWorkspaceProfiles, resolveWorkspaceProfile, tokenEmail,
} from "../scripts/lib/workspace-cli-profile.mjs";
import { loadCrewConfig } from "../scripts/lib/crew-config.mjs";
import { CONFIG_NAME } from "../scripts/lib/crew-layout.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("workspace-cli-profile");
const HOME = "/home/owner";

// --- choosing the profile ----------------------------------------------------

t.check("~ expands", expandProfileDir("~/.config/gws-personal", HOME), "/home/owner/.config/gws-personal");
t.check("an absolute path stays", expandProfileDir("/srv/gws", HOME), "/srv/gws");
t.check("a relative path is refused", expandProfileDir(".config/gws", HOME), null);

{
  const env = { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "/env/gws" };
  const all = resolveWorkspaceProfile({ flag: "~/.config/gws-a", configDir: "~/.config/gws-b", env, home: HOME });
  t.check("the job's flag wins", all.dir, "/home/owner/.config/gws-a");
  t.check("...and says so", all.source, "--workspace-profile");
  const cfg = resolveWorkspaceProfile({ configDir: "~/.config/gws-b", env, home: HOME });
  t.check("then crew.config.json", cfg.dir, "/home/owner/.config/gws-b");
  const fromEnv = resolveWorkspaceProfile({ env, home: HOME });
  t.check("then the dispatcher env", fromEnv.dir, "/env/gws");
  const dflt = resolveWorkspaceProfile({ env: {}, home: HOME });
  t.check("then the CLI default", dflt.dir, "/home/owner/.config/gws");
  let threw = false;
  try { resolveWorkspaceProfile({ flag: "gws-personal", env: {}, home: HOME }); } catch { threw = true; }
  t.check("a relative --workspace-profile is refused", threw, true);
}

{
  const home = mkdtempSync(join(tmpdir(), "gwshome-"));
  for (const [name, file] of [["gws", "credentials.enc"], ["gws-personal", "credentials.enc"], ["gws-empty", null], ["other", "credentials.enc"]]) {
    mkdirSync(join(home, ".config", name), { recursive: true });
    if (file) writeFileSync(join(home, ".config", name, file), "x");
  }
  const found = listWorkspaceProfiles(home).map((d) => d.split("/").pop()).sort().join(",");
  t.check("profiles are gws* dirs holding a credential store", found, "gws,gws-personal");
}

// --- the account check -------------------------------------------------------

t.check("no declared account: nothing to verify", assertAccount({ expected: null, actual: "a@x.com", dir: "~/g" }).verified, false);
t.check("same account, case aside: verified",
  assertAccount({ expected: "Owner@Gmail.com", actual: "owner@gmail.com", dir: "~/g" }).verified, true);
{
  let msg = "";
  try { assertAccount({ expected: "me@gmail.com", actual: "other@gmail.com", dir: "~/.config/gws" }); } catch (err) { msg = err.message; }
  t.check("a different account is refused", /other@gmail\.com/.test(msg) && /me@gmail\.com/.test(msg), true);
  t.check("...and the refusal points at the fix", /--workspace-profile/.test(msg), true);
}
{
  let threw = false;
  try { assertAccount({ expected: "me@gmail.com", actual: null, dir: "~/g" }); } catch { threw = true; }
  t.check("a declared account with an unreadable identity is refused, not waved through", threw, true);
}

{
  const ok = async () => ({ ok: true, json: async () => ({ email: "me@gmail.com", sub: "123" }) });
  const denied = async () => ({ ok: false, json: async () => ({}) });
  const down = async () => { throw new Error("offline"); };
  t.check("userinfo answers with the email", await tokenEmail("tok", { fetchImpl: ok }), "me@gmail.com");
  t.check("a refused userinfo reads as unknown", await tokenEmail("tok", { fetchImpl: denied }), null);
  t.check("no network reads as unknown", await tokenEmail("tok", { fetchImpl: down }), null);
}

// --- crew.config.json --------------------------------------------------------

function configWith(extra) {
  const ws = tmpWorkspace("wsprofile-cfg-");
  const raw = JSON.parse(readFileSync(join(ws, CONFIG_NAME), "utf8"));
  writeFileSync(join(ws, CONFIG_NAME), JSON.stringify({ ...raw, ...extra }));
  return ws;
}
{
  const cfg = loadCrewConfig(configWith({ workspaceCliConfigDir: "~/.config/gws-personal", workspaceCliAccount: "me@gmail.com" }));
  t.check("config keeps the profile as written", cfg.workspaceCliConfigDir, "~/.config/gws-personal");
  t.check("config keeps the expected account", cfg.workspaceCliAccount, "me@gmail.com");
  t.check("absent keys read as null", loadCrewConfig(configWith({})).workspaceCliAccount, null);
  let a = false;
  try { loadCrewConfig(configWith({ workspaceCliConfigDir: ".config/gws" })); } catch { a = true; }
  t.check("a relative profile dir is refused at load", a, true);
  let b = false;
  try { loadCrewConfig(configWith({ workspaceCliAccount: "not-an-email" })); } catch { b = true; }
  t.check("a non-email account is refused at load", b, true);
}

// --- the adapter -------------------------------------------------------------

const ADAPTER = join(MODULE_ROOT, "scripts", "codex-run.mjs");
const ws = tmpWorkspace("wsprofile-run-");
const RUN_DIR_REL = join("tasks", "t", "reports", "crew-test");
const brief = writeFile(join(ws, "brief.md"), "do the thing\n");

function run({ evidence, extra = [], env = {} }) {
  const proc = spawnSync("node", [
    ADAPTER, "--prompt-file", brief, "--evidence", evidence, "--workspace", ws, "--timeout", "60s", ...extra,
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: "envdump", FAKE_EVIDENCE: join(ws, evidence), ...env },
    timeout: 90_000,
  });
  return { exit: proc.status, stderr: proc.stderr ?? "" };
}

{
  const r = run({ evidence: join(RUN_DIR_REL, "profile-no-cli.md"), extra: ["--workspace-profile", "~/.config/gws-personal"] });
  t.check("--workspace-profile without --workspace-cli on is refused", r.exit !== 0, true);
  t.check("...saying why", /chỉ có nghĩa khi kèm --workspace-cli on/.test(r.stderr), true);
}

{
  // A gws stub that records which profile it was asked for, then fails the
  // export: enough to prove the mint went to the chosen directory, with no
  // credential and no network involved.
  const fakeBin = join(ws, "profilebin");
  mkdirSync(fakeBin, { recursive: true });
  const seen = join(ws, "gws-asked-for.txt");
  const stub = join(fakeBin, "gws");
  writeFileSync(stub, `#!/bin/bash\necho "$GOOGLE_WORKSPACE_CLI_CONFIG_DIR" > "${seen}"\necho 'no credentials' >&2\nexit 1\n`);
  chmodSync(stub, 0o755);
  const profile = join(ws, "gws-personal");
  mkdirSync(profile, { recursive: true });
  const evidence = join(RUN_DIR_REL, "profile-mint.md");
  const r = run({
    evidence,
    extra: ["--workspace-cli", "on", "--workspace-profile", profile],
    env: { PATH: `${fakeBin}:${FIXTURE_BIN}:${process.env.PATH}`, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "/somewhere/else" },
  });
  t.check("the mint asks the CLI for the chosen profile, not the env one",
    existsSync(seen) ? readFileSync(seen, "utf8").trim() : "(stub never ran)", profile);
  t.check("...a failed mint still fails the job", r.exit !== 0, true);
  t.check("...before any worker is spawned", readdirSync(join(ws, RUN_DIR_REL)).includes("profile-mint.md"), false);
}

process.exit(t.finish() ? 0 : 1);
