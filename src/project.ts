import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { globalConfigFile } from "./paths";
import { allow, disallow, isAllowed, readOwnedFile } from "./trust";

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
  trusted: boolean;
  env: Record<string, Mapping>;
  warnings: string[];
}

export class UntrustedError extends Error {
  constructor(manifest: string) {
    super(`${manifest} is not allowed yet, so nothing from it is exported. Review it, then run: agentpass allow`);
  }
}

export function checkVar(file: string, name: string): void {
  if (!VAR_RE.test(name)) throw new Error(`${file}: invalid env var name "${name}"`);
}

export function checkSecret(file: string, name: string, secret: unknown): void {
  if (typeof secret !== "string" || !SECRET_RE.test(secret)) {
    throw new Error(`${file}: invalid secret name for ${name} (allowed: letters, digits, _ . -)`);
  }
}

function parseConfig(file: string, text: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
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

function envOf(data: Record<string, unknown>): Record<string, string> {
  return (data.env as Record<string, string> | undefined) ?? {};
}

export function homeDir(): string | null {
  try {
    return realpathSync(process.env.HOME || homedir());
  } catch {
    return null;
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function gitRoot(dir: string): string | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

// A FIFO planted as .git or HEAD would otherwise block the hook forever.
function readRegular(path: string): string {
  if (!statSync(path).isFile()) throw new Error(`${path}: not a regular file`);
  return readFileSync(path, "utf-8");
}

// Reads HEAD instead of spawning git: no subprocess per cd, and the repo's config gets no say.
export function gitHead(dir: string): { repo: string; file: string; ref: string } | null {
  try {
    const top = gitRoot(realpathSync(dir));
    if (!top) return null;
    const dotgit = join(top, ".git");
    const gitdir = statSync(dotgit).isDirectory()
      ? dotgit
      : resolve(top, readRegular(dotgit).match(/^gitdir: (.*)$/m)?.[1]?.trim() ?? "");
    const file = join(gitdir, "HEAD");
    const head = readRegular(file).trim();
    const ref = head.startsWith("ref: ") ? head.slice(5).replace(/^refs\/heads\//, "") : head.slice(0, 7);
    return { repo: basename(top), file, ref };
  } catch {
    return null;
  }
}

interface Manifest {
  path: string;
  bytes: Buffer;
}

// The shell hook walks the same way: nearest manifest, stopping at the git toplevel or HOME, never above HOME.
function locate(dir: string, warnings: string[]): Manifest | null {
  const home = homeDir();
  let d: string;
  try {
    d = realpathSync(dir);
  } catch {
    return null;
  }
  if (!home || !within(d, home)) return null;
  for (; ; d = dirname(d)) {
    const candidate = join(d, MANIFEST_NAME);
    if (existsSync(candidate)) {
      try {
        const path = realpathSync(candidate);
        if (!within(path, home)) throw new Error("it resolves outside your home directory");
        return { path, bytes: readOwnedFile(path, false) };
      } catch (err) {
        warnings.push(`ignoring ${candidate}: ${err instanceof Error ? err.message : err}`);
        return null;
      }
    }
    if (d === home || existsSync(join(d, ".git"))) return null;
  }
}

export function findManifest(dir: string): string | null {
  return locate(dir, [])?.path ?? null;
}

export function resolveProject(dir: string): ResolvedProject {
  const warnings: string[] = [];
  const manifest = locate(dir, warnings);
  const trusted = manifest !== null && isAllowed(manifest.bytes);
  const env: Record<string, Mapping> = {};
  const add = (file: string, data: Record<string, unknown>, source: Mapping["source"]) => {
    for (const [name, secret] of Object.entries(envOf(data))) {
      const why = forbiddenVar(name);
      if (why) warnings.push(`${file}: skipping ${name}: ${why}`);
      else env[name] = { secret, source };
    }
  };
  const global = globalConfigFile();
  if (existsSync(global)) {
    let text: string | null = null;
    try {
      text = readOwnedFile(global).toString("utf-8");
    } catch (err) {
      warnings.push(`ignoring ${global}: ${err instanceof Error ? err.message : err}`);
    }
    if (text !== null) add(global, parseConfig(global, text), "global");
  }
  if (manifest && trusted) add(manifest.path, parseConfig(manifest.path, manifest.bytes.toString("utf-8")), "project");
  const sorted: Record<string, Mapping> = {};
  for (const name of Object.keys(env).sort()) sorted[name] = env[name]!;
  return { manifest: manifest?.path ?? null, trusted, env: sorted, warnings };
}

export function assertTrusted(dir: string): void {
  const manifest = locate(dir, []);
  if (manifest && !isAllowed(manifest.bytes)) throw new UntrustedError(manifest.path);
}

function mustLocate(dir: string): Manifest {
  const warnings: string[] = [];
  const manifest = locate(dir, warnings);
  if (!manifest) throw new Error(warnings[0] ?? `no ${MANIFEST_NAME} in ${resolve(dir)} or above it within HOME`);
  return manifest;
}

export function allowManifest(dir: string): string {
  const { path, bytes } = mustLocate(dir);
  allow(path, bytes);
  return path;
}

export function denyManifest(dir: string): string {
  const { path, bytes } = mustLocate(dir);
  disallow(path, bytes);
  return path;
}

function editManifest(dir: string, edit: (env: Record<string, string>) => void): string {
  const warnings: string[] = [];
  const manifest = locate(dir, warnings);
  if (warnings.length > 0) throw new Error(warnings[0]);
  const home = homeDir();
  const real = realpathSync(dir);
  if (!manifest && (!home || !within(real, home))) {
    throw new Error(`refusing to create ${MANIFEST_NAME} here: it only applies under your home directory`);
  }
  const top = gitRoot(real);
  const file = manifest?.path ?? join(top && home && within(top, home) ? top : real, MANIFEST_NAME);
  const data = manifest ? parseConfig(file, manifest.bytes.toString("utf-8")) : {};
  const env = { ...envOf(data) };
  edit(env);
  const sorted: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) sorted[name] = env[name]!;
  const text = JSON.stringify({ ...data, env: sorted }, null, 2) + "\n";
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, file);
  // The user made this edit; a manifest nobody reviewed stays unreviewed.
  if (!manifest || isAllowed(manifest.bytes)) allow(file, Buffer.from(text));
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
