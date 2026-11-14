import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findManifest, forbiddenVar, linkVar, resolveProject, unlinkVar } from "./project";

let root: string;
let home: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agentpass-proj-")));
  home = join(root, "home");
  mkdirSync(home);
  process.env.AGENTPASS_HOME = home;
});

afterEach(() => {
  delete process.env.AGENTPASS_HOME;
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, data: unknown) {
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

describe("manifest discovery", () => {
  test("walks up from a subdirectory to the nearest manifest", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    write(join(repo, ".agentpass.json"), { env: { OPENAI_API_KEY: "openai" } });
    expect(findManifest(join(repo, "a", "b"))).toBe(join(repo, ".agentpass.json"));
    expect(findManifest(root)).toBeNull();
  });

  test("works in a git worktree because the manifest is committed", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    write(join(repo, ".agentpass.json"), { env: { STRIPE_SECRET_KEY: "stripe-test" } });
    git(repo, "add", ".agentpass.json");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    const wt = join(root, "wt");
    git(repo, "worktree", "add", "-q", wt);
    mkdirSync(join(wt, "sub"));

    const resolved = resolveProject(join(wt, "sub"));
    expect(resolved.manifest).toBe(join(wt, ".agentpass.json"));
    expect(resolved.env.STRIPE_SECRET_KEY).toEqual({ secret: "stripe-test", source: "project" });
  });
});

describe("manifest resolution", () => {
  test("project overrides global defaults per var", () => {
    write(join(home, "config.json"), { env: { OPENAI_API_KEY: "openai", GROQ_API_KEY: "groq" } });
    write(join(root, ".agentpass.json"), { env: { OPENAI_API_KEY: "openai-work" } });

    expect(resolveProject(root).env).toEqual({
      GROQ_API_KEY: { secret: "groq", source: "global" },
      OPENAI_API_KEY: { secret: "openai-work", source: "project" },
    });
  });

  test("works with no manifest and no global config", () => {
    expect(resolveProject(root)).toEqual({ manifest: null, env: {}, warnings: [] });
  });

  test("rejects invalid files with clear errors", () => {
    const m = join(root, ".agentpass.json");
    write(m, "{nope");
    expect(() => resolveProject(root)).toThrow(`${m}: invalid JSON`);
    write(m, { env: { "1BAD": "openai" } });
    expect(() => resolveProject(root)).toThrow(`${m}: invalid env var name "1BAD"`);
    write(m, { env: { GOOD: "bad name!" } });
    expect(() => resolveProject(root)).toThrow(`${m}: invalid secret name for GOOD`);
    write(m, { env: { GOOD: 42 } });
    expect(() => resolveProject(root)).toThrow(`${m}: invalid secret name for GOOD`);
    write(m, { env: ["x"] });
    expect(() => resolveProject(root)).toThrow(`${m}: "env" must be an object`);
    write(m, "[]");
    expect(() => resolveProject(root)).toThrow(`${m}: must be a JSON object`);
  });

  test("parse errors never echo file content", () => {
    const m = join(root, ".agentpass.json");
    const token = "sk_live_PLANTED123";
    for (const [file, text] of [
      [m, `{"env": {"OPENAI_API_KEY": ${token}}}`],
      [join(home, "config.json"), `{"env": {"OPENAI_API_KEY": "x" ${token}}`],
    ] as const) {
      write(file, text);
      let message = "";
      try {
        resolveProject(root);
      } catch (err) {
        message = String(err instanceof Error ? err.message : err);
      }
      expect(message).toBe(`${file}: invalid JSON`);
      rmSync(file);
    }
  });

  test("validates the global config too", () => {
    write(join(home, "config.json"), { env: { "A-B": "x" } });
    expect(() => resolveProject(root)).toThrow('invalid env var name "A-B"');
  });
});

