import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const INSTALL_SH = resolve(import.meta.dir, "..", "apps", "web", "public", "install.sh");
const ASSET = "agentpass-linux-x64";

// Stands in for uname so every run sees the platform the test picks, whatever the host is.
const FAKE_UNAME = `#!/bin/sh
case "$1" in
  -s) echo "$FAKE_OS" ;;
  -m) echo "$FAKE_ARCH" ;;
esac
`;

const fakeBinary = (tag: string) => `#!/bin/sh\necho ${tag.replace(/^v/, "")}\n`;
const sha256 = (body: string) => createHash("sha256").update(body).digest("hex");

let root: string;
let fakeBin: string;
let server: ReturnType<typeof Bun.serve>;
let releases: string[];
let corrupt: boolean;
let requests: string[];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agentpass-install-")));
  fakeBin = join(root, "fakebin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "uname"), FAKE_UNAME);
  chmodSync(join(fakeBin, "uname"), 0o755);

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname + url.search);
      if (url.pathname === "/api/releases") {
        const page = Number(url.searchParams.get("per_page") ?? 30);
        return Response.json(releases.slice(0, page).map((tag) => ({ tag_name: tag, prerelease: tag.includes("-") })));
      }
      const [, dl, tag, file] = url.pathname.split("/");
      if (dl !== "dl" || !tag || !releases.includes(tag)) return new Response("Not Found", { status: 404 });
      const binary = fakeBinary(tag);
      if (file === ASSET) return new Response(binary);
      if (file === "SHA256SUMS") {
        const sum = corrupt ? sha256("tampered") : sha256(binary);
        return new Response(`${sha256("other")}  agentpass-darwin-arm64\n${sum}  ${ASSET}\n`);
      }
      return new Response("Not Found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

let installDir: string;
let scratch: string;

beforeEach(() => {
  releases = ["v0.2.0-beta.1", "v0.1.0"];
  corrupt = false;
  requests = [];
  const run = mkdtempSync(join(root, "run-"));
  installDir = join(run, "bin");
  scratch = join(run, "tmp");
  mkdirSync(scratch);
});

async function install(extra: Record<string, string> = {}) {
  const base = `http://127.0.0.1:${server.port}`;
  const proc = Bun.spawn(["sh", INSTALL_SH], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: root,
      TMPDIR: scratch,
      FAKE_OS: "Linux",
      FAKE_ARCH: "x86_64",
      AGENTPASS_API_URL: `${base}/api`,
      AGENTPASS_DOWNLOAD_URL: `${base}/dl`,
      AGENTPASS_INSTALL_DIR: installDir,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(readdirSync(scratch)).toEqual([]);
  return { out, err, code };
}

const installed = () => join(installDir, "agentpass");

describe("install.sh", () => {
  test("installs the newest release, prereleases included, and it runs", async () => {
    const r = await install();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(requests).toEqual(["/api/releases?per_page=1", `/dl/v0.2.0-beta.1/${ASSET}`, "/dl/v0.2.0-beta.1/SHA256SUMS"]);
    expect(statSync(installed()).mode & 0o777).toBe(0o755);
    expect(Bun.spawnSync([installed(), "version"]).stdout.toString()).toBe("0.2.0-beta.1\n");
    expect(r.out).toContain(`Installed AgentPass 0.2.0-beta.1 to ${installed()}`);
    expect(r.out).toContain(`export PATH="${installDir}:$PATH"`);
    for (const step of ["agentpass init", 'eval "$(agentpass hook zsh)"', "agentpass up"]) expect(r.out).toContain(step);
  });

  test("skips the PATH hint when the install dir is already on PATH", async () => {
    const r = await install({ PATH: `${installDir}:${fakeBin}:${process.env.PATH}` });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("export PATH");
  });

  test("AGENTPASS_VERSION pins the version without asking the API", async () => {
    for (const pinned of ["v0.1.0", "0.1.0"]) {
      requests = [];
      const r = await install({ AGENTPASS_VERSION: pinned });
      expect(r.code).toBe(0);
      expect(requests).toEqual([`/dl/v0.1.0/${ASSET}`, "/dl/v0.1.0/SHA256SUMS"]);
      expect(Bun.spawnSync([installed(), "version"]).stdout.toString()).toBe("0.1.0\n");
    }
  });

  test("a checksum mismatch aborts and installs nothing", async () => {
    corrupt = true;
    const r = await install();
    expect(r.code).toBe(1);
    expect(r.err).toContain("checksum mismatch");
    expect(existsSync(installDir)).toBe(false);
  });

  test("no published release prints where to watch and exits 1", async () => {
    releases = [];
    const r = await install();
    expect(r.code).toBe(1);
    expect(r.err).toContain("No AgentPass release has been published yet. Watch https://github.com/Rakesh1002/agentpass/releases");
    expect(existsSync(installDir)).toBe(false);
  });

  test("a pinned version that does not exist fails clearly", async () => {
    const r = await install({ AGENTPASS_VERSION: "9.9.9" });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`could not download ${ASSET} for v9.9.9`);
    expect(existsSync(installDir)).toBe(false);
  });

  test("rejects unsupported operating systems and architectures before downloading", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ FAKE_OS: "MINGW64_NT-10.0" }, "Windows is not supported"],
      [{ FAKE_OS: "FreeBSD" }, "unsupported OS: FreeBSD"],
      [{ FAKE_ARCH: "riscv64" }, "unsupported architecture: riscv64"],
    ];
    for (const [env, message] of cases) {
      const r = await install(env);
      expect(r.code).toBe(1);
      expect(r.err).toContain(message);
    }
    expect(requests).toEqual([]);
    expect(existsSync(installDir)).toBe(false);
  });

  test("maps arm64 and aarch64 on macOS and Linux to the right asset", async () => {
    releases = ["v0.1.0"];
    for (const [os, arch, asset] of [["Darwin", "arm64", "agentpass-darwin-arm64"], ["Linux", "aarch64", "agentpass-linux-arm64"], ["Linux", "amd64", ASSET]]) {
      requests = [];
      await install({ FAKE_OS: os!, FAKE_ARCH: arch!, AGENTPASS_VERSION: "0.1.0" });
      expect(requests[0]).toBe(`/dl/v0.1.0/${asset}`);
    }
  });
});
