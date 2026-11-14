import { spawnSync } from "child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { globalConfigFile } from "./paths";

export const MANIFEST_NAME = ".agentpass.json";

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Same charset the proxy accepts inside {{secret:NAME}}.
const SECRET_RE = /^[A-Za-z0-9_.-]+$/;

// Each SDK's default base URL path, rewritten to the local reverse route.
export const BASE_URLS: Record<string, { env: string; path: string }> = {
  anthropic: { env: "ANTHROPIC_BASE_URL", path: "" },
  openai: { env: "OPENAI_BASE_URL", path: "/v1" },
  groq: { env: "GROQ_BASE_URL", path: "" },
  openrouter: { env: "OPENROUTER_BASE_URL", path: "/api/v1" },
};

const CREDENTIAL_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PAT|CRED|CREDENTIAL|AUTH|DSN|_URL|URI|SID)/i;
const RESERVED = new Set([
  ..."PATH HOME IFS SHELL USER LOGNAME TMPDIR TMP TEMP PWD OLDPWD CDPATH FPATH MANPATH ENV BASH_ENV ZDOTDIR".split(" "),
  ..."PROMPT_COMMAND PS0 PS1 PS2 PS3 PS4 PROMPT RPROMPT EDITOR VISUAL PAGER BROWSER TERM LANG TZ".split(" "),
  ...Object.values(BASE_URLS).map((b) => b.env),
]);
// Placeholder values also land in paths and commands (a repo can commit a file named {{secret:x}}), so names a
// shell, toolchain or agentpass itself reads are off limits. `_` covers _JAVA_ and agentpass's own shell state,
// GO spares GOOGLE_, and PATH, ASKPASS and *FILE close names CREDENTIAL_RE would otherwise admit
// (HGRCPATH, CLASSPATH, SUDO_ASKPASS, SSLKEYLOGFILE).
const RESERVED_RE =
  /^(LD_|DYLD_|GIT_|SSH_|GPG|GNUPG|PYTHON|NODE_|NPM_CONFIG_|RUBY|GEM_|PERL|JAVA_|_|JDK_|MAVEN_|GRADLE_|DOTNET_|GO(?!OGLE_)|CARGO_|RUST|XDG_|LC_|LESS|SSL_|CURL_|REQUESTS_|AGENTPASS_|BUN_|DENO_|ZSH|BASH|HIST)|_PROXY$|PATH|ASKPASS|FILE$/i;

export function forbiddenVar(name: string): string | null {
  if (RESERVED.has(name.toUpperCase()) || RESERVED_RE.test(name)) return "reserved for the shell, a toolchain or agentpass";
  if (!CREDENTIAL_RE.test(name)) return "not a credential name (needs KEY, TOKEN, SECRET, PASSWORD, AUTH, _URL, ...)";
  return null;
}

export interface Mapping {
  secret: string;
  source: "project" | "global";
}

export interface ResolvedProject {
  manifest: string | null;
  env: Record<string, Mapping>;
  warnings: string[];
}

export function checkVar(file: string, name: string): void {
  if (!VAR_RE.test(name)) throw new Error(`${file}: invalid env var name "${name}"`);
}

export function checkSecret(file: string, name: string, secret: unknown): void {
  if (typeof secret !== "string" || !SECRET_RE.test(secret)) {
    throw new Error(`${file}: invalid secret name for ${name} (allowed: letters, digits, _ . -)`);
  }
}

function readConfig(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // The parser's message quotes the offending token, which may be a pasted secret.
    throw new Error(`${file}: invalid JSON`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${file}: must be a JSON object`);
  }
  const env = (data as Record<string, unknown>).env;
  if (env !== undefined) {
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw new Error(`${file}: "env" must be an object of VAR: secret-name`);
    }
    for (const [name, secret] of Object.entries(env)) {
      checkVar(file, name);
      checkSecret(file, name, secret);
    }
  }
  return data as Record<string, unknown>;
}

function envOf(file: string): Record<string, string> {
  return (readConfig(file).env as Record<string, string> | undefined) ?? {};
}

export function findManifest(dir: string): string | null {
  let d = resolve(dir);
  while (true) {
    const candidate = join(d, MANIFEST_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

export function resolveProject(dir: string): ResolvedProject {
  const manifest = findManifest(dir);
  const env: Record<string, Mapping> = {};
  const warnings: string[] = [];
  const add = (file: string, source: Mapping["source"]) => {
    for (const [name, secret] of Object.entries(envOf(file))) {
      const why = forbiddenVar(name);
      if (why) warnings.push(`${file}: skipping ${name}: ${why}`);
      else env[name] = { secret, source };
    }
  };
  add(globalConfigFile(), "global");
  if (manifest) add(manifest, "project");
  const sorted: Record<string, Mapping> = {};
  for (const name of Object.keys(env).sort()) sorted[name] = env[name]!;
  return { manifest, env: sorted, warnings };
}

function gitToplevel(dir: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function editManifest(dir: string, edit: (env: Record<string, string>) => void): string {
  const file = findManifest(dir) ?? join(gitToplevel(dir) ?? resolve(dir), MANIFEST_NAME);
  const data = readConfig(file);
  const env = { ...((data.env as Record<string, string> | undefined) ?? {}) };
  edit(env);
  const sorted: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) sorted[name] = env[name]!;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...data, env: sorted }, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

export function linkVar(dir: string, name: string, secret: string): string {
  checkVar(MANIFEST_NAME, name);
  checkSecret(MANIFEST_NAME, name, secret);
  const why = forbiddenVar(name);
  if (why) throw new Error(`cannot link ${name}: ${why}`);
  return editManifest(dir, (env) => {
    env[name] = secret;
  });
}

export function unlinkVar(dir: string, name: string): string {
  return editManifest(dir, (env) => {
    if (!(name in env)) throw new Error(`${name} is not linked`);
    delete env[name];
  });
}
