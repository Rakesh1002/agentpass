import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { certificateAuthority } from "./ca";
import { matchProvider } from "./providers";
import { caBundleFile, caCertFile, daemonFile, globalConfigFile } from "./paths";
import { allowManifest, forbiddenVar } from "./project";
import { buildEnv, ensureCaBundle, formatEnv, hookScript, proxyPort } from "./shellenv";
import { allow } from "./trust";

const CLI = resolve(import.meta.dir, "cli.ts");
const USER_HOME = process.env.HOME;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

process.umask(0o022);
let root: string;
let home: string;
let user: string;
let proj: string;
let other: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agentpass-env-")));
  home = join(root, "home");
  user = join(root, "user");
  process.env.AGENTPASS_HOME = home;
  process.env.HOME = user;
  certificateAuthority.ensureCa();

  proj = join(user, "proj");
  mkdirSync(join(proj, "sub"), { recursive: true });
  writeFileSync(
    join(proj, ".agentpass.json"),
    JSON.stringify({ env: { STRIPE_SECRET_KEY: "stripe-test", OPENAI_API_KEY: "openai-work" } })
  );
  allowManifest(proj);
  other = join(user, "other");
  mkdirSync(other);
  writeFileSync(join(other, ".agentpass.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "anthropic" } }));
  allowManifest(other);
});

afterAll(() => {
  delete process.env.AGENTPASS_HOME;
  process.env.HOME = USER_HOME;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.AGENTPASS_HOME = home;
  process.env.HOME = user;
  rmSync(daemonFile(), { force: true });
  rmSync(globalConfigFile(), { force: true });
});

describe("proxy port", () => {
  test("reads daemon.json and falls back to 8888", () => {
    expect(proxyPort()).toBe(8888);
    writeFileSync(daemonFile(), JSON.stringify({ port: 9123 }));
    expect(proxyPort()).toBe(9123);
    writeFileSync(daemonFile(), "garbage");
    expect(proxyPort()).toBe(8888);
  });
});

describe("buildEnv", () => {
  test("produces placeholders, proxy and CA settings without the vault", () => {
    writeFileSync(daemonFile(), JSON.stringify({ port: 9123 }));
    const env = buildEnv(join(proj, "sub"));
    const proxyUrl = "http://127.0.0.1:9123";
    expect(env).toEqual({
      OPENAI_API_KEY: "{{secret:openai-work}}",
      STRIPE_SECRET_KEY: "{{secret:stripe-test}}",
      OPENAI_BASE_URL: `${proxyUrl}/openai/v1`,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: caCertFile(),
      SSL_CERT_FILE: caBundleFile(),
      REQUESTS_CA_BUNDLE: caBundleFile(),
    });
    expect(existsSync(join(home, "vault.db"))).toBe(false);
  });

  test("provider base URLs hit the reverse route at each SDK's base path", () => {
    writeFileSync(
      globalConfigFile(),
      JSON.stringify({
        env: { A_KEY: "anthropic", O_KEY: "openai", G_KEY: "groq-2", R_KEY: "openrouter", X_KEY: "openaix" },
      })
    );
    const env = buildEnv(root, 8888);
    const expected: Record<string, [string, string]> = {
      ANTHROPIC_BASE_URL: ["anthropic", "/"],
      OPENAI_BASE_URL: ["openai", "/v1"],
      GROQ_BASE_URL: ["groq", "/"],
      OPENROUTER_BASE_URL: ["openrouter", "/api/v1"],
    };
    for (const [name, [provider, rest]] of Object.entries(expected)) {
      const url = new URL(env[name]!);
      expect(url.origin).toBe("http://127.0.0.1:8888");
      const match = matchProvider(url.pathname);
      expect(match?.provider.name).toBe(provider);
      expect(match?.rest).toBe(rest);
    }
    expect(Object.keys(env).filter((k) => k.endsWith("_BASE_URL")).sort()).toEqual(
      Object.keys(expected).sort()
    );
  });

  test("manifest vars cannot override the proxy settings", () => {
    writeFileSync(globalConfigFile(), JSON.stringify({ env: { HTTPS_PROXY: "evil" } }));
    expect(buildEnv(root, 8888).HTTPS_PROXY).toBe("http://127.0.0.1:8888");
  });

  test("every var the env layer sets is a name no manifest may map", () => {
    writeFileSync(
      globalConfigFile(),
      JSON.stringify({ env: { A_KEY: "anthropic", O_KEY: "openai", G_KEY: "groq", R_KEY: "openrouter" } })
    );
    const own = Object.keys(buildEnv(root, 8888)).filter((k) => !k.endsWith("_KEY"));
    expect(own.length).toBeGreaterThan(10);
    expect(own.filter((k) => forbiddenVar(k) === null)).toEqual([]);
  });
});

