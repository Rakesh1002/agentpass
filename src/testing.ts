import { spawnSync } from "child_process";
import http from "http";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const CLI = resolve(import.meta.dir, "cli.ts");
const TOOLS = ["security", "secret-tool", "launchctl", "systemctl"];

// One shell script standing in for every OS tool the CLI drives; it keeps state in $FAKE_DIR.
const FAKE = `#!/bin/sh
tool=$(basename "$0")
echo "$tool $*" >> "$FAKE_DIR/argv.log"
case "$tool $1" in
  "security -i") [ -n "$FAKE_KEYCHAIN_FAIL" ] && exit 0; sed -n 's/.* -w "\\([^"]*\\)".*/\\1/p' > "$FAKE_DIR/keychain" ;;
  "security find-generic-password") [ -s "$FAKE_DIR/keychain" ] || exit 44; cat "$FAKE_DIR/keychain" ;;
  "secret-tool --version") ;;
  "secret-tool store") [ -n "$FAKE_KEYCHAIN_FAIL" ] && exit 1; cat > "$FAKE_DIR/keychain" ;;
  "secret-tool lookup") [ -s "$FAKE_DIR/keychain" ] || exit 1; cat "$FAKE_DIR/keychain" ;;
  "launchctl print") [ -f "$FAKE_DIR/loaded" ] || exit 113 ;;
  "launchctl bootstrap") touch "$FAKE_DIR/loaded" ;;
  "launchctl bootout") rm -f "$FAKE_DIR/loaded" ;;
  "systemctl --user")
    case "$2" in
      is-active) [ -f "$FAKE_DIR/loaded" ] || exit 3 ;;
      enable) touch "$FAKE_DIR/loaded" ;;
      disable) rm -f "$FAKE_DIR/loaded" ;;
    esac ;;
  *) exit 1 ;;
esac
`;

// What a hooked shell hands the proxy when the proxy is started from it.
export function selfProxyEnv(url: string): Record<string, string> {
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, ALL_PROXY: url, NODE_USE_ENV_PROXY: "1" };
}

export async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

export interface Sandbox {
  root: string;
  home: string;
  agentpassHome: string;
  fakeDir: string;
  env: Record<string, string>;
  cli(args: string[], extra?: Record<string, string>, input?: string): { out: string; err: string; code: number | null };
}

// Temp HOME and AGENTPASS_HOME, with fake keychain and service tools first on PATH.
export function sandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentpass-sandbox-")));
  const home = join(root, "home");
  const agentpassHome = join(root, "agentpass");
  const fakeDir = join(root, "fake");
  const bin = join(fakeDir, "bin");
  mkdirSync(home);
  mkdirSync(bin, { recursive: true });
  for (const tool of TOOLS) {
    writeFileSync(join(bin, tool), FAKE);
    chmodSync(join(bin, tool), 0o755);
  }
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, AGENTPASS_HOME: agentpassHome, FAKE_DIR: fakeDir };
  for (const tool of TOOLS) {
    if (Bun.which(tool, { PATH: env.PATH }) !== join(bin, tool)) throw new Error(`fake ${tool} is not first on PATH`);
  }
  return {
    root,
    home,
    agentpassHome,
    fakeDir,
    env,
    cli(args, extra = {}, input) {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf-8", env: { ...env, ...extra }, input, timeout: 20000 });
      return { out: r.stdout, err: r.stderr, code: r.status };
    },
  };
}
