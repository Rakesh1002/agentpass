import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { Vault } from "./vault";

const CLI = resolve(import.meta.dir, "cli.ts");
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentpass-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(...args: string[]): { code: number; out: string; err: string } {
  return pipe("", ...args);
}

// stdin is a pipe, never a TTY, so `add` reads the value from it
function pipe(input: string, ...args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { ...process.env, HOME: home, AGENTPASS_HOME: home, AGENTPASS_PASSWORD: "test-password" },
    stdin: new TextEncoder().encode(input),
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("cli pins", () => {
  test("add stores pins from --host, --path and --method, and list shows them", () => {
    expect(run("init").code).toBe(0);
    const added = pipe(
      "sk_test_cli_secret",
      "add", "stripe", "--host", "api.stripe.com,files.stripe.com", "--path", "/v1", "--method", "get,post"
    );
    expect(added.code).toBe(0);
    expect(pipe("sk-openai", "add", "openai").code).toBe(0);
    const loose = pipe("sk_live_x", "add", "stripe-live", "-t", "api_key");
    expect(loose.out).toContain("--host api.stripe.com");

    const listed = run("list");
    expect(listed.out).toContain("stripe (api_key) — pins: api.stripe.com/v1 [GET,POST], files.stripe.com/v1 [GET,POST]");
    expect(listed.out).toContain("openai (api_key) — pins: api.openai.com (implicit)");
    expect(listed.out).toContain("stripe-live (api_key) — pins: none (deny by default)");
    expect(added.out + listed.out + loose.out).not.toContain("sk_test_cli_secret");
  });

  test("pins shows, replaces and clears a secret's pins", () => {
    run("init");
    pipe("sk_test", "add", "stripe", "--host", "api.stripe.com");
    expect(run("pins", "stripe").out).toContain("stripe: api.stripe.com");

    expect(run("pins", "stripe", "--set", "api.stripe.com", "--method", "POST").code).toBe(0);
    expect(run("pins", "stripe").out).toContain("stripe: api.stripe.com [POST]");

    expect(run("pins", "stripe", "--clear").code).toBe(0);
    expect(run("pins", "stripe").out).toContain("stripe: none (deny by default)");
  });

  test("rejects invalid pins and unknown secrets", () => {
    run("init");
    pipe("sk_test", "add", "stripe", "--host", "api.stripe.com");

    const badHost = run("pins", "stripe", "--set", "https://api.stripe.com");
    expect(badHost.code).toBe(1);
    expect(badHost.err).toContain("Invalid pin host");
    expect(run("pins", "stripe").out).toContain("stripe: api.stripe.com");

    expect(run("pins", "missing").code).toBe(1);
    expect(pipe("sk", "add", "svc", "--method", "GET").code).toBe(1);
    expect(run("list").out).not.toContain("svc");
  });
});

describe("cli add", () => {
  test("reads the value from stdin, strips exactly one trailing newline and rejects an empty value", async () => {
    run("init");
    expect(pipe("sk-piped-value\n\n", "add", "svc", "--host", "api.example.com").code).toBe(0);
    expect(pipe("sk-piped-crlf\r\n", "add", "crlf", "--host", "api.example.com").code).toBe(0);
    expect(pipe("sk-piped-bare", "add", "bare", "--host", "api.example.com").code).toBe(0);
    for (const empty of ["", "\n"]) {
      const r = pipe(empty, "add", "empty", "--host", "api.example.com");
      expect(r.code).toBe(1);
      expect(r.err).toContain("empty");
    }

    process.env.AGENTPASS_HOME = home;
    try {
      const v = new Vault();
      await v.init("test-password");
      expect(await v.get("svc")).toBe("sk-piped-value\n");
      expect(await v.get("crlf")).toBe("sk-piped-crlf");
      expect(await v.get("bare")).toBe("sk-piped-bare");
      expect(await v.has("empty")).toBe(false);
      v.close();
    } finally {
      delete process.env.AGENTPASS_HOME;
    }
  });

  test("refuses a value on the command line and never echoes it", () => {
    run("init");
    for (const args of [["-v", "sk-argv-leak"], ["--value", "sk-argv-leak"], ["--value=sk-argv-leak"], ["-vsk-argv-leak"], ["sk-argv-leak"]]) {
      const r = pipe("sk-stdin-value", "add", "svc", ...args);
      expect(r.code).toBe(1);
      expect(r.err).toContain("Usage: agentpass add");
      expect(r.out + r.err).not.toContain("argv-leak");
    }
    expect(run("list").out).not.toContain("svc");
  });
});