describe("CA bundle", () => {
  test("combines system roots with the AgentPass CA and regenerates only when stale", () => {
    rmSync(caBundleFile(), { force: true });
    const ca = readFileSync(caCertFile(), "utf-8");

    expect(ensureCaBundle(() => "ROOTS-1\n")).toBe(caBundleFile());
    expect(readFileSync(caBundleFile(), "utf-8")).toBe(`ROOTS-1\n${ca}`);

    ensureCaBundle(() => "ROOTS-2\n");
    expect(readFileSync(caBundleFile(), "utf-8")).toStartWith("ROOTS-1");

    const old = new Date(Date.now() - 60_000);
    utimesSync(caBundleFile(), old, old);
    ensureCaBundle(() => "ROOTS-3\n");
    expect(readFileSync(caBundleFile(), "utf-8")).toBe(`ROOTS-3\n${ca}`);

    rmSync(caBundleFile());
    expect(ensureCaBundle(() => null)).toBeNull();
  });

  test("real system roots include public CAs", () => {
    rmSync(caBundleFile(), { force: true });
    const bundle = ensureCaBundle();
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    expect(bundle).toBe(caBundleFile());
    const count = readFileSync(caBundleFile(), "utf-8").split("BEGIN CERTIFICATE").length - 1;
    expect(count).toBeGreaterThan(50);
  });
});

describe("formatEnv", () => {
  const env = { A: "it's $HOME `x` \\ \"q\"", B: "{{secret:b}}" };

  test("json is a flat object", () => {
    expect(JSON.parse(formatEnv(env, "json"))).toEqual(env);
  });

  for (const shell of ["bash", "zsh"] as const) {
    test(`${shell} quoting round-trips and records exported names`, () => {
      const bin = shell === "bash" ? ["bash", "--norc", "--noprofile", "-c"] : ["zsh", "-fc"];
      const script = `eval "$OUT"; printf '%s\\n' "$A" "$B" "$AGENTPASS_EXPORTED"; env | grep -c '^A='`;
      const r = spawnSync(bin[0]!, [...bin.slice(1), script], {
        encoding: "utf-8",
        env: { PATH: process.env.PATH, OUT: formatEnv(env, shell) },
      });
      expect(r.stdout).toBe(`${env.A}\n${env.B}\nA B\n1\n`);
    });
  }

  test("fish output escapes quotes and backslashes", () => {
    expect(formatEnv({ A: "it's \\" }, "fish")).toBe(
      "set -gx A 'it\\'s \\\\';\nset -g AGENTPASS_EXPORTED 'A';\n"
    );
  });
});

