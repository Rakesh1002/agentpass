import { parseArgs } from "util";
import { readdirSync, readFileSync, statSync } from "fs";
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
const PLACEHOLDER = /\{\{secret:|\$\{|^\$|your[-_ ]|x{4,}|^x+$|change[-_]?me|example|placeholder|dummy|redacted|replace[-_]?me|<[^>]*>|\*{3,}/i;
const ASSIGN = /["']?([A-Za-z_][\w.-]*)["']?\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`,;)}\]]+))/g;

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

interface Hit {
  name: string;
  service: string;
  token: string;
}

function scanString(name: string, value: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of value.matchAll(ASSIGN)) {
    const key = m[1]!;
    const hit = detect(key, m[2] ?? m[3] ?? m[4] ?? "");
    if (hit) hits.push({ name: key, ...hit });
  }
  if (hits.length > 0) return hits;
  const hit = detect(name, value);
  return hit ? [{ name, ...hit }] : [];
}

type Raw = Omit<Finding, "severity" | "tracked" | "preview"> & { token: string };

function scanLines(file: string, text: string, toml: boolean): Raw[] {
  const out: Raw[] = [];
  let table: string[] = [];
  text.split("\n").forEach((rawLine, i) => {
    const header = toml ? rawLine.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/) : null;
    if (header) {
      table = header[1]!.split(".").map((k) => k.trim().replace(/^["']|["']$/g, ""));
      return;
    }
    const line = rawLine.replace(/^\s*set\s+(?:-\w+\s+)+([A-Za-z_]\w*)\s+/, "$1=");
    for (const hit of scanString("", line)) {
      out.push({ file, line: i + 1, ...(toml ? { path: [...table, hit.name] } : {}), ...hit });
    }
  });
  return out;
}

function scanJson(file: string, text: string): Raw[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return scanLines(file, text, false);
  }
  const out: Raw[] = [];
  const walk = (v: unknown, path: (string | number)[], name: string) => {
    if (typeof v === "string") {
      for (const hit of scanString(name, v)) out.push({ file, path, ...hit });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, [...path, i], name));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, [...path, k], k);
    }
  };
  walk(data, [], "");
  return out;
}

function isTracked(file: string): boolean {
  const r = Bun.spawnSync(["git", "-C", dirname(file), "ls-files", "--error-unmatch", "--", basename(file)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return r.exitCode === 0;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "Library"]);
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const MAX_DEPTH = 4;

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
        if (e.name === ".claude") {
          out.push([join(p, "settings.json"), "agent-config"], [join(p, "settings.local.json"), "agent-config"]);
        } else if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
          visit(p, depth + 1);
        }
      } else if (e.isFile()) {
        if (e.name === ".mcp.json") out.push([p, "agent-config"]);
        else if ((e.name === ".env" || e.name.startsWith(".env.")) && !ENV_TEMPLATES.has(e.name)) out.push([p, "env-file"]);
      }
    }
  };
  visit(root, 0);
  return out;
}

export function scan(opts: { home: string; roots: string[] }): Finding[] {
  const h = opts.home;
  const candidates: [string, Severity][] = [
    ...[".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"].map(
      (f): [string, Severity] => [join(h, f), "shell-rc"]
    ),
    ...[".claude.json", ".claude/settings.json", ".claude/settings.local.json", ".codex/config.toml", ".gemini/settings.json", ".cursor/mcp.json"].map(
      (f): [string, Severity] => [join(h, f), "agent-config"]
    ),
    ...opts.roots.flatMap((r) => repoCandidates(resolve(r))),
  ];

  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const [file, kind] of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    let text: string;
    try {
      if (!statSync(file).isFile()) continue;
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const raws = file.endsWith(".json") ? scanJson(file, text) : scanLines(file, text, file.endsWith(".toml"));
    if (raws.length === 0) continue;
    const tracked = isTracked(file);
    for (const { token, ...rest } of raws) {
      findings.push({ ...rest, preview: mask(token), severity: tracked ? "tracked" : kind, tracked });
    }
  }
  return findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
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

export function runScan(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  const roots = Array.isArray(values.root) ? values.root.filter((r): r is string => typeof r === "string") : [];
  const home = homedir();
  const findings = scan({ home, roots: roots.length > 0 ? roots : [process.cwd()] });
  const files = [...new Set(findings.map((f) => f.file))];

  if (values.json) {
    console.log(JSON.stringify({ findings, secrets: findings.length, files: files.length }, null, 2));
    return findings.length > 0 ? 1 : 0;
  }

  if (findings.length === 0) {
    console.log("No plaintext secrets found in the places your AI agents read.");
    return 0;
  }

  const display = (file: string) => (file.startsWith(home + "/") ? "~" + file.slice(home.length) : file);
  for (const file of files) {
    const group = findings.filter((f) => f.file === file);
    console.log(`\n[${SEVERITY_LABEL[group[0]!.severity]}] ${display(file)}`);
    for (const f of group) {
      console.log(`  ${f.name || "(inline)"}  ${f.service}  ${f.preview}  (${where(f)})`);
    }
  }
  console.log(
    `\nFound ${plural(findings.length, "plaintext secret")} in ${plural(files.length, "file")} that your AI agents can read.`
  );
  return 1;
}
