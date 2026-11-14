import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { keychain, macKeychain, randomSecret, type Runner } from "./keychain";

type Call = { cmd: string; args: string[]; input?: string };

function fakeRunner(respond: (call: Call) => { status: number | null; stdout?: string }) {
  const calls: Call[] = [];
  const run: Runner = (cmd, args, input) => {
    const call = { cmd, args, input };
    calls.push(call);
    const r = respond(call);
    return { status: r.status, stdout: r.stdout ?? "", stderr: "" };
  };
  return { run, calls };
}

// Mimics `security`: `-i` reads the add command from stdin, find prints the item or exits 44.
function fakeSecurity() {
  const items = new Map<string, string>();
  return fakeRunner(({ args, input }) => {
    if (args[0] === "-i") {
      const m = /^add-generic-password -U -s sh\.agentpass -a "([^"]*)" -w "([^"]*)"\n$/.exec(input ?? "");
      if (m) items.set(m[1]!, m[2]!);
      return { status: 0 };
    }
    if (args[0] === "find-generic-password") {
      const value = items.get(args[args.indexOf("-a") + 1]!);
      return value === undefined ? { status: 44 } : { status: 0, stdout: `${value}\n` };
    }
    return { status: 1 };
  });
}

describe("keychain", () => {
  test("macOS writes through `security -i` stdin so the secret never reaches argv", () => {
    const { run, calls } = fakeSecurity();
    const kc = keychain(run, "darwin")!;
    const secret = randomSecret();

    expect(kc.get("/home/a b/.agentpass/vault.db")).toBeNull();
    kc.set("/home/a b/.agentpass/vault.db", secret);
    expect(kc.get("/home/a b/.agentpass/vault.db")).toBe(secret);

    expect(calls.every((c) => c.cmd === "security")).toBe(true);
    expect(calls.some((c) => c.args.join(" ").includes(secret))).toBe(false);
    expect(calls.find((c) => c.args[0] === "-i")?.input).toBe(
      `add-generic-password -U -s sh.agentpass -a "/home/a b/.agentpass/vault.db" -w "${secret}"\n`
    );
    expect(calls.find((c) => c.args[0] === "find-generic-password")?.args).toEqual([
      "find-generic-password", "-s", "sh.agentpass", "-a", "/home/a b/.agentpass/vault.db", "-w",
    ]);
  });

  test("set throws when the item does not read back, since `security -i` exits 0 on failure", () => {
    const { run } = fakeRunner(({ args }) => ({ status: args[0] === "-i" ? 0 : 44 }));
    const secret = randomSecret();
    expect(() => keychain(run, "darwin")!.set("/v/vault.db", secret)).toThrow("Could not store the vault key");
    try {
      keychain(run, "darwin")!.set("/v/vault.db", secret);
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  test("rejects vault paths that could break out of the `security -i` command line", () => {
    const { run, calls } = fakeSecurity();
    const kc = keychain(run, "darwin")!;
    for (const account of ['/v/"x/vault.db', "/v/x\\y/vault.db", "/v/x\ndelete-keychain login.keychain/vault.db"]) {
      expect(() => kc.set(account, randomSecret())).toThrow("vault path");
    }
    expect(calls).toHaveLength(0);
  });

  test("Linux stores and looks up with secret-tool, the secret on stdin", () => {
    let stored: string | undefined;
    const { run, calls } = fakeRunner(({ args, input }) => {
      if (args[0] === "--version") return { status: 0 };
      if (args[0] === "store") {
        stored = input;
        return { status: 0 };
      }
      if (args[0] === "lookup") return stored === undefined ? { status: 1 } : { status: 0, stdout: stored };
      return { status: 1 };
    });
    const kc = keychain(run, "linux")!;
    const secret = randomSecret();

    expect(kc.get("/v/vault.db")).toBeNull();
    kc.set("/v/vault.db", secret);
    expect(kc.get("/v/vault.db")).toBe(secret);
    expect(calls.every((c) => c.cmd === "secret-tool")).toBe(true);
    expect(calls.some((c) => c.args.join(" ").includes(secret))).toBe(false);
    expect(calls.find((c) => c.args[0] === "store")?.args).toEqual([
      "store", "--label", "AgentPass vault", "service", "sh.agentpass", "account", "/v/vault.db",
    ]);
    expect(calls.find((c) => c.args[0] === "lookup")?.args).toEqual([
      "lookup", "service", "sh.agentpass", "account", "/v/vault.db",
    ]);
  });

  test("has no backend without secret-tool or on other platforms", () => {
    expect(keychain(fakeRunner(() => ({ status: null })).run, "linux")).toBeNull();
    expect(keychain(fakeRunner(() => ({ status: 0 })).run, "win32")).toBeNull();
  });

  test("random secrets are 32 bytes of base64", () => {
    const secret = randomSecret();
    expect(Buffer.from(secret, "base64")).toHaveLength(32);
    expect(secret).not.toBe(randomSecret());
  });
});

const hasSecurity = process.platform === "darwin" && Bun.which("security") !== null;

describe.skipIf(!hasSecurity)("macOS keychain against a temporary keychain file", () => {
  let dir: string;
  let file: string;
  // HOME points at the temp dir so `security` keeps its search-list changes away from the real one.
  const run: Runner = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: "utf-8", env: { PATH: process.env.PATH, HOME: dir } });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "agentpass-kc-")));
    file = join(dir, "test.keychain-db");
    expect(run("security", ["create-keychain", "-p", "agentpass-test", file]).status).toBe(0);
    // `security` falls back to the login keychain when the named keychain is missing, so never write without it.
    if (!existsSync(file)) throw new Error("temporary keychain was not created");
  });

  afterAll(() => {
    run("security", ["delete-keychain", file]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips, overwrites and misses through the real security tool", () => {
    expect(existsSync(file)).toBe(true);
    const kc = macKeychain(run, file);
    const account = join(dir, "it's a vault", "vault.db");
    const first = randomSecret();
    const second = randomSecret();

    expect(kc.get(account)).toBeNull();
    kc.set(account, first);
    expect(kc.get(account)).toBe(first);
    kc.set(account, second);
    expect(kc.get(account)).toBe(second);
    expect(kc.get(join(dir, "other", "vault.db"))).toBeNull();
  });
});
