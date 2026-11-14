import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, relative, resolve } from "path";
import { agentPassDir } from "./paths";

export type LockState = "on" | "partial" | "off" | "unreadable" | "not installed";

function home(): string {
  return process.env.HOME || homedir();
}

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(home(), ".claude");
}

function codexDir(): string {
  return process.env.CODEX_HOME || join(home(), ".codex");
}

export function claudeSettingsFile(): string {
  return join(claudeDir(), "settings.json");
}

export function codexRulesFile(): string {
  return join(codexDir(), "rules", "agentpass.rules");
}

// Which rules protect added, so --remove never takes out identical rules the user wrote first.
function recordFile(): string {
  return join(agentPassDir(), "protect.json");
}

function underHome(path: string): string | null {
  const rel = relative(home(), path);
  return rel && !rel.startsWith("..") ? `~/${rel}` : null;
}

// Fixed, whatever binary is running, so every launch method adds and removes the same rules.
function binaries(): string[] {
  return ["agentpass", join(agentPassDir(), "bin", "agentpass")];
}

// File rules take Claude Code's path syntax (`~/x` from HOME, `//x` from the root); Bash rules
// match the literal command text, so each program gets every spelling an agent is likely to type.
function claudePath(path: string): string {
  return underHome(path) ?? `/${path}`;
}

function spellings(program: string): string[] {
  const tilde = program.startsWith("/") ? underHome(program) : null;
  return tilde ? [program, tilde] : [program];
}

export function claudeRules(): string[] {
  const dir = agentPassDir();
  const keychain = ["security find-generic-password", "security dump-keychain", "security -i", "secret-tool lookup"];
  return [
    `Read(${claudePath(join(dir, "vault.*"))})`,
    `Read(${claudePath(join(dir, "agentpass-ca.key"))})`,
    `Read(${claudePath(join(dir, "certs"))}/**)`,
    `Edit(${claudePath(dir)}/**)`,
    ...binaries().flatMap(spellings).map((b) => `Bash(${b} *)`),
    ...keychain.flatMap((c) => [c, `/usr/bin/${c}`]).map((c) => `Bash(${c} *)`),
  ];
}

export function codexRules(): string {
  const rule = (pattern: unknown, reason: string) =>
    `prefix_rule(\n    pattern = ${JSON.stringify(pattern)},\n    decision = "forbidden",\n    justification = ${JSON.stringify(reason)},\n)\n`;
  return [
    "# Written by agentpass protect; remove with: agentpass protect --remove\n",
    rule([binaries()], "AgentPass is configured by you, not by the agent."),
    rule([["security", "/usr/bin/security"], ["find-generic-password", "dump-keychain", "-i"]], "The keychain holds the AgentPass vault key."),
    rule([["secret-tool", "/usr/bin/secret-tool"], "lookup"], "The keyring holds the AgentPass vault key."),
  ].join("\n");
}

// Follows symlinks by hand, so a dotfile link is written through even when its target is missing.
function linkTarget(file: string): string {
  let path = file;
  for (let hops = 0; hops < 40 && lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink(); hops++) {
    path = resolve(dirname(path), readlinkSync(path));
  }
  return path;
}

function writeAtomic(file: string, text: string): void {
  const target = linkTarget(file);
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.agentpass-tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, target);
}

function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err instanceof Error ? err.message : err}); fix it and rerun`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} is not a JSON object`);
  return data as Record<string, unknown>;
}

function denyList(file: string, settings: Record<string, unknown>): { permissions: Record<string, unknown>; deny: unknown[] } {
  const permissions = settings.permissions ?? {};
  if (typeof permissions !== "object" || Array.isArray(permissions)) throw new Error(`${file}: "permissions" is not an object`);
  const deny = (permissions as Record<string, unknown>).deny ?? [];
  if (!Array.isArray(deny)) throw new Error(`${file}: "permissions.deny" is not an array`);
  return { permissions: permissions as Record<string, unknown>, deny };
}

// null when there is no record, e.g. it was deleted with ~/.agentpass while the rules stayed.
function readRecord(): string[] | null {
  if (!existsSync(recordFile())) return null;
  try {
    const rules = JSON.parse(readFileSync(recordFile(), "utf-8")).claude;
    return Array.isArray(rules) ? rules.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

function editClaude(edit: (deny: unknown[]) => unknown[]): boolean {
  const file = claudeSettingsFile();
  const settings = readSettings(file);
  const { permissions, deny } = denyList(file, settings);
  const next = edit(deny);
  if (next.length === deny.length && next.every((r, i) => r === deny[i])) return false;
  writeAtomic(file, JSON.stringify({ ...settings, permissions: { ...permissions, deny: next } }, null, 2) + "\n");
  return true;
}

export function lockoutStatus(): { agent: string; file: string; state: LockState }[] {
  const out: { agent: string; file: string; state: LockState }[] = [];
  const claude = claudeSettingsFile();
  if (!existsSync(claudeDir())) out.push({ agent: "Claude Code", file: claude, state: "not installed" });
  else {
    try {
      const deny = denyList(claude, readSettings(claude)).deny;
      const have = claudeRules().filter((r) => deny.includes(r)).length;
      out.push({ agent: "Claude Code", file: claude, state: have === claudeRules().length ? "on" : have ? "partial" : "off" });
    } catch {
      out.push({ agent: "Claude Code", file: claude, state: "unreadable" });
    }
  }
  const codex = codexRulesFile();
  if (!existsSync(codexDir())) out.push({ agent: "Codex", file: codex, state: "not installed" });
  else {
    const current = existsSync(codex) ? readFileSync(codex, "utf-8") : null;
    out.push({ agent: "Codex", file: codex, state: current === codexRules() ? "on" : current ? "partial" : "off" });
  }
  return out;
}

export function protect(): string[] {
  const done: string[] = [];
  for (const { agent, file, state } of lockoutStatus()) {
    if (state === "not installed") continue;
    if (agent === "Claude Code") {
      const prior = readRecord();
      const record = new Set(prior ?? []);
      let added: string[] = [];
      editClaude((deny) => {
        added = claudeRules().filter((r) => !deny.includes(r));
        for (const r of added) record.add(r);
        return [...deny, ...added];
      });
      // no record and nothing added means the rules predate the record; leave it absent so --remove takes them all
      if (prior !== null || added.length > 0) {
        mkdirSync(agentPassDir(), { recursive: true, mode: 0o700 });
        writeAtomic(recordFile(), JSON.stringify({ claude: [...record] }, null, 2) + "\n");
      }
    } else writeAtomic(file, codexRules());
    done.push(`${agent}: ${file}`);
  }
  return done;
}

export function unprotect(): string[] {
  const done: string[] = [];
  // without a record, remove every current rule rather than leave the user unable to undo protect
  const record = readRecord() ?? claudeRules();
  if (existsSync(claudeSettingsFile()) && editClaude((deny) => deny.filter((r) => !record.includes(r as string)))) {
    done.push(`Claude Code: ${claudeSettingsFile()}`);
  }
  rmSync(recordFile(), { force: true });
  if (existsSync(codexRulesFile())) {
    rmSync(codexRulesFile());
    done.push(`Codex: ${codexRulesFile()}`);
  }
  return done;
}
