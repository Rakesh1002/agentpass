import { readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";

export type Severity = "tracked" | "agent-config" | "shell-rc" | "env-file";

export interface Finding {
  file: string;
  line?: number;
  path?: (string | number)[];
  name: string;
  service: string;
  preview: string;
  severity: Severity;
  tracked: boolean;
}

const SEVERITY_ORDER: Severity[] = ["tracked", "agent-config", "shell-rc", "env-file"];
const SEVERITY_LABEL: Record<Severity, string> = {
  tracked: "tracked in git",
  "agent-config": "agent config",
  "shell-rc": "shell rc",
  "env-file": "untracked .env",
};

const B = "(?<![A-Za-z0-9_-])";
const E = "(?![A-Za-z0-9_-])";
const PATTERNS: [string, RegExp][] = [
  ["Anthropic", new RegExp(`${B}sk-ant-[A-Za-z0-9_-]{32,}`)],
  ["OpenRouter", new RegExp(`${B}sk-or-v1-[A-Za-z0-9]{32,}`)],
  ["OpenAI", new RegExp(`${B}sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}|${B}sk-[A-Za-z0-9]{32,}${E}`)],
  ["GitHub", new RegExp(`${B}(?:gh[pousr]_[A-Za-z0-9]{36}${E}|github_pat_[A-Za-z0-9_]{22,})`)],
  ["GitLab", new RegExp(`${B}glpat-[A-Za-z0-9_-]{20,}`)],
  ["Slack", new RegExp(`${B}xox[abpr]-[A-Za-z0-9-]{10,}`)],
  ["AWS", /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/],
  ["Stripe", new RegExp(`${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`)],
  ["Google", new RegExp(`${B}AIza[0-9A-Za-z_-]{35}${E}`)],
  ["Groq", new RegExp(`${B}gsk_[A-Za-z0-9]{20,}`)],
  ["HuggingFace", new RegExp(`${B}hf_[A-Za-z0-9]{30,}`)],
  ["npm", new RegExp(`${B}npm_[A-Za-z0-9]{36}${E}`)],
  ["SendGrid", new RegExp(`${B}SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}`)],
];

const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|(?:^|[_-])PAT(?:$|[_-])/i;
const PUBLIC_NAME = /PUBLIC|PUBLISHABLE/i;
const PLACEHOLDER = /\{\{secret:|\$\{|^\$|your[-_ ]|x{4,}|^x+$|change[-_]?me|example|placeholder|dummy|redacted|replace[-_]?me|<[^<>]*>|\*{3,}/i;
// Names start only at a token boundary so a long run cannot backtrack quadratically.
const ASSIGN = /(?:["']([A-Za-z_]\w{0,63})["']\s*:|(?<![\w.])([A-Za-z_]\w{0,63})\s*=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`,;)}\]]+))/g;
const DISPLAY_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_STRING = 16 * 1024;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

function looksRandom(v: string): boolean {
  return (
    v.length >= 16 &&
    !/\s/.test(v) &&
    /[0-9]/.test(v) &&
    /[A-Za-z]/.test(v) &&
    !/^[~.]?\//.test(v) &&
    !v.includes("://") &&
    !/^\d{4}-\d{2}-\d{2}/.test(v) &&
    entropy(v) >= 3.5
  );
}

export function detect(name: string, value: string): { service: string; token: string } | null {
  for (const [service, re] of PATTERNS) {
    const token = value.match(re)?.[0];
    if (token && !PLACEHOLDER.test(token)) return { service, token };
  }
  const token = value.trim().replace(/^(?:Bearer|Basic|token)\s+/i, "");
  if (SECRET_NAME.test(name) && !PUBLIC_NAME.test(name) && !PLACEHOLDER.test(token) && looksRandom(token)) {
    return { service: "Generic", token };
  }
  return null;
}

function secretish(s: string): boolean {
  if (detect("", s)) return true;
  const mixes = s.match(/[A-Za-z]\d|\d[A-Za-z]/g)?.length ?? 0;
  return s.length >= 8 && mixes >= 2 && !/^[~.]?\//.test(s) && entropy(s) >= 3;
}

function safeName(n: string): string {
  return DISPLAY_NAME.test(n) && !secretish(n) ? n : "";
}

interface Hit {
  name: string;
  service: string;
  token: string;
}

function scanString(name: string, value: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of value.matchAll(ASSIGN)) {
    const key = (m[1] ?? m[2])!;
    const hit = detect(key, m[3] ?? m[4] ?? m[5] ?? "");
    if (hit) hits.push({ ...hit, name: safeName(key) || safeName(name) });
  }
  if (hits.length > 0) return hits;
  const hit = detect(name, value);
  return hit ? [{ ...hit, name: safeName(name) }] : [];
}

type Raw = Omit<Finding, "severity" | "tracked" | "preview"> & { token: string };
type Scanned = { raws: Raw[]; oversized: boolean };

function scanLines(file: string, text: string, toml: boolean): Scanned {
  const raws: Raw[] = [];
  let oversized = false;
  let table: string[] = [];
  text.split("\n").forEach((rawLine, i) => {
    if (rawLine.length > MAX_STRING) {
      oversized = true;
      return;
    }
    const header = toml ? rawLine.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/) : null;
    if (header) {
      table = header[1]!.split(".").map((k) => k.trim().replace(/^["']|["']$/g, ""));
      return;
    }
    const line = rawLine.replace(/^\s*set\s+(?:-\w+\s+)+([A-Za-z_]\w*)\s+/, "$1=");
    for (const hit of scanString("", line)) {
      raws.push({ file, line: i + 1, ...(toml ? { path: [...table, hit.name] } : {}), ...hit });
    }
  });
  return { raws, oversized };
}

function scanJson(file: string, text: string): Scanned {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return scanLines(file, text, false);
  }
  const raws: Raw[] = [];
  let oversized = false;
  const walk = (v: unknown, path: (string | number)[], name: string) => {
    if (typeof v === "string") {
      if (v.length > MAX_STRING) oversized = true;
      else for (const hit of scanString(name, v)) raws.push({ file, path, ...hit });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, [...path, i], name));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, [...path, k], k);
    }
  };
  walk(data, [], "");
  return { raws, oversized };
}

// ls-files runs inside untrusted repos: core.fsmonitor would execute a repo-chosen program and a
// partial clone could lazily fetch (running ssh or credential helpers), so both are disabled.
function isTracked(file: string): boolean {
  try {
    const real = realpathSync(file);
    const r = Bun.spawnSync(
      [
        "git",
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.allow=never",
        "-C",
        dirname(real),
        "ls-files",
        "--error-unmatch",
        "--",
        basename(real),
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
      }
    );
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "Library"]);
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const MAX_DEPTH = 4;

function claudeSettings(dir: string): [string, Severity][] {
  try {
    return readdirSync(dir)
      .filter((n) => /^settings.*\.json$/.test(n))
      .map((n): [string, Severity] => [join(dir, n), "agent-config"]);
  } catch {
    return [];
  }
}

function repoCandidates(root: string): [string, Severity][] {
  const out: [string, Severity][] = [];
  const visit = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".claude") out.push(...claudeSettings(p));
        else if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) visit(p, depth + 1);
      } else if (e.isFile()) {
        if (e.name === ".mcp.json") out.push([p, "agent-config"]);
        else if ((e.name === ".env" || e.name.startsWith(".env.")) && !ENV_TEMPLATES.has(e.name)) out.push([p, "env-file"]);
      }
    }
  };
  visit(root, 0);
  return out;
}

