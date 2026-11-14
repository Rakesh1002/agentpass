import { accessSync, constants, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { KNOWN_SERVICES } from "./providers";
import { KEY_PREFIXES, makePlaceholder } from "./placeholder";
import { detect, ENV_TEMPLATES } from "./scan";

export interface Move {
  file: string;
  line: number;
  varName: string;
  secret: string;
  host: string;
  token: string;
  placeholder: string;
}

export interface Skip {
  file: string;
  line: number;
  varName: string;
  reason: string;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function envFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => (n === ".env" || n.startsWith(".env.")) && !ENV_TEMPLATES.has(n))
    .map((n) => join(dir, n))
    .filter((p) => statSync(p, { throwIfNoEntry: false })?.isFile())
    .sort();
}

// A provider prefix keeps BASE_URL routing and key pools working: OPENAI_API_KEY becomes openai-api-key.
function secretName(varName: string, service: string): string {
  const base = varName.toLowerCase().replace(/_/g, "-");
  return base === service || base.startsWith(`${service}-`) ? base : `${service}-${base}`;
}

// Plain sk- keys come from OpenAI, DeepSeek, Moonshot and others, so a variable named after a known service
// (DEEPSEEK_API_KEY) decides their host. Generic tokens stay skipped: STRIPE_WEBHOOK_SECRET or
// GITHUB_CLIENT_SECRET are never sent to that service's API host.
function serviceOf(varName: string, hit: { service: string; token: string }): string {
  const named = varName.split("_")[0]!.toLowerCase();
  const plainSk = hit.service === "OpenAI" && !/^sk-(?:proj|svcacct|admin)-/.test(hit.token);
  return plainSk && Object.hasOwn(KNOWN_SERVICES, named) ? named : hit.service.toLowerCase();
}

function keyPrefix(token: string): string {
  return KEY_PREFIXES.filter((p) => token.startsWith(p)).sort((a, b) => b.length - a.length)[0] ?? "";
}

export function planImport(files: string[]): { moves: Move[]; skips: Skip[] } {
  const moves: Move[] = [];
  const skips: Skip[] = [];
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (const file of files) {
    // the same file twice (or a symlink to one already read) would plan each line twice
    const real = realpathSync(file);
    if (seen.has(real)) continue;
    seen.add(real);
    for (const [i, text] of readFileSync(file, "utf-8").split("\n").entries()) {
      const m = text.replace(/\r$/, "").match(LINE);
      if (!m) continue;
      const at = { file, line: i + 1, varName: m[1]! };
      const hit = detect(at.varName, m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2"));
      if (!hit) continue;
      const service = serviceOf(at.varName, hit);
      const host = Object.hasOwn(KNOWN_SERVICES, service) ? KNOWN_SERVICES[service] : undefined;
      if (!host) {
        skips.push({
          ...at,
          reason: `no known API host for ${hit.service} keys; run agentpass add <name> --host <host>, then set ${at.varName}={{secret:<name>}}`,
        });
        continue;
      }
      const secret = secretName(at.varName, service);
      if (values.has(secret) && values.get(secret) !== hit.token) {
        skips.push({ ...at, reason: `${secret} already has a different value from an earlier line` });
        continue;
      }
      values.set(secret, hit.token);
      moves.push({ ...at, secret, host, token: hit.token, placeholder: makePlaceholder(secret, keyPrefix(hit.token)) });
    }
  }
  return { moves, skips };
}

// Every file is checked before any is written, and each is replaced atomically through its symlink.
export function rewriteEnvFiles(moves: Move[]): void {
  const out: [string, string][] = [];
  for (const file of new Set(moves.map((m) => m.file))) {
    const target = realpathSync(file);
    const lines = readFileSync(target, "utf-8").split("\n");
    for (const m of moves.filter((x) => x.file === file)) {
      const text = lines[m.line - 1] ?? "";
      const eq = text.indexOf("=");
      if (eq < 0 || !text.includes(m.token, eq)) throw new Error(`${file}:${m.line} changed since it was read, so no file was rewritten`);
      lines[m.line - 1] = text.slice(0, eq + 1) + text.slice(eq + 1).replaceAll(m.token, () => m.placeholder);
    }
    // a file that can't be written must stop the run before any other file changes
    accessSync(target, constants.W_OK);
    accessSync(dirname(target), constants.W_OK);
    out.push([target, lines.join("\n")]);
  }
  for (const [target, text] of out) {
    const tmp = `${target}.agentpass-tmp`;
    writeFileSync(tmp, text, { mode: statSync(target).mode & 0o777 });
    renameSync(tmp, target);
  }
}
