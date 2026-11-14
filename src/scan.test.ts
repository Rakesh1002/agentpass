import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { detect, mask, scan, type Finding } from "./scan";

// Built by concatenation so the repo itself never contains a scanner-shaped literal.
const BODY = "Q7mZ4kR9vT2wX8nB5cL3pH6jF1dS0gYa";
const T = {
  anthropic: "sk-ant-" + "api03-" + BODY + BODY,
  openaiProj: "sk-" + "proj-" + BODY + BODY,
  openai: "sk-" + BODY + "Ab12Cd34Ef56",
  github: "ghp" + "_" + BODY + "Kp3q",
  githubPat: "github" + "_pat_" + "11ABCDEFG0" + BODY,
  slack: "xox" + "b-" + "1234567890-" + BODY,
  aws: "AKIA" + "Q7MZ4KR9VT2WX8NB",
  stripe: "sk" + "_live_" + BODY,
  google: "AIza" + "Sy" + BODY + "_",
  groq: "gsk" + "_" + BODY,
  openrouter: "sk-or-" + "v1-" + BODY + BODY,
  hf: "hf" + "_" + BODY,
  generic: "a8F3kL9qZ2xV7mN4pR6tY1wE",
};

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentpass-scan-home-"));
  root = mkdtempSync(join(tmpdir(), "agentpass-scan-root-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

const cli = join(import.meta.dir, "cli.ts");

function run(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, "run", cli, "scan", ...args], {
    env: { ...process.env, HOME: home, AGENTPASS_HOME: join(home, ".agentpass"), ...env },
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function leaks(text: string, secrets: string[]) {
  const found: string[] = [];
  for (const s of secrets) {
    for (let i = 0; i + 8 <= s.length; i++) if (text.includes(s.slice(i, i + 8))) found.push(s.slice(i, i + 8));
  }
  return found;
}

function summary(findings: Finding[]) {
  return findings.map((f) => `${f.file.replace(home, "~").replace(root, "@")}|${f.name}|${f.service}`).sort();
}

describe("detect", () => {
  test("recognises known secret prefixes", () => {
    const cases: [string, string][] = [
      [T.anthropic, "Anthropic"],
      [T.openaiProj, "OpenAI"],
      [T.openai, "OpenAI"],
      [T.github, "GitHub"],
      [T.githubPat, "GitHub"],
      [T.slack, "Slack"],
      [T.aws, "AWS"],
      [T.stripe, "Stripe"],
      [T.google, "Google"],
      [T.groq, "Groq"],
      [T.openrouter, "OpenRouter"],
      [T.hf, "HuggingFace"],
    ];
    for (const [value, service] of cases) {
      expect(detect("WHATEVER", value)).toEqual({ service, token: value });
    }
    expect(detect("", `Bearer ${T.github}`)).toEqual({ service: "GitHub", token: T.github });
  });

  test("flags long high-entropy values under secret-like names", () => {
    expect(detect("MY_API_KEY", T.generic)?.service).toBe("Generic");
    expect(detect("DB_PASSWORD", T.generic)?.service).toBe("Generic");
    expect(detect("GITLAB_PAT", T.generic)?.service).toBe("Generic");
    expect(detect("Authorization", `Bearer ${T.generic}`)).toEqual({ service: "Generic", token: T.generic });
  });

  test("ignores placeholders, references and non-secrets", () => {
    const misses: [string, string][] = [
      ["OPENAI_API_KEY", "{{secret:openai}}"],
      ["OPENAI_API_KEY", "your-key-here"],
      ["OPENAI_API_KEY", "sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
      ["OPENAI_API_KEY", "${OPENAI_API_KEY}"],
      ["OPENAI_API_KEY", "$OPENAI_API_KEY"],
      ["API_KEY", "changeme"],
      ["API_KEY", ""],
      ["API_KEY", "<your-api-key-goes-here>"],
      ["AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE"],
      ["SECRET_TOKEN", "aaaaaaaaaaaaaaaaaaaaaaaa"],
      ["SECRET_TOKEN", "short1A"],
      ["SSH_KEY_PATH", "/Users/me/.ssh/id_ed25519_work"],
      ["TOKEN_URL", "https://auth.example.com/oauth2/token1"],
      ["NEXT_PUBLIC_SUPABASE_ANON_KEY", T.generic],
      ["PATH", "/usr/local/bin:/usr/bin:/opt/homebrew/bin2"],
      ["NODE_ENV", T.generic],
      ["claudeCodeFirstTokenDate", "2025-11-03T09:41:27.586Z"],
      ["NOTE", "sk-this-is-not-a-real-key-at-all"],
      ["", "the task-runner masks secrets"],
    ];
    for (const [name, value] of misses) {
      expect([name, value, detect(name, value)]).toEqual([name, value, null]);
    }
  });
});

describe("scan locations", () => {
  test("finds secrets in every candidate location and skips the rest", () => {
    put(join(home, ".zshrc"), `export OPENAI_API_KEY="${T.openaiProj}"\nexport EDITOR=vim\n# export OLD_TOKEN=${T.github}\n`);
    put(join(home, ".zprofile"), `ANTHROPIC_API_KEY=${T.anthropic}\n`);
    put(join(home, ".bashrc"), `export GROQ_API_KEY='${T.groq}'\n`);
    put(join(home, ".bash_profile"), `export HF_TOKEN=${T.hf}\n`);
    put(join(home, ".profile"), `export SAFE=1\n`);
    put(join(home, ".config/fish/config.fish"), `set -gx STRIPE_SECRET_KEY ${T.stripe}\n`);
    put(
      join(home, ".claude.json"),
      JSON.stringify({
        primaryApiKey: T.anthropic,
        env: { OPENROUTER_API_KEY: T.openrouter },
        mcpServers: { github: { env: { GITHUB_TOKEN: T.github }, headers: { Authorization: `Bearer ${T.githubPat}` } } },
        projects: { "/some/repo": { mcpServers: { slack: { env: { SLACK_BOT_TOKEN: T.slack } } } } },
        customApiKeyResponses: { approved: ["Q7mZ4kR9vT2wX8nB5cL3"] },
      })
    );
    put(join(home, ".claude/settings.json"), JSON.stringify({ env: { AWS_ACCESS_KEY_ID: T.aws } }));
    put(join(home, ".codex/config.toml"), `model = "o3"\n\n[mcp_servers.github.env]\nGITHUB_PERSONAL_ACCESS_TOKEN = "${T.github}"\n`);
    put(join(home, ".gemini/settings.json"), JSON.stringify({ mcpServers: { g: { env: { GEMINI_API_KEY: T.google } } } }));
    put(join(home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { x: { env: { MY_SECRET: T.generic } } } }));

    const repo = join(root, "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    put(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { s: { env: { STRIPE_KEY: T.stripe } } } }));
    put(join(repo, ".claude/settings.json"), JSON.stringify({ env: { OPENAI_API_KEY: "{{secret:openai}}" } }));
    put(
      join(repo, ".claude/settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(npm test)", `Bash(OPENAI_API_KEY=${T.openai} node run.js)`] } })
    );
    put(join(repo, ".env"), `DATABASE_PASSWORD=${T.generic}\nPORT=3000\n`);
    put(join(repo, "packages/web/.env.local"), `NEXT_PUBLIC_URL=http://localhost\nGOOGLE_API_KEY=${T.google}\n`);
    put(join(repo, ".env.example"), `OPENAI_API_KEY=${T.openai}\n`);
    put(join(repo, ".env.sample"), `OPENAI_API_KEY=${T.openai}\n`);
    put(join(repo, ".env.template"), `OPENAI_API_KEY=${T.openai}\n`);
    put(join(repo, "node_modules/pkg/.env"), `OPENAI_API_KEY=${T.openai}\n`);
    put(join(repo, "dist/.env"), `OPENAI_API_KEY=${T.openai}\n`);
    put(join(root, "a/b/c/d/e/.git/HEAD"), "");
    put(join(root, "a/b/c/d/e/.env"), `OPENAI_API_KEY=${T.openai}\n`);
    const outside = mkdtempSync(join(tmpdir(), "agentpass-scan-outside-"));
    put(join(outside, ".env"), `OPENAI_API_KEY=${T.openai}\n`);
    symlinkSync(outside, join(root, "linked"));

    try {
      expect(summary(scan({ home, roots: [root] }).findings)).toEqual(
        [
          "~/.zshrc|OPENAI_API_KEY|OpenAI",
          "~/.zshrc|OLD_TOKEN|GitHub",
          "~/.zprofile|ANTHROPIC_API_KEY|Anthropic",
          "~/.bashrc|GROQ_API_KEY|Groq",
          "~/.bash_profile|HF_TOKEN|HuggingFace",
          "~/.config/fish/config.fish|STRIPE_SECRET_KEY|Stripe",
          "~/.claude.json|primaryApiKey|Anthropic",
          "~/.claude.json|OPENROUTER_API_KEY|OpenRouter",
          "~/.claude.json|GITHUB_TOKEN|GitHub",
          "~/.claude.json|Authorization|GitHub",
          "~/.claude.json|SLACK_BOT_TOKEN|Slack",
          "~/.claude/settings.json|AWS_ACCESS_KEY_ID|AWS",
          "~/.codex/config.toml|GITHUB_PERSONAL_ACCESS_TOKEN|GitHub",
          "~/.gemini/settings.json|GEMINI_API_KEY|Google",
          "~/.cursor/mcp.json|MY_SECRET|Generic",
          "@/app/.mcp.json|STRIPE_KEY|Stripe",
          "@/app/.claude/settings.local.json|OPENAI_API_KEY|OpenAI",
          "@/app/.env|DATABASE_PASSWORD|Generic",
          "@/app/packages/web/.env.local|GOOGLE_API_KEY|Google",
        ].sort()
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("records precise locations and masked previews only", () => {
    put(join(home, ".zshrc"), `export EDITOR=vim\nexport OPENAI_API_KEY=${T.openaiProj}\n`);
    put(join(home, ".claude.json"), JSON.stringify({ projects: { "/r": { mcpServers: { gh: { env: { GITHUB_TOKEN: T.github } } } } } }));
    put(join(home, ".codex/config.toml"), `[mcp_servers.gh.env]\n\nGITHUB_TOKEN = "${T.github}"\n`);
    put(join(home, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)", `Bash(curl -H 'Authorization: Bearer ${T.github}')`] } }));

    const findings = scan({ home, roots: [] }).findings;
    const byFile = (suffix: string) => findings.find((f) => f.file.endsWith(suffix))!;

    expect(byFile(".zshrc")).toMatchObject({ line: 2, name: "OPENAI_API_KEY", service: "OpenAI", preview: "sk-p…Ya", severity: "shell-rc", tracked: false });
    expect(byFile(".claude.json")).toMatchObject({ path: ["projects", "/r", "mcpServers", "gh", "env", "GITHUB_TOKEN"], severity: "agent-config" });
    expect(byFile("config.toml")).toMatchObject({ line: 3, path: ["mcp_servers", "gh", "env", "GITHUB_TOKEN"] });
    expect(byFile("settings.json")).toMatchObject({ path: ["permissions", "allow", 1], service: "GitHub", preview: "ghp_…3q" });
    for (const f of findings) {
      expect(JSON.stringify(f)).not.toContain(BODY.slice(4, 20));
    }
  });

  test("skips missing and unreadable files", () => {
    put(join(home, ".zshrc"), `export OPENAI_API_KEY=${T.openaiProj}\n`);
    put(join(home, ".claude.json"), `{ "env": { "GITHUB_TOKEN": "${T.github}" `);
    chmodSync(join(home, ".zshrc"), 0o000);
    try {
      const findings = scan({ home, roots: [join(root, "does-not-exist")] }).findings;
      expect(summary(findings)).toEqual(["~/.claude.json|GITHUB_TOKEN|GitHub"]);
    } finally {
      chmodSync(join(home, ".zshrc"), 0o600);
    }
  });

  test("marks git-tracked repo files as the most severe", () => {
    const repo = join(root, "svc");
    mkdirSync(repo);
    git(repo, "init", "-q");
    put(join(repo, ".env.production"), `STRIPE_KEY=${T.stripe}\n`);
    put(join(repo, ".env"), `OPENAI_API_KEY=${T.openaiProj}\n`);
    put(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { s: { env: { GITHUB_TOKEN: T.github } } } }));
    git(repo, "add", ".env.production", ".mcp.json");
    git(repo, "commit", "-qm", "init");

    const findings = scan({ home, roots: [root] }).findings;
    const sev = Object.fromEntries(findings.map((f) => [f.file.slice(repo.length + 1), [f.severity, f.tracked]]));
    expect(sev).toEqual({
      ".env.production": ["tracked", true],
      ".mcp.json": ["tracked", true],
      ".env": ["env-file", false],
    });
  });
});

describe("scan command", () => {
  test("exits 0 with nothing found", () => {
    put(join(root, "clean/.git/HEAD"), "");
    put(join(root, "clean/.env"), "PORT=3000\nAPI_KEY={{secret:openai}}\n");
    const r = run(["--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No plaintext secrets found");
    const j = run(["--json"]);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out)).toEqual({ findings: [], secrets: 0, files: 0, skipped: [] });
  });

  test("reports grouped, masked findings and never prints raw values", () => {
    const repo = join(root, "app");
    mkdirSync(repo);
    git(repo, "init", "-q");
    put(join(repo, ".env"), `OPENAI_API_KEY=${T.openaiProj}\nDB_PASSWORD=${T.generic}\n`);
    git(repo, "add", "-f", ".env");
    git(repo, "commit", "-qm", "oops");
    put(join(home, ".zshrc"), `export ANTHROPIC_API_KEY=${T.anthropic}\n`);
    put(join(home, ".claude.json"), JSON.stringify({ mcpServers: { gh: { env: { GITHUB_TOKEN: T.github } } } }));
    const other = join(home, "other");
    put(join(other, ".env"), `GROQ_API_KEY=${T.groq}\n`);

    const human = run(["--root", root, "--root", other]);
    expect(human.code).toBe(1);
    expect(human.out).toContain("Found 5 plaintext secrets in 4 files that your AI agents can read.");
    expect(human.out).toContain("sk-p…Ya");
    const order = ["tracked in git", "agent config", "shell rc", "untracked .env"].map((label) => human.out.indexOf(label));
    expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(true);

    const json = run(["--json", "--root", root, "--root", other]);
    expect(json.code).toBe(1);
    const parsed = JSON.parse(json.out);
    expect(parsed.secrets).toBe(5);
    expect(parsed.files).toBe(4);
    expect(parsed.findings[0]).toMatchObject({ severity: "tracked", tracked: true });

    for (const r of [human, json]) expect(leaks(r.out + r.err, Object.values(T))).toEqual([]);
  });

  test("rejects --root without a value as a usage error", () => {
    for (const args of [["--root"], ["--root", "--json"], ["--bogus"]]) {
      const r = run(args);
      expect([args, r.code]).toEqual([args, 2]);
      expect(r.out).toBe("");
      expect(r.err).toContain("Usage");
    }
  });

  test("keeps going without git on PATH", () => {
    const empty = join(root, "nobin");
    mkdirSync(empty);
    put(join(home, ".zshrc"), `export OPENAI_API_KEY=${T.openaiProj}\n`);
    const r = run(["--json", "--root", root], { PATH: empty });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).findings).toMatchObject([{ name: "OPENAI_API_KEY", tracked: false }]);
  });
});

describe("scan hardening", () => {
  test("never leaks secret fragments through names or paths", () => {
    const left = "x9" + "KEY" + "Q7mZ4kR9vT2w";
    const right = "pH6jF1dS0gYaUe3Lm8Nb2Vc5Xz";
    const left2 = "Zq8" + "KEYabc4521mnB";
    const keySecret = "ghp" + "_" + "Lm8Nb2Vc5XzQ7mZ4kR9vT2wX8nB5cL3pH6j";
    const tableSecret = "Wq8" + "Lm8Nb2Vc5XzQ7mZ4kR9vT2wX8nB5c";
    put(
      join(home, ".claude/settings.json"),
      JSON.stringify({
        env: { API_TOKEN: `${left}:${right}`, OTHER: `${left2}=${T.github}` },
        tokens: { [keySecret]: { auth: `Bearer ${T.anthropic}` } },
      })
    );
    put(join(home, ".codex/config.toml"), `[mcp_servers."${tableSecret}"]\nenv = { OPENAI_API_KEY = "${T.openaiProj}" }\n`);

    const findings = scan({ home, roots: [] }).findings;
    expect(findings.length).toBe(4);
    expect(findings.find((f) => f.service === "Anthropic")?.path).toEqual(["tokens", mask(keySecret), "auth"]);
    expect(findings.find((f) => f.file.endsWith(".toml"))?.path).toEqual(["mcp_servers", mask(tableSecret), "OPENAI_API_KEY"]);
    const secrets = [left, right, left2, keySecret, tableSecret, ...Object.values(T)];
    expect(leaks(JSON.stringify(findings), secrets)).toEqual([]);
    for (const args of [["--root", root], ["--json", "--root", root]]) {
      const r = run(args);
      expect(r.code).toBe(1);
      expect(leaks(r.out + r.err, secrets)).toEqual([]);
    }
  });

  test("does not run repo-configured fsmonitor hooks", () => {
    const repo = join(root, "evil");
    mkdirSync(repo);
    git(repo, "init", "-q");
    put(join(repo, ".env"), `OPENAI_API_KEY=${T.openaiProj}\n`);
    git(repo, "add", "-f", ".env");
    git(repo, "commit", "-qm", "x");
    const marker = join(root, "PWNED");
    put(join(root, "hook.sh"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(join(root, "hook.sh"), 0o755);
    git(repo, "config", "core.fsmonitor", join(root, "hook.sh"));

    const findings = scan({ home, roots: [repo] }).findings;
    expect(existsSync(marker)).toBe(false);
    expect(findings).toMatchObject([{ tracked: true }]);
  });

  test("reports a symlinked dotfile tracked in its real repo", () => {
    const dotfiles = join(root, "dotfiles");
    mkdirSync(dotfiles);
    git(dotfiles, "init", "-q");
    put(join(dotfiles, "zshrc"), `export OPENAI_API_KEY=${T.openaiProj}\n`);
    git(dotfiles, "add", "zshrc");
    git(dotfiles, "commit", "-qm", "x");
    symlinkSync(join(dotfiles, "zshrc"), join(home, ".zshrc"));

    expect(scan({ home, roots: [] }).findings).toMatchObject([{ severity: "tracked", tracked: true }]);
  });

  test("skips oversized files and lines quickly and says so", () => {
    put(join(home, ".zshrc"), `export A=${"a".repeat(80_000)}\nexport OPENAI_API_KEY=${T.openaiProj}\n`);
    put(join(home, ".bashrc"), `export GITHUB_TOKEN=${T.github}\n# ${"b".repeat(1_100_000)}\n`);

    const start = performance.now();
    const result = scan({ home, roots: [] });
    expect(performance.now() - start).toBeLessThan(200);
    expect(summary(result.findings)).toEqual(["~/.zshrc|OPENAI_API_KEY|OpenAI"]);
    expect(result.skipped.sort()).toEqual([join(home, ".bashrc"), join(home, ".zshrc")].sort());

    expect(run(["--root", root]).out).toContain("Skipped oversized content in 2 files");
    rmSync(join(home, ".zshrc"));
    const clean = run(["--root", root]);
    expect(clean.code).toBe(0);
    expect(clean.out).not.toContain("No plaintext secrets found");
    expect(clean.out).toContain("Skipped oversized content in 1 file");
  });

  test("scans a large ~/.claude.json instead of skipping it", () => {
    put(join(home, ".claude.json"), JSON.stringify({ env: { GITHUB_TOKEN: T.github }, pad: "b".repeat(1_100_000) }));
    const result = scan({ home, roots: [] });
    expect(summary(result.findings)).toEqual(["~/.claude.json|GITHUB_TOKEN|GitHub"]);
    expect(result.skipped).toEqual([join(home, ".claude.json")]);
  });

  test("scans every settings*.json under .claude", () => {
    put(join(root, "app/.claude/settings.team.json"), JSON.stringify({ env: { GITHUB_TOKEN: T.github } }));
    put(join(home, ".claude/settings.work.json"), JSON.stringify({ env: { GROQ_API_KEY: T.groq } }));
    expect(summary(scan({ home, roots: [root] }).findings)).toEqual([
      "@/app/.claude/settings.team.json|GITHUB_TOKEN|GitHub",
      "~/.claude/settings.work.json|GROQ_API_KEY|Groq",
    ]);
  });
});

describe("scan robustness", () => {
  test("masks short values fully and reveals at most a public prefix plus two chars", () => {
    expect(mask("Q7mZ4kR9vT2wX8n")).toBe("…");
    expect(mask("ghp" + "_Q7mZ4kR9vT2w")).toBe("gh…2w");
    expect(mask(T.anthropic)).toBe("sk-a…Ya");
    expect(mask(T.openaiProj)).toBe("sk-p…Ya");
    expect(mask(T.hf)).toBe("hf_…Ya");
    expect(mask(T.groq)).toBe("gsk_…Ya");
    expect(mask(T.generic)).toBe("…wE");
    expect(mask(T.aws)).toBe("…NB");
  });

  test("a deeply nested hostile JSON file is skipped without aborting the scan", () => {
    put(join(home, ".zshrc"), `export OPENAI_API_KEY=${T.openaiProj}\n`);
    put(join(root, "app/.mcp.json"), "[".repeat(200_000) + "]".repeat(200_000));

    const result = scan({ home, roots: [root] });
    expect(summary(result.findings)).toEqual(["~/.zshrc|OPENAI_API_KEY|OpenAI"]);
    expect(result.skipped).toEqual([join(root, "app/.mcp.json")]);

    const r = run(["--root", root]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Found 1 plaintext secret in 1 file");
  });

  test("masks secret-looking segments of file paths", () => {
    const fileSecret = "sk-" + "proj-" + "Lm8Nb2Vc5XzQ7mZ4kR9vT2wX8nB5cL3pH6j";
    put(join(root, "app", `.env.${fileSecret}`), `GITHUB_TOKEN=${T.github}\n`);
    for (const args of [["--root", root], ["--json", "--root", root]]) {
      const r = run(args);
      expect(r.code).toBe(1);
      expect(r.out).toContain(".env.sk-p…6j");
      expect(leaks(r.out + r.err, [fileSecret, ...Object.values(T)])).toEqual([]);
    }
  });
});