export function scan(opts: { home: string; roots: string[] }): { findings: Finding[]; skipped: string[] } {
  const h = opts.home;
  const candidates: [string, Severity][] = [
    ...[".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"].map(
      (f): [string, Severity] => [join(h, f), "shell-rc"]
    ),
    ...[".claude.json", ".codex/config.toml", ".gemini/settings.json", ".cursor/mcp.json"].map(
      (f): [string, Severity] => [join(h, f), "agent-config"]
    ),
    ...claudeSettings(join(h, ".claude")),
    ...opts.roots.flatMap((r) => repoCandidates(resolve(r))),
  ];

  const seen = new Set<string>();
  const findings: Finding[] = [];
  const skipped: string[] = [];
  for (const [file, kind] of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    let text: string;
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) {
        skipped.push(file);
        continue;
      }
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const { raws, oversized } = file.endsWith(".json") ? scanJson(file, text) : scanLines(file, text, file.endsWith(".toml"));
    if (oversized) skipped.push(file);
    if (raws.length === 0) continue;
    const tracked = isTracked(file);
    for (const { token, path, ...rest } of raws) {
      findings.push({
        ...rest,
        ...(path ? { path: path.map((k) => (typeof k === "string" && secretish(k) ? mask(k) : k)) } : {}),
        preview: mask(token),
        severity: tracked ? "tracked" : kind,
        tracked,
      });
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  return { findings, skipped };
}

export function mask(value: string): string {
  return value.length < 12 ? "…" : `${value.slice(0, 4)}…${value.slice(-2)}`;
}

function where(f: Finding): string {
  if (f.line) return `line ${f.line}`;
  return (f.path ?? []).map((k, i) => (typeof k === "number" ? `[${k}]` : i === 0 ? k : `.${k}`)).join("");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const USAGE = "Usage: agentpass scan [--root <dir>]... [--json]";

function parseScanArgs(args: string[]): { roots: string[]; json: boolean } | null {
  const roots: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    if (a === "--json") json = true;
    else if (a.startsWith("--root=") && a.length > 7) roots.push(a.slice(7));
    else if (a === "--root" && next && !next.startsWith("--")) roots.push(args[++i]!);
    else return null;
  }
  return { roots, json };
}

export function runScan(args: string[]): number {
  const opts = parseScanArgs(args);
  if (!opts) {
    console.error(USAGE);
    return 2;
  }
  try {
    return report(opts.roots.length > 0 ? opts.roots : [process.cwd()], opts.json);
  } catch {
    console.error("agentpass scan: internal error");
    return 2;
  }
}

function report(roots: string[], json: boolean): number {
  const home = homedir();
  const { findings, skipped } = scan({ home, roots });
  const files = [...new Set(findings.map((f) => f.file))];
  const code = findings.length > 0 ? 1 : 0;

  if (json) {
    console.log(JSON.stringify({ findings, secrets: findings.length, files: files.length, skipped }, null, 2));
    return code;
  }

  const display = (file: string) => (file.startsWith(home + "/") ? "~" + file.slice(home.length) : file);
  for (const file of files) {
    const group = findings.filter((f) => f.file === file);
    console.log(`\n[${SEVERITY_LABEL[group[0]!.severity]}] ${display(file)}`);
    for (const f of group) {
      console.log(`  ${f.name || "(inline)"}  ${f.service}  ${f.preview}  (${where(f)})`);
    }
  }
  const skippedNote = skipped.length > 0 ? `Skipped oversized content in ${plural(skipped.length, "file")}.` : "";
  if (findings.length > 0) {
    console.log(
      `\nFound ${plural(findings.length, "plaintext secret")} in ${plural(files.length, "file")} that your AI agents can read.`
    );
    if (skippedNote) console.log(skippedNote);
  } else if (skippedNote) {
    console.log(`Nothing detected in the scanned content. ${skippedNote}`);
  } else {
    console.log("No plaintext secrets found in the places your AI agents read.");
  }
  return code;
}
