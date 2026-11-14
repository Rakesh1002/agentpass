import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "child_process";
import http from "http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { version } from "../package.json";
import { certificateAuthority } from "./ca";
import { installService, removeService } from "./daemon";
import type { Runner } from "./keychain";
import { proxyReachable } from "./shellenv";
import { freePort, sandbox, selfProxyEnv, type Sandbox } from "./testing";

const CLI = resolve(import.meta.dir, "cli.ts");
const PW = "test-password";
const SPEC = { command: ["/opt/bun", "/src/cli.ts", "daemon"], env: { AGENTPASS_HOME: "/tmp/a&b" }, log: "/tmp/a&b/daemon.log" };

type Call = string[];

function fakeRunner(status: (call: Call) => number) {
  const calls: Call[] = [];
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: status([cmd, ...args]), stdout: "", stderr: "" };
  };
  return { run, calls };
}

describe("service manager", () => {
  let home: string;
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const uid = process.getuid!();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentpass-service-"));
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    process.env.HOME = saved.HOME;
    if (saved.XDG_CONFIG_HOME !== undefined) process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test("macOS writes a RunAtLoad KeepAlive LaunchAgent and bootstraps it into the gui domain", () => {
    const { run, calls } = fakeRunner((c) => (c[1] === "print" ? 113 : 0));
    expect(installService(SPEC, run, "darwin")).toBe("started");

    const file = join(home, "Library", "LaunchAgents", "sh.agentpass.proxy.plist");
    const plist = readFileSync(file, "utf-8");
    expect(plist).toContain("<key>Label</key><string>sh.agentpass.proxy</string>");
    expect(plist).toContain("<array><string>/opt/bun</string><string>/src/cli.ts</string><string>daemon</string></array>");
    expect(plist).toContain("<key>AGENTPASS_HOME</key><string>/tmp/a&amp;b</string>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>StandardOutPath</key><string>/tmp/a&amp;b/daemon.log</string>");
    expect(plist).toContain("<key>StandardErrorPath</key><string>/tmp/a&amp;b/daemon.log</string>");
    if (Bun.which("plutil")) expect(spawnSync("plutil", ["-lint", file]).status).toBe(0);
    expect(calls).toEqual([
      ["launchctl", "print", `gui/${uid}/sh.agentpass.proxy`],
      ["launchctl", "bootstrap", `gui/${uid}`, file],
    ]);
  });

  test("macOS up leaves an already loaded agent alone, and down boots it out and removes the plist", () => {
    const loaded = fakeRunner(() => 0);
    expect(installService(SPEC, loaded.run, "darwin")).toBe("already running");
    expect(loaded.calls).toEqual([["launchctl", "print", `gui/${uid}/sh.agentpass.proxy`]]);

    installService(SPEC, fakeRunner((c) => (c[1] === "print" ? 113 : 0)).run, "darwin");
    const file = join(home, "Library", "LaunchAgents", "sh.agentpass.proxy.plist");
    const down = fakeRunner(() => 0);
    expect(removeService(down.run, "darwin")).toBe(true);
    expect(down.calls).toEqual([["launchctl", "bootout", `gui/${uid}/sh.agentpass.proxy`]]);
    expect(existsSync(file)).toBe(false);
    expect(removeService(fakeRunner(() => 3).run, "darwin")).toBe(false);
  });

  test("a failing launchctl bootstrap is an error", () => {
    const { run } = fakeRunner((c) => (c[1] === "print" ? 113 : 5));
    expect(() => installService(SPEC, run, "darwin")).toThrow("launchctl bootstrap");
  });

  test("Linux writes a systemd user unit, enables it, and down disables and removes it", () => {
    const { run, calls } = fakeRunner((c) => (c[2] === "is-active" ? 3 : 0));
    const spec = { ...SPEC, command: ["/opt/my bun", "/src/100%/cli.ts", "daemon"] };
    expect(installService(spec, run, "linux")).toBe("started");

    const file = join(home, ".config", "systemd", "user", "sh.agentpass.proxy.service");
    const unit = readFileSync(file, "utf-8");
    expect(unit).toContain('ExecStart="/opt/my bun" "/src/100%%/cli.ts" "daemon"\n');
    expect(unit).toContain('Environment="AGENTPASS_HOME=/tmp/a&b"\n');
    expect(unit).toContain("Restart=always\n");
    expect(unit).toContain("StandardOutput=append:/tmp/a&b/daemon.log\n");
    expect(unit).toContain("WantedBy=default.target\n");
    expect(calls).toEqual([
      ["systemctl", "--user", "is-active", "--quiet", "sh.agentpass.proxy.service"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "sh.agentpass.proxy.service"],
    ]);

    const active = fakeRunner(() => 0);
    expect(installService(spec, active.run, "linux")).toBe("already running");
    expect(active.calls).toHaveLength(1);

    const down = fakeRunner(() => 0);
    expect(removeService(down.run, "linux")).toBe(true);
    expect(down.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", "sh.agentpass.proxy.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect(existsSync(file)).toBe(false);
  });

  test("other platforms are rejected", () => {
    expect(() => installService(SPEC, fakeRunner(() => 0).run, "win32")).toThrow("macOS");
  });
});

describe("daemon", () => {
  let box: Sandbox;
  let caDir: string;

  beforeAll(() => {
    caDir = mkdtempSync(join(tmpdir(), "agentpass-ca-"));
    process.env.AGENTPASS_HOME = caDir;
    certificateAuthority.ensureCa();
    delete process.env.AGENTPASS_HOME;
  });

  afterAll(() => {
    rmSync(caDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    box = sandbox();
    mkdirSync(box.agentpassHome);
    for (const f of ["agentpass-ca.crt", "agentpass-ca.key"]) copyFileSync(join(caDir, f), join(box.agentpassHome, f));
  });

  afterEach(() => {
    rmSync(box.root, { recursive: true, force: true });
  });

  const daemonJson = () => join(box.agentpassHome, "daemon.json");

  function startDaemon(extra: Record<string, string> = {}, port = 0) {
    const child = spawn(process.execPath, [CLI, "daemon", "--port", String(port)], { cwd: box.root, env: { ...box.env, ...extra } });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
    return { child, exited, output: () => output };
  }

  async function waitFor(check: () => boolean, what: string) {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  test("writes daemon.json once listening, serves health, refuses a second copy and cleans up on SIGTERM", async () => {
    expect(box.cli(["init"]).code).toBe(0);
    const daemon = startDaemon();
    try {
      await waitFor(() => existsSync(daemonJson()), "daemon.json");
      const info = JSON.parse(readFileSync(daemonJson(), "utf-8"));
      expect(info).toEqual({ pid: daemon.child.pid, port: expect.any(Number), startedAt: expect.any(String), version });
      expect(statSync(daemonJson()).mode & 0o777).toBe(0o600);
      expect(await proxyReachable(info.port)).toBe(true);

      const status = box.cli(["status"]);
      expect(status.out).toContain("Vault: keychain mode, unlockable");
      expect(status.out).toContain(`Daemon: running (pid ${info.pid}, port ${info.port}, since ${info.startedAt})`);
      expect(status.out).toContain(`Proxy port: ${info.port}`);
      expect(status.out).toContain(`CA certificate: ${join(box.agentpassHome, "agentpass-ca.crt")}`);

      const second = box.cli(["daemon", "--port", "0"]);
      expect(second.code).toBe(1);
      expect(second.err).toContain(`already running (pid ${info.pid}, port ${info.port})`);

      daemon.child.kill("SIGTERM");
      expect(await daemon.exited).toBe(0);
      expect(existsSync(daemonJson())).toBe(false);
      expect(box.cli(["status"]).out).toContain("Daemon: not running");
    } finally {
      daemon.child.kill("SIGKILL");
    }
  });

  test("ignores proxy env pointing at itself, so a forwarded request reaches upstream exactly once", async () => {
    let hits = 0;
    const upstream = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const port = await freePort();
    expect(box.cli(["init"]).code).toBe(0);
    const daemon = startDaemon(selfProxyEnv(`http://127.0.0.1:${port}`), port);
    try {
      await waitFor(() => existsSync(daemonJson()), "daemon.json");
      const status = await new Promise<string>((done) => {
        const target = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/ping`;
        const req = http.request({ host: "127.0.0.1", port, path: target, timeout: 4000 }, (res) => {
          res.resume();
          done(String(res.statusCode));
        });
        req.on("timeout", () => {
          req.destroy();
          done("timeout");
        });
        req.on("error", (err) => done(err.message));
        req.end();
      });
      expect(status).toBe("200");
      await Bun.sleep(200);
      expect(hits).toBe(1);

      const servingPid = JSON.parse(readFileSync(daemonJson(), "utf-8")).pid;
      daemon.child.kill("SIGTERM");
      expect(await daemon.exited).toBe(0);
      expect(existsSync(daemonJson())).toBe(false);
      expect(() => process.kill(servingPid, 0)).toThrow();
    } finally {
      daemon.child.kill("SIGKILL");
      upstream.close();
    }
  });

  test("records the actual port in daemon.json when the requested one is taken", async () => {
    const taken = http.createServer();
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
    const port = (taken.address() as { port: number }).port;
    expect(box.cli(["init"]).code).toBe(0);
    const daemon = startDaemon({}, port);
    try {
      await waitFor(() => existsSync(daemonJson()), "daemon.json");
      const actual = JSON.parse(readFileSync(daemonJson(), "utf-8")).port;
      expect(actual).not.toBe(port);
      expect(await proxyReachable(actual)).toBe(true);
    } finally {
      daemon.child.kill("SIGKILL");
      taken.close();
    }
  });

  test("a stale daemon.json from a dead process is reported and replaced", async () => {
    expect(box.cli(["init"]).code).toBe(0);
    const dead = spawnSync("true").pid;
    writeFileSync(daemonJson(), JSON.stringify({ pid: dead, port: 1, startedAt: "then", version: "0" }));
    expect(box.cli(["status"]).out).toContain(`Daemon: not running (stale daemon.json for pid ${dead})`);

    const daemon = startDaemon();
    try {
      await waitFor(() => existsSync(daemonJson()) && JSON.parse(readFileSync(daemonJson(), "utf-8")).pid === daemon.child.pid, "fresh daemon.json");
      daemon.child.kill("SIGINT");
      expect(await daemon.exited).toBe(0);
      expect(existsSync(daemonJson())).toBe(false);
    } finally {
      daemon.child.kill("SIGKILL");
    }
  });

  test("fails clearly for a passphrase vault with no TTY, and starts with AGENTPASS_PASSWORD", async () => {
    expect(box.cli(["init"], { AGENTPASS_PASSWORD: PW }).code).toBe(0);
    const locked = box.cli(["daemon", "--port", "0"]);
    expect(locked.code).toBe(1);
    expect(locked.err).toContain("passphrase mode");
    expect(locked.err).toContain("AGENTPASS_PASSWORD");
    expect(existsSync(daemonJson())).toBe(false);

    const daemon = startDaemon({ AGENTPASS_PASSWORD: PW });
    try {
      await waitFor(() => existsSync(daemonJson()), "daemon.json");
      daemon.child.kill("SIGTERM");
      expect(await daemon.exited).toBe(0);
    } finally {
      daemon.child.kill("SIGKILL");
    }
  });

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "up refuses a passphrase vault, installs a keychain vault once, and down removes it",
    () => {
      const serviceFile =
        process.platform === "darwin"
          ? join(box.home, "Library", "LaunchAgents", "sh.agentpass.proxy.plist")
          : join(box.home, ".config", "systemd", "user", "sh.agentpass.proxy.service");

      expect(box.cli(["init"], { AGENTPASS_PASSWORD: PW }).code).toBe(0);
      const refused = box.cli(["up"], { AGENTPASS_PASSWORD: PW });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("agentpass unlock-mode keychain");
      expect(existsSync(serviceFile)).toBe(false);

      expect(box.cli(["unlock-mode", "keychain"], { AGENTPASS_PASSWORD: PW }).code).toBe(0);
      const up = box.cli(["up"]);
      expect(up.code).toBe(0);
      expect(up.out).toContain("Started the AgentPass background proxy");
      const unit = readFileSync(serviceFile, "utf-8");
      expect(unit).toContain(CLI);
      expect(unit).toContain("daemon");
      expect(unit).toContain(box.agentpassHome);
      expect(unit).toContain(join(box.agentpassHome, "daemon.log"));
      expect(unit).not.toContain("AGENTPASS_PASSWORD");
      expect(unit).not.toContain(readFileSync(join(box.fakeDir, "keychain"), "utf-8").trim());

      expect(box.cli(["up"]).out).toContain("already running");
      expect(box.cli(["down"]).out).toContain("Stopped");
      expect(existsSync(serviceFile)).toBe(false);
      expect(box.cli(["down"]).out).toContain("not installed");
    }
  );
});
