import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { sandbox, type Sandbox } from "./testing";

const CLI = resolve(import.meta.dir, "cli.ts");
const PLANTED = "sk-planted-Q7xZ9mK2pL4vN8rT";
// 13 chars: long enough to be shown partially, short enough that a loose mask gives most of it away
const SHORT = "pw-Short-1234";
const CLAUDE_KEY = "sk-ant-api03-W3yB6cD9xQ2mZ7kL8";

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
});

afterEach(() => {
  rmSync(box.root, { recursive: true, force: true });
});

// Any 6-character run of the value counts as a leak.
function leak(text: string, value: string): string | null {
  for (let i = 0; i + 6 <= value.length; i++) {
    if (text.includes(value.slice(i, i + 6))) return value.slice(i, i + 6);
  }
  return null;
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

test("no command prints, logs or writes a stored value or the vault key", async () => {
  writeFileSync(join(box.home, ".claude.json"), JSON.stringify({ apiKey: CLAUDE_KEY }));
  const outputs: string[] = [];
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = box.cli(args, extra);
    outputs.push(`$ agentpass ${args[0]}\n${r.out}${r.err}`);
    return r;
  };
  const keychainSecret = () => readFileSync(join(box.fakeDir, "keychain"), "utf-8").trim();

  expect(run(["init"]).code).toBe(0);
  const firstKey = keychainSecret();
  expect(run(["add", "openai", "-v", PLANTED]).code).toBe(0);
  expect(run(["add", "short", "-v", SHORT, "--host", "api.example.com"]).code).toBe(0);
  expect(run(["import-claude"]).code).toBe(0);
  for (const name of ["openai", "short", "anthropic"]) expect(run(["get", name]).out).toContain(`${name}: `);
  run(["get", "missing"]);
  run(["list"]);
  run(["pins", "short"]);
  run(["pins", "short", "--set", "api.example.com", "--method", "POST"]);
  run(["link", "OPENAI_API_KEY", "openai"]);
  run(["project"]);
  run(["env", "--shell", "json"]);
  run(["env"]);
  run(["status"]);
  run(["audit"]);
  run(["ca", "path"]);
  run(["routing", "show"]);
  run(["up"]);
  run(["up"]);
  run(["down"]);

  expect(run(["unlock-mode", "passphrase"], { AGENTPASS_PASSWORD: "sweep-passphrase" }).code).toBe(0);
  run(["get", "openai"], { AGENTPASS_PASSWORD: "wrong-password" });
  run(["list"]);
  run(["status"]);
  run(["daemon", "--port", "0"]);
  run(["up"]);
  run(["get", "openai"], { AGENTPASS_PASSWORD: "sweep-passphrase" });
  expect(run(["unlock-mode", "keychain"], { AGENTPASS_PASSWORD: "sweep-passphrase" }).code).toBe(0);
  const secondKey = keychainSecret();

  const daemon = spawn(process.execPath, [CLI, "daemon", "--port", "0"], { cwd: box.root, env: box.env });
  let daemonOut = "";
  daemon.stdout.on("data", (c) => (daemonOut += c));
  daemon.stderr.on("data", (c) => (daemonOut += c));
  const exited = new Promise((done) => daemon.on("exit", done));
  try {
    for (let i = 0; i < 200 && !existsSync(join(box.agentpassHome, "daemon.json")); i++) await Bun.sleep(50);
    run(["status"]);
    run(["daemon", "--port", "0"]);
    run(["unlock-mode", "keychain"]);
  } finally {
    daemon.kill("SIGTERM");
    await exited;
  }
  outputs.push(`$ agentpass daemon\n${daemonOut}`);

  run(["delete", "short"]);
  run(["unlink", "OPENAI_API_KEY"]);
  run(["help"]);
  run(["bogus"]);

  const all = outputs.join("\n");
  const serviceDirs = [join(box.home, "Library", "LaunchAgents"), join(box.home, ".config", "systemd")];
  const written = [box.agentpassHome, ...serviceDirs].flatMap(files)
    .map((f) => readFileSync(f, "latin1"))
    .join("\n");
  for (const value of [PLANTED, SHORT, CLAUDE_KEY, firstKey, secondKey]) {
    expect(leak(all, value)).toBeNull();
    expect(leak(written, value)).toBeNull();
  }
  for (const key of [firstKey, secondKey]) expect(readFileSync(join(box.fakeDir, "argv.log"), "utf-8")).not.toContain(key);
}, 120000);
