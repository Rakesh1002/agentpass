import { spawnSync } from "child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { globalConfigFile } from "./paths";

export const MANIFEST_NAME = ".agentpass.json";

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Same charset the proxy accepts inside {{secret:NAME}}.
const SECRET_RE = /^[A-Za-z0-9_.-]+$/;

export interface Mapping {
  secret: string;
  source: "project" | "global";
}

export interface ResolvedProject {
  manifest: string | null;
  env: Record<string, Mapping>;
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
  } catch (err) {
    throw new Error(`${file}: invalid JSON (${err instanceof Error ? err.message : err})`);
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
  for (const [name, secret] of Object.entries(envOf(globalConfigFile()))) {
    env[name] = { secret, source: "global" };
  }
  if (manifest) {
    for (const [name, secret] of Object.entries(envOf(manifest))) {
      env[name] = { secret, source: "project" };
    }
  }
  const sorted: Record<string, Mapping> = {};
  for (const name of Object.keys(env).sort()) sorted[name] = env[name]!;
  return { manifest, env: sorted };
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
