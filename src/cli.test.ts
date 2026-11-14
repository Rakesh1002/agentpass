import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "child_process";
import http from "http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { certificateAuthority } from "./ca";
import { Vault } from "./vault";

const CLI = resolve(import.meta.dir, "cli.ts");
let root: string;
let home: string;
let proj: string;

function cli(args: string[], extra: Record<string, string> = {}, cwd = proj) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    env: { PATH: process.env.PATH, HOME: root, AGENTPASS_HOME: home, KEEP: "kept", ...extra },
  });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

function cliAsync(args: string[], extra: Record<string, string> = {}): Promise<{ out: string; code: number | null }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: proj,
      env: { PATH: process.env.PATH, HOME: root, AGENTPASS_HOME: home, KEEP: "kept", ...extra },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", (code) => done({ out, code }));
  });
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agentpass-cli-")));
  home = join(root, "home");
  process.env.AGENTPASS_HOME = home;
  certificateAuthority.ensureCa();
  const v = new Vault();
  await v.init("test-password");
  await v.add("openai", "sk-real-value");
  v.close();
  delete process.env.AGENTPASS_HOME;

  proj = join(root, "proj");
  mkdirSync(proj);
  spawnSync("git", ["init", "-q"], { cwd: proj });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cli", () => {
  test("link, unlink and project never print values", () => {
    expect(cli(["link", "OPENAI_API_KEY", "openai"]).code).toBe(0);
    expect(cli(["link", "STRIPE_SECRET_KEY", "stripe-test"]).code).toBe(0);
    expect(cli(["link", "bad-var", "x"]).code).toBe(1);

    const locked = cli(["project"]);
    expect(locked.out).toContain(join(proj, ".agentpass.json"));
    expect(locked.out).toContain("OPENAI_API_KEY -> openai (project)");
    expect(locked.out).toContain("vault locked");

    const open = cli(["project"], { AGENTPASS_PASSWORD: "test-password" });
    expect(open.out).toContain("STRIPE_SECRET_KEY -> stripe-test (project) MISSING from vault");
    expect(open.out).not.toContain("OPENAI_API_KEY -> openai (project) MISSING");
    expect(open.out + open.err).not.toContain("sk-real-value");

    expect(cli(["unlink", "STRIPE_SECRET_KEY"]).code).toBe(0);
    expect(JSON.parse(readFileSync(join(proj, ".agentpass.json"), "utf-8"))).toEqual({
      env: { OPENAI_API_KEY: "openai" },
    });
  });

  test("env prints json and shell formats, and fails cleanly on a bad manifest", () => {
    const json = JSON.parse(cli(["env", "--shell", "json"]).out);
    expect(json.OPENAI_API_KEY).toBe("{{secret:openai}}");
    expect(json.HTTPS_PROXY).toBe("http://127.0.0.1:8888");
    expect(cli(["env", "--shell", "bash"]).out).toContain("export OPENAI_API_KEY='{{secret:openai}}';");

    const bad = join(root, "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, ".agentpass.json"), "{");
    const r = cli(["env", "--dir", bad]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("invalid JSON");
  });

  test("run uses a reachable proxy without the vault and passes the exit code", async () => {
    const server = http.createServer((_req, res) => res.writeHead(200).end("{}"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ port }));
    try {
      const r = await cliAsync(["run", "--", "sh", "-c", 'echo "$OPENAI_API_KEY $HTTPS_PROXY $KEEP"; exit 7']);
      expect(r.out).toBe(`{{secret:openai}} http://127.0.0.1:${port} kept\n`);
      expect(r.code).toBe(7);
    } finally {
      server.close();
      rmSync(join(home, "daemon.json"));
    }
  });

  test("run starts the proxy in-process when none is reachable", async () => {
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ port }));
    try {
      const r = await cliAsync(["run", "--", "sh", "-c", 'echo "$HTTPS_PROXY"'], { AGENTPASS_PASSWORD: "test-password" });
      expect(r.out).toContain(`http://127.0.0.1:${port}\n`);
      expect(r.code).toBe(0);
    } finally {
      rmSync(join(home, "daemon.json"));
    }
  });
});