describe("hook", () => {
  function runHook(shell: "bash" | "zsh", body: string) {
    const log = join(root, `${shell}-calls.log`);
    rmSync(log, { force: true });
    const wrapper = join(root, "wrapper.sh");
    writeFileSync(wrapper, `echo run >> "$CALL_LOG"\nexec "${process.execPath}" "${CLI}" "$@"\n`);
    const hook = hookScript(shell, ["sh", wrapper]);
    const bin = shell === "bash" ? ["bash", "--norc", "--noprofile", "-c"] : ["zsh", "-fc"];
    // Simulate a prompt: non-interactive shells never run precmd / PROMPT_COMMAND themselves.
    const tick = shell === "bash" ? 'eval "$PROMPT_COMMAND"' : 'for f in $precmd_functions; do $f; done';
    const script = `eval "$HOOK"
show() { echo "$1:\${OPENAI_API_KEY-unset}:\${ANTHROPIC_API_KEY-unset}:\${HTTPS_PROXY-unset}"; }
ap() { "${process.execPath}" "${CLI}" "$@"; }
${body.replaceAll("TICK", tick)}`;
    const r = spawnSync(bin[0]!, [...bin.slice(1), script], {
      encoding: "utf-8",
      cwd: root,
      env: { PATH: process.env.PATH, HOME: user, AGENTPASS_HOME: home, HOOK: hook, CALL_LOG: log },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean).length : 0;
    return { out: r.stdout, err: r.stderr, calls };
  }

  for (const shell of ["bash", "zsh"] as const) {
    test(`${shell}: exports on entering a project and unsets on leaving`, () => {
      const p = "http://127.0.0.1:8888";
      const r = runHook(
        shell,
        `show start
cd "${proj}/sub"; TICK; show proj
TICK; TICK; show again
cd "${other}"; TICK; show other
cd "${root}"; TICK; show out
env | grep -c '^STRIPE_SECRET_KEY=' || true`
      );
      expect(r.err).toBe("");
      expect(r.out).toBe(
        [
          "start:unset:unset:unset",
          `proj:{{secret:openai-work}}:unset:${p}`,
          `again:{{secret:openai-work}}:unset:${p}`,
          `other:unset:{{secret:anthropic}}:${p}`,
          "out:unset:unset:unset",
          "0",
          "",
        ].join("\n")
      );
      expect(r.calls).toBe(2);
    });

    test(`${shell}: an edited manifest waits for allow, and a bad one warns once`, () => {
      const p = "http://127.0.0.1:8888";
      const bad = join(user, `bad-${shell}`);
      mkdirSync(bad, { recursive: true });
      writeFileSync(join(bad, ".agentpass.json"), "{oops");
      allowManifest(bad);
      const r = runHook(
        shell,
        `cd "${proj}"; TICK; show a
printf '%s' '{"env":{"ANTHROPIC_API_KEY":"anthropic-${shell}"}}' > "${join(root, "edit.json")}"
cp "${join(proj, ".agentpass.json")}" "${join(root, "orig.json")}"
cp "${join(root, "edit.json")}" "${join(proj, ".agentpass.json")}"; TICK; TICK; show b
ap allow >/dev/null; TICK; show c
cp "${join(root, "orig.json")}" "${join(proj, ".agentpass.json")}"
cd "${bad}"; TICK; TICK; TICK; show bad`
      );
      expect(r.out).toBe(
        [
          `a:{{secret:openai-work}}:unset:${p}`,
          `b:unset:unset:${p}`,
          `c:unset:{{secret:anthropic-${shell}}}:${p}`,
          "bad:unset:unset:unset",
          "",
        ].join("\n")
      );
      expect(r.err.match(/is not allowed yet/g)?.length).toBe(1);
      expect(r.err).toContain("Review it, then run: agentpass allow");
      expect(r.err.match(/invalid JSON/g)?.length).toBe(1);
      expect(r.calls).toBe(4);
    });

    test(`${shell}: a repo cannot run code through GIT_CONFIG_GLOBAL or BASH_ENV, allowed or not`, () => {
      const evil = join(user, `evil-${shell}`);
      mkdirSync(evil);
      git(evil, "init", "-q", "-b", "main");
      writeFileSync(
        join(evil, ".agentpass.json"),
        JSON.stringify({ env: { GIT_CONFIG_GLOBAL: "g", BASH_ENV: "b" }, shell })
      );
      writeFileSync(join(evil, "{{secret:g}}"), '[core]\n\tfsmonitor = "touch pwned-git; false"\n');
      writeFileSync(join(evil, "{{secret:b}}"), "touch pwned-bash\n");
      git(evil, "add", "-A");
      git(evil, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");

      const r = runHook(
        shell,
        `probe() { git status >/dev/null 2>&1; bash -c true; echo "$1:\${GIT_CONFIG_GLOBAL-unset}:\${BASH_ENV-unset}"; }
cd "${evil}"; TICK; probe untrusted
ap allow >/dev/null; TICK; probe allowed`
      );
      expect([existsSync(join(evil, "pwned-git")), existsSync(join(evil, "pwned-bash"))]).toEqual([false, false]);
      expect(r.out).toBe("untrusted:unset:unset\nallowed:unset:unset\n");
      expect(r.err).toContain("is not allowed yet");
      expect(r.err).toContain("skipping GIT_CONFIG_GLOBAL: reserved");
      expect(r.err).toContain("skipping BASH_ENV: reserved");
    });

    test(`${shell}: never applies a manifest above HOME or above the git toplevel`, () => {
      const planted = join(root, ".agentpass.json");
      const bytes = JSON.stringify({ env: { OPENAI_API_KEY: "planted" } });
      writeFileSync(planted, bytes);
      allow(planted, Buffer.from(bytes));
      const top = join(user, ".agentpass.json");
      writeFileSync(top, JSON.stringify({ env: { OPENAI_API_KEY: "home" } }));
      allowManifest(user);
      mkdirSync(join(user, "repo", ".git"), { recursive: true });
      mkdirSync(join(user, "plain"), { recursive: true });
      try {
        const r = runHook(
          shell,
          `cd "${root}"; TICK; show root
cd "${user}/plain"; TICK; show plain
cd "${user}/repo"; TICK; show repo`
        );
        expect(r.out).toBe(
          ["root:unset:unset:unset", "plain:{{secret:home}}:unset:http://127.0.0.1:8888", "repo:unset:unset:unset", ""].join(
            "\n"
          )
        );
      } finally {
        rmSync(planted);
        rmSync(top);
      }
    });
  }

  test("an untrusted manifest exports only global defaults and warns once for the directory", () => {
    const fresh = join(user, "fresh");
    mkdirSync(join(fresh, "sub"), { recursive: true });
    writeFileSync(join(fresh, ".agentpass.json"), JSON.stringify({ env: { OPENAI_API_KEY: "openai" } }));
    writeFileSync(globalConfigFile(), JSON.stringify({ env: { ANTHROPIC_API_KEY: "anthropic" } }));
    const r = runHook("zsh", `cd "${fresh}"; TICK; cd sub; TICK; TICK; show fresh`);
    expect(r.out).toBe("fresh:unset:{{secret:anthropic}}:http://127.0.0.1:8888\n");
    expect(r.err).toBe(
      `agentpass: ${join(fresh, ".agentpass.json")} is not allowed yet, so nothing from it is exported.` +
        " Review it, then run: agentpass allow\n"
    );
  });

  test("bash hook keeps an existing PROMPT_COMMAND and installs once", () => {
    const hook = hookScript("bash", ["true"]);
    const r = spawnSync(
      "bash",
      ["--norc", "--noprofile", "-c", `PROMPT_COMMAND='echo hi'; eval "$HOOK"; eval "$HOOK"; echo "$PROMPT_COMMAND"`],
      { encoding: "utf-8", cwd: root, env: { PATH: process.env.PATH, HOOK: hook } }
    );
    expect(r.stdout).toBe("_agentpass_hook;echo hi\n");
  });

  test("fish hook registers on PWD changes", () => {
    const hook = hookScript("fish", ["agentpass", "it's"]);
    expect(hook).toContain("--on-variable PWD");
    expect(hook).toContain("agentpass 'it\\'s' env --hook --shell fish");
  });
});
