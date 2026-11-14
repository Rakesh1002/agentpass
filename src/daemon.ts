import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { runCommand, type Runner } from "./keychain";
import { daemonFile } from "./paths";
import { proxyReachable } from "./shellenv";

export const SERVICE_LABEL = "sh.agentpass.proxy";
const UNIT = `${SERVICE_LABEL}.service`;

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    const info = JSON.parse(readFileSync(daemonFile(), "utf-8"));
    const valid = Number.isInteger(info.pid) && info.pid > 0 && Number.isInteger(info.port) && info.port > 0 && info.port < 65536;
    return valid ? info : null;
  } catch {
    return null;
  }
}

export function writeDaemonInfo(info: DaemonInfo): void {
  const tmp = `${daemonFile()}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(info) + "\n", { mode: 0o600 });
  renameSync(tmp, daemonFile());
}

export function removeDaemonInfo(pid: number): void {
  if (readDaemonInfo()?.pid === pid) rmSync(daemonFile(), { force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function daemonState(): Promise<{ info: DaemonInfo | null; alive: boolean; healthy: boolean }> {
  const info = readDaemonInfo();
  const alive = info !== null && pidAlive(info.pid);
  return { info, alive, healthy: alive && (await proxyReachable(info.port)) };
}

export interface ServiceSpec {
  command: string[];
  env: Record<string, string>;
  log: string;
}

export function serviceFile(platform: string = process.platform): string {
  const home = process.env.HOME || homedir();
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  if (platform === "linux") return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", UNIT);
  throw new Error("The background proxy supports macOS (launchd) and Linux (systemd --user)");
}

export function installService(spec: ServiceSpec, run: Runner = runCommand, platform: string = process.platform): "started" | "already running" {
  const file = serviceFile(platform);
  if (platform === "darwin") {
    const domain = `gui/${process.getuid!()}`;
    if (run("launchctl", ["print", `${domain}/${SERVICE_LABEL}`]).status === 0) return "already running";
    writeServiceFile(file, launchdPlist(spec));
    check(run("launchctl", ["bootstrap", domain, file]), "launchctl bootstrap");
    return "started";
  }
  if (run("systemctl", ["--user", "is-active", "--quiet", UNIT]).status === 0) return "already running";
  writeServiceFile(file, systemdUnit(spec));
  check(run("systemctl", ["--user", "daemon-reload"]), "systemctl --user daemon-reload");
  check(run("systemctl", ["--user", "enable", "--now", UNIT]), "systemctl --user enable");
  return "started";
}

// Returns whether a service file was installed. The file is removed so the proxy does not come back at login.
export function removeService(run: Runner = runCommand, platform: string = process.platform): boolean {
  const file = serviceFile(platform);
  if (platform === "darwin") run("launchctl", ["bootout", `gui/${process.getuid!()}/${SERVICE_LABEL}`]);
  else run("systemctl", ["--user", "disable", "--now", UNIT]);
  const installed = existsSync(file);
  rmSync(file, { force: true });
  if (platform === "linux") run("systemctl", ["--user", "daemon-reload"]);
  return installed;
}

function writeServiceFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o644 });
}

function check(r: { status: number | null; stderr: string }, what: string): void {
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${r.stderr.trim()}`);
}

function launchdPlist({ command, env, log }: ServiceSpec): string {
  const str = (v: string) => `<string>${v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(SERVICE_LABEL)}
  <key>ProgramArguments</key>
  <array>${command.map(str).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key>${str(v)}`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${str(log)}
  <key>StandardErrorPath</key>${str(log)}
</dict>
</plist>
`;
}

function systemdUnit({ command, env, log }: ServiceSpec): string {
  // systemd expands % specifiers everywhere and $VARS in ExecStart
  const quote = (v: string) => `"${v.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;
  const logPath = log.replace(/%/g, "%%");
  return `[Unit]
Description=AgentPass credential proxy

[Service]
ExecStart=${command.map((c) => quote(c).replace(/\$/g, "$$$$")).join(" ")}
${Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}\n`).join("")}Restart=always
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}
