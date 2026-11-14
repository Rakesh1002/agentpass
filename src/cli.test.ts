import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "child_process";
import http from "http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { appendAudit } from "./audit";
import { certificateAuthority } from "./ca";
import { freePort, selfProxyEnv } from "./testing";
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

// Child-side check: print the proxy it was given, that proxy's health, and an upstream request through it.
const PROBE = `
const http = require("http");
const proxy = new URL(process.env.HTTPS_PROXY);
const get = (path) => new Promise((done) => {
  const req = http.request({ host: proxy.hostname, port: proxy.port, path, timeout: 4000 }, (res) => { res.resume(); done(String(res.statusCode)); });
  req.on("timeout", () => { req.destroy(); done("timeout"); });
  req.on("error", () => done("error"));
  req.end();
});
(async () => {
  const parts = [process.env.HTTPS_PROXY, await get("/_/health")];
  if (process.env.UPSTREAM) parts.push(await get(process.env.UPSTREAM));
  console.log(parts.join(" "));
})();
`;

const probeLine = (out: string) => out.split("\n").find((line) => line.startsWith("http://")) ?? out;

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
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: proj });
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
    const down = cli(["env", "--shell", "json"]);
    expect(JSON.parse(down.out)).toEqual({ OPENAI_API_KEY: "{{secret:openai}}" });
    expect(down.err).toContain("Start it with: agentpass up");
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: process.pid, port: 8888 }));
    try {
      const json = JSON.parse(cli(["env", "--shell", "json"]).out);
      expect(json.OPENAI_API_KEY).toBe("{{secret:openai}}");
      expect(json.HTTPS_PROXY).toBe("http://proj%40main@127.0.0.1:8888");
    } finally {
      rmSync(join(home, "daemon.json"));
    }
    expect(cli(["env", "--shell", "bash"]).out).toContain("export OPENAI_API_KEY='{{secret:openai}}';");

    const bad = join(root, "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, ".agentpass.json"), '{"env": {"OPENAI_API_KEY": sk_live_PLANTED}}');
    const untrusted = cli(["env", "--dir", bad]);
    expect(untrusted.code).toBe(2);
    expect(untrusted.out).toBe("");
    expect(untrusted.err).toContain("Review it, then run: agentpass allow");

    expect(cli(["allow", bad]).out).toBe(`Allowed ${join(bad, ".agentpass.json")}\n`);
    const r = cli(["env", "--dir", bad]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("invalid JSON");
    expect(r.out + r.err).not.toContain("sk_live_PLANTED");
  });

  test("deny revokes a manifest and run refuses it with exit 2 before asking for the vault", async () => {
    expect(cli(["deny"]).out).toBe(`Denied ${join(proj, ".agentpass.json")}\n`);
    expect(cli(["env"]).code).toBe(2);
    const r = await cliAsync(["run", "--", "sh", "-c", "echo ran"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(cli(["allow"]).code).toBe(0);
    expect(cli(["env"]).code).toBe(0);
  });

  test("audit shows the session tag after the wildcard marker", () => {
    process.env.AGENTPASS_HOME = home;
    try {
      appendAudit({ method: "GET", destination: "tagged.example:443", secretNames: ["svc"], statusCode: 200, durationMs: 3, wildcard: ["svc"], sessionTag: "agent-7" });
      appendAudit({ method: "GET", destination: "untagged.example:443", secretNames: [], statusCode: 200, durationMs: 1 });
    } finally {
      delete process.env.AGENTPASS_HOME;
    }
    const lines = cli(["audit"]).out.split("\n");
    expect(lines.find((line) => line.includes(" tagged.example"))).toEndWith(" wildcard=svc session=agent-7");
    expect(lines.find((line) => line.includes(" untagged.example"))).not.toContain("session=");
  });

  test("help documents every pin host form", () => {
    const help = cli(["help"]).out;
    for (const form of ["host:port", "[::1]:port", "*:*", "*:N", "default port"]) expect(help).toContain(form);
  });

  test("run uses a reachable proxy without the vault and passes the exit code", async () => {
    const server = http.createServer((_req, res) => res.writeHead(200).end("{}"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ port }));
    try {
      const r = await cliAsync(["run", "--", "sh", "-c", 'echo "$OPENAI_API_KEY $HTTPS_PROXY $KEEP"; exit 7']);
      expect(r.out).toBe(`{{secret:openai}} http://proj%40main%2Bsh@127.0.0.1:${port} kept\n`);
      expect(r.code).toBe(7);
    } finally {
      server.close();
      rmSync(join(home, "daemon.json"));
    }
  });

  test("run exits 128+signum when the child dies by a signal", async () => {
    const server = http.createServer((_req, res) => res.writeHead(200).end("{}"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ port: (server.address() as { port: number }).port }));
    try {
      expect((await cliAsync(["run", "--", "sh", "-c", "kill -TERM $$"])).code).toBe(143);
      expect((await cliAsync(["run", "--", "sh", "-c", "kill -KILL $$"])).code).toBe(137);
    } finally {
      server.close();
      rmSync(join(home, "daemon.json"));
    }
  });

  test("run's in-process proxy hands the child its actual port when the configured one is taken", async () => {
    const taken = http.createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
    const port = (taken.address() as { port: number }).port;
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ port }));
    try {
      const r = await cliAsync(["run", "--", process.execPath, "-e", PROBE], { AGENTPASS_PASSWORD: "test-password" });
      const [proxyUrl, health] = probeLine(r.out).split(" ");
      expect(proxyUrl).not.toBe(`http://127.0.0.1:${port}`);
      expect(health).toBe("200");
      expect(r.code).toBe(0);
    } finally {
      taken.close();
      rmSync(join(home, "daemon.json"));
    }
  });

  test("run's in-process proxy ignores proxy env pointing at itself, and the child still gets it", async () => {
    let hits = 0;
    const upstream = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const port = await freePort();
    const self = `http://127.0.0.1:${port}`;
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ port }));
    try {
      const r = await cliAsync(["run", "--", process.execPath, "-e", PROBE], {
        AGENTPASS_PASSWORD: "test-password",
        UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/ping`,
        ...selfProxyEnv(self),
      });
      const tagged = `http://proj%40main%2B${basename(process.execPath)}@127.0.0.1:${port}`;
      expect(probeLine(r.out)).toBe(`${tagged} 200 200`);
      expect(hits).toBe(1);
    } finally {
      upstream.close();
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
      expect(r.out).toContain(`http://proj%40main%2Bsh@127.0.0.1:${port}\n`);
      expect(r.code).toBe(0);
    } finally {
      rmSync(join(home, "daemon.json"));
    }
  });
});
