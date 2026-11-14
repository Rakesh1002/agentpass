import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { claudeRules, claudeSettingsFile, codexRulesFile, lockoutStatus, protect, unprotect } from "./lockout";
import { sandbox } from "./testing";

const KEYS = ["HOME", "AGENTPASS_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
let saved: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  root = realpathSync(mkdtempSync(join(tmpdir(), "agentpass-lockout-")));
  process.env.HOME = root;
  for (const k of ["AGENTPASS_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const settings = () => JSON.parse(readFileSync(claudeSettingsFile(), "utf-8"));
const states = () => Object.fromEntries(lockoutStatus().map((s) => [s.agent, s.state]));

test("protect adds the deny rules once and keeps the user's own settings", () => {
  mkdirSync(join(root, ".claude"));
  mkdirSync(join(root, ".codex"));
  writeFileSync(claudeSettingsFile(), JSON.stringify({ model: "opus", permissions: { deny: ["Read(./.env)"], allow: ["Bash(ls *)"] } }));

  expect(protect()).toHaveLength(2);
  protect();

  const s = settings();
  expect(s.model).toBe("opus");
  expect(s.permissions.allow).toEqual(["Bash(ls *)"]);
  expect(s.permissions.deny).toEqual(["Read(./.env)", ...claudeRules()]);
  expect(s.permissions.deny).toContain("Read(~/.agentpass/vault.*)");
  expect(s.permissions.deny).toContain("Bash(agentpass *)");
  // Bash rules match the command text, so the installed binary is denied by both spellings
  expect(s.permissions.deny).toContain(`Bash(${root}/.agentpass/bin/agentpass *)`);
  expect(s.permissions.deny).toContain("Bash(~/.agentpass/bin/agentpass *)");
  expect(s.permissions.deny).toContain("Bash(/usr/bin/security find-generic-password *)");
  // the CA certificate must stay readable for sandboxed commands
  expect(s.permissions.deny.some((r: string) => r.includes("agentpass-ca.crt") || r === "Read(~/.agentpass/**)")).toBe(false);
  expect(readFileSync(codexRulesFile(), "utf-8")).toContain('decision = "forbidden"');
  expect(states()).toEqual({ "Claude Code": "on", Codex: "on" });
});

test("unprotect removes only agentpass rules", () => {
  mkdirSync(join(root, ".claude"));
  mkdirSync(join(root, ".codex"));
  writeFileSync(claudeSettingsFile(), JSON.stringify({ permissions: { deny: ["Read(./.env)"] } }));
  protect();

  expect(unprotect()).toHaveLength(2);
  expect(settings().permissions.deny).toEqual(["Read(./.env)"]);
  expect(existsSync(codexRulesFile())).toBe(false);
  expect(states()).toEqual({ "Claude Code": "off", Codex: "off" });
  expect(unprotect()).toEqual([]);
});

test("unprotect keeps an identical rule the user had before protect", () => {
  mkdirSync(join(root, ".claude"));
  writeFileSync(claudeSettingsFile(), JSON.stringify({ permissions: { deny: ["Bash(agentpass *)"] } }));
  protect();
  unprotect();
  expect(settings().permissions.deny).toEqual(["Bash(agentpass *)"]);
});

test("unprotect still removes the rules when the record is gone", () => {
  mkdirSync(join(root, ".claude"));
  protect();
  rmSync(join(root, ".agentpass", "protect.json"));
  protect();
  expect(unprotect()).toHaveLength(1);
  expect(settings().permissions.deny).toEqual([]);
  expect(states()["Claude Code"]).toBe("off");
});

test("a dangling settings symlink is written through to its target", () => {
  mkdirSync(join(root, ".claude"));
  const real = join(root, "dotfiles", "claude", "settings.json");
  symlinkSync(real, claudeSettingsFile());
  protect();
  expect(lstatSync(claudeSettingsFile()).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(real, "utf-8")).permissions.deny).toEqual(claudeRules());
});

test("status reports unreadable settings instead of calling them off", () => {
  mkdirSync(join(root, ".claude"));
  writeFileSync(claudeSettingsFile(), "{ not json");
  expect(states()["Claude Code"]).toBe("unreadable");
});

test("agents that are not installed are left alone", () => {
  expect(protect()).toEqual([]);
  expect(existsSync(join(root, ".claude"))).toBe(false);
  expect(existsSync(join(root, ".codex"))).toBe(false);
  expect(states()).toEqual({ "Claude Code": "not installed", Codex: "not installed" });
});

test("invalid settings JSON is reported, not overwritten", () => {
  mkdirSync(join(root, ".claude"));
  writeFileSync(claudeSettingsFile(), "{ not json");
  expect(() => protect()).toThrow(/not valid JSON/);
  expect(readFileSync(claudeSettingsFile(), "utf-8")).toBe("{ not json");
});

test("a symlinked settings file stays a symlink", () => {
  mkdirSync(join(root, ".claude"));
  const real = join(root, "dotfiles-settings.json");
  writeFileSync(real, "{}");
  symlinkSync(real, claudeSettingsFile());
  protect();
  expect(lstatSync(claudeSettingsFile()).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(real, "utf-8")).permissions.deny).toEqual(claudeRules());
});

test("rules follow AGENTPASS_HOME outside HOME as absolute paths", () => {
  process.env.AGENTPASS_HOME = "/opt/agentpass";
  expect(claudeRules()).toContain("Read(//opt/agentpass/vault.*)");
  expect(claudeRules()).toContain("Bash(/opt/agentpass/bin/agentpass *)");
  expect(claudeRules().some((r) => r.startsWith("Bash(//"))).toBe(false);
});

const codex = Bun.which("codex");
test.skipIf(!codex)("codex parses the rules and forbids only agentpass and keychain reads", () => {
  mkdirSync(join(root, ".codex"));
  protect();
  const check = (...cmd: string[]) => {
    const r = spawnSync(codex!, ["execpolicy", "check", "--rules", codexRulesFile(), "--", ...cmd], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout).decision ?? "none";
  };
  expect(check("agentpass", "get", "openai")).toBe("forbidden");
  expect(check(join(root, ".agentpass", "bin", "agentpass"), "pins", "x", "--set", "evil.com")).toBe("forbidden");
  expect(check("security", "find-generic-password", "-s", "sh.agentpass", "-w")).toBe("forbidden");
  expect(check("/usr/bin/security", "find-generic-password", "-w")).toBe("forbidden");
  expect(check("git", "status")).toBe("none");
  expect(check("security", "find-identity", "-v")).toBe("none");
});

test("onboard sets up the vault, the lockout and the background proxy, and status reports them", () => {
  const box = sandbox();
  try {
    mkdirSync(join(box.home, ".claude"));
    const r = box.cli(["onboard"], { SHELL: "/bin/zsh" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("keychain mode");
    expect(r.out).toContain(join(box.home, ".claude", "settings.json"));
    expect(r.out).toContain("Started the AgentPass background proxy");
    expect(r.out).toContain('eval "$(agentpass hook zsh)"');
    expect(readFileSync(join(box.fakeDir, "argv.log"), "utf-8")).toMatch(/launchctl bootstrap|systemctl --user enable/);

    const status = box.cli(["doctor"]);
    expect(status.out).toContain("Agent lockout (Claude Code): on");
    expect(status.out).toContain("Agent lockout (Codex): not installed");
    expect(status.out).toContain("This shell: not using the proxy");
    expect(box.cli(["protect", "--remove"]).out).toContain("Removed the AgentPass rules");
    expect(box.cli(["status"]).out).toContain("Agent lockout (Claude Code): off (run: agentpass protect)");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});