describe("variable name policy", () => {
  const allowed = [
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "GITHUB_PAT",
    "GH_TOKEN",
    "GOOGLE_API_KEY",
    "NPM_TOKEN",
    "DATABASE_URL",
    "MONGODB_URI",
    "SENTRY_DSN",
    "TWILIO_ACCOUNT_SID",
    "DB_PASSWORD",
    "AWS_SECRET_ACCESS_KEY",
    "stripe_secret_key",
  ];
  const denied = [
    "GIT_CONFIG_GLOBAL",
    "GIT_TOKEN",
    "GIT_EXEC_PATH",
    "BASH_ENV",
    "ZDOTDIR",
    "PYTHONPATH",
    "PATH",
    "IFS",
    "HOME",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "NODE_AUTH_TOKEN",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "SSH_AUTH_SOCK",
    "GOAUTH",
    "GOPATH",
    "npm_config__auth",
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "AGENTPASS_TOKEN",
    "AGENTPASS_EXPORTED",
    "__AGENTPASS_SAVED_OPENAI_API_KEY",
    "_JAVA_OPTIONS",
    "HGRCPATH",
    "CLASSPATH",
    "SSLKEYLOGFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "SUDO_ASKPASS",
    "HISTFILE_KEY",
    "FOO",
    "STRIPE",
  ];

  test("only credential-shaped names that no shell, toolchain or agentpass reads", () => {
    expect(allowed.filter((n) => forbiddenVar(n) !== null)).toEqual([]);
    expect(denied.filter((n) => forbiddenVar(n) === null)).toEqual([]);
  });

  test("skips forbidden names in the manifest and global config with one warning each", () => {
    write(join(home, "config.json"), { env: { GROQ_API_KEY: "groq", PYTHONPATH: "p" } });
    write(join(root, ".agentpass.json"), { env: { OPENAI_API_KEY: "openai", GIT_CONFIG_GLOBAL: "g", BASH_ENV: "b" } });
    const resolved = resolveProject(root);
    expect(Object.keys(resolved.env)).toEqual(["GROQ_API_KEY", "OPENAI_API_KEY"]);
    expect(resolved.warnings).toHaveLength(3);
    for (const name of ["PYTHONPATH", "GIT_CONFIG_GLOBAL", "BASH_ENV"]) {
      expect(resolved.warnings.filter((w) => w.includes(` ${name}:`))).toHaveLength(1);
    }
  });

  test("link refuses forbidden names", () => {
    expect(() => linkVar(root, "GIT_CONFIG_GLOBAL", "g")).toThrow("cannot link GIT_CONFIG_GLOBAL");
    expect(() => linkVar(root, "BASH_ENV", "b")).toThrow("cannot link BASH_ENV");
    expect(linkVar(root, "GITHUB_TOKEN", "github")).toBe(join(root, ".agentpass.json"));
  });
});

describe("link and unlink", () => {
  test("creates the manifest at the git toplevel with sorted keys", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "deep"), { recursive: true });
    git(repo, "init", "-q");

    expect(linkVar(join(repo, "deep"), "ZED_KEY", "zed")).toBe(join(repo, ".agentpass.json"));
    linkVar(join(repo, "deep"), "ALPHA_KEY", "alpha");
    expect(readFileSync(join(repo, ".agentpass.json"), "utf-8")).toBe(
      '{\n  "env": {\n    "ALPHA_KEY": "alpha",\n    "ZED_KEY": "zed"\n  }\n}\n'
    );

    unlinkVar(join(repo, "deep"), "ZED_KEY");
    expect(JSON.parse(readFileSync(join(repo, ".agentpass.json"), "utf-8"))).toEqual({
      env: { ALPHA_KEY: "alpha" },
    });
  });

  test("edits the nearest existing manifest and keeps other keys", () => {
    write(join(root, ".agentpass.json"), { version: 1, env: { B_KEY: "b" } });
    mkdirSync(join(root, "sub"));
    linkVar(join(root, "sub"), "A_KEY", "a");
    expect(JSON.parse(readFileSync(join(root, ".agentpass.json"), "utf-8"))).toEqual({
      version: 1,
      env: { A_KEY: "a", B_KEY: "b" },
    });
  });

  test("validates names and refuses to unlink a missing var", () => {
    expect(() => linkVar(root, "BAD-NAME", "x")).toThrow('invalid env var name "BAD-NAME"');
    expect(() => linkVar(root, "OK", "{{x}}")).toThrow("invalid secret name for OK");
    expect(() => unlinkVar(root, "NOPE")).toThrow("NOPE is not linked");
  });
});
