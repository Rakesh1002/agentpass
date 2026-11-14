import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const CLI = resolve(import.meta.dir, "cli.ts");
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentpass-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(...args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { ...process.env, HOME: home, AGENTPASS_HOME: home, AGENTPASS_PASSWORD: "test-password" },
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("cli pins", () => {
  test("add stores pins from --host, --path and --method, and list shows them", () => {
    expect(run("init").code).toBe(0);
    const added = run(
      "add", "stripe", "-v", "sk_test_cli_secret",
      "--host", "api.stripe.com,files.stripe.com", "--path", "/v1", "--method", "get,post"
    );
    expect(added.code).toBe(0);
    expect(run("add", "openai", "--value", "sk-openai").code).toBe(0);
    const loose = run("add", "stripe-live", "-t", "api_key", "-v", "sk_live_x");
    expect(loose.out).toContain("--host api.stripe.com");

    const listed = run("list");
    expect(listed.out).toContain("stripe (api_key) — pins: api.stripe.com/v1 [GET,POST], files.stripe.com/v1 [GET,POST]");
    expect(listed.out).toContain("openai (api_key) — pins: api.openai.com (implicit)");
    expect(listed.out).toContain("stripe-live (api_key) — pins: none (deny by default)");
    expect(added.out + listed.out + loose.out).not.toContain("sk_test_cli_secret");
  });

  test("pins shows, replaces and clears a secret's pins", () => {
    run("init");
    run("add", "stripe", "-v", "sk_test", "--host", "api.stripe.com");
    expect(run("pins", "stripe").out).toContain("stripe: api.stripe.com");

    expect(run("pins", "stripe", "--set", "api.stripe.com", "--method", "POST").code).toBe(0);
    expect(run("pins", "stripe").out).toContain("stripe: api.stripe.com [POST]");

    expect(run("pins", "stripe", "--clear").code).toBe(0);
    expect(run("pins", "stripe").out).toContain("stripe: none (deny by default)");
  });

  test("rejects invalid pins and unknown secrets", () => {
    run("init");
    run("add", "stripe", "-v", "sk_test", "--host", "api.stripe.com");

    const badHost = run("pins", "stripe", "--set", "https://api.stripe.com");
    expect(badHost.code).toBe(1);
    expect(badHost.err).toContain("Invalid pin host");
    expect(run("pins", "stripe").out).toContain("stripe: api.stripe.com");

    expect(run("pins", "missing").code).toBe(1);
    expect(run("add", "svc", "-v", "sk", "--method", "GET").code).toBe(1);
    expect(run("list").out).not.toContain("svc");
  });
});
