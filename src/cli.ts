#!/usr/bin/env bun
import { parseArgs } from "util";
import { vault, vaultUnlockMode } from "./vault";
import { keychain, keychainAccount, randomSecret } from "./keychain";
import { proxy, ProxyServer } from "./proxy";
import { claudeShim } from "./claude";
import { listAudit } from "./audit";
import { runScan } from "./scan";
import { certificateAuthority } from "./ca";
import { loadRoutingConfig, writeDefaultConfig } from "./router";
import { effectivePins, validatePins, type Pin } from "./egress";
import { KNOWN_SERVICES } from "./providers";
import { spawn } from "child_process";
import { constants } from "os";
import { maskSecret } from "./mask";
import type { ChildProcess } from "child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { agentPassDir, daemonLogFile, vaultFile, routingConfigFile } from "./paths";
import { daemonState, installService, removeDaemonInfo, removeService, serviceFile, writeDaemonInfo } from "./daemon";
import { version } from "../package.json";
import { linkVar, resolveProject, unlinkVar } from "./project";
import { buildEnv, formatEnv, hookScript, proxyPort, proxyReachable } from "./shellenv";

const VAULT_FILE = vaultFile();

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    process.exit(1);
  }

  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const command = args[0];

  try {
    switch (command) {
      case "init":
        await handleInit(args.slice(1));
        break;
      case "unlock-mode":
        await handleUnlockMode(args.slice(1));
        break;
      case "add":
        await handleAdd(args.slice(1));
        break;
      case "list":
        await handleList();
        break;
      case "pins":
        await handlePins(args.slice(1));
        break;
      case "get":
        await handleGet(args.slice(1));
        break;
      case "delete":
      case "rm":
        await handleDelete(args.slice(1));
        break;
      case "proxy":
        await handleProxy(args.slice(1));
        break;
      case "run":
        await handleRun(args.slice(1));
        break;
      case "daemon":
        await handleDaemon(args.slice(1));
        break;
      case "up":
        await handleUp();
        break;
      case "down":
        handleDown();
        break;
      case "env":
        handleEnv(args.slice(1));
        break;
      case "hook":
        handleHook(args.slice(1));
        break;
      case "link":
        handleLink(args.slice(1));
        break;
      case "unlink":
        handleUnlink(args.slice(1));
        break;
      case "project":
        await handleProject();
        break;
      case "status":
        await handleStatus();
        break;
      case "audit":
        await handleAudit(args.slice(1));
        break;
      case "ca":
        await handleCa(args.slice(1));
        break;
      case "import-claude":
        await handleImportClaude();
        break;
      case "routing":
        await handleRouting(args.slice(1));
        break;
      case "scan":
        process.exit(runScan(args.slice(1)));
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
AgentPass — credential broker for AI agents

Usage: agentpass <command> [options]

Commands:
  init [--passphrase]   Initialize the vault; it unlocks from the OS keychain
                        unless --passphrase (or AGENTPASS_PASSWORD) is given
  unlock-mode keychain|passphrase
                        Re-encrypt the vault for the other unlock mode (backs up first)
  add <name>            Add a secret
      --host <h>[,<h>]    Hosts the proxy may send it to (required unless a provider name;
                          host forms below)
      --path <prefix>     Only for paths under this prefix
      --method GET,POST   Only for these methods
  pins <name>           Show a secret's pins
      --set <h>[,<h>]     Replace pins (with --path / --method; host forms below)
      --clear             Remove explicit pins
  list                  List all secrets
  get <name>            Get a secret value
  delete <name>         Delete a secret
  proxy start           Start HTTP/HTTPS proxy (port 8888)
  proxy stop            Stop proxy
  up                    Start the proxy in the background now and at login (keychain mode)
  down                  Stop the background proxy and remove it from login
  daemon [--port N]     Run the proxy in the foreground (what the service runs)
  run -- <cmd> [args]   Run command with this project's placeholder env and proxy
  env [--shell zsh|bash|fish|json] [--dir DIR]
                        Print the placeholder env for a directory (no vault needed)
  hook zsh|bash|fish    Print a shell hook: eval "$(agentpass hook zsh)"
  link <VAR> <secret>   Map an env var to a vault secret in .agentpass.json
  unlink <VAR>          Remove a mapping from .agentpass.json
  project               Show the resolved mapping (checks the vault if it unlocks without a prompt)
  audit                 Show recent proxy audit events
  ca path               Print local CA certificate path
  status                Show vault mode, lock state, daemon, port and CA path
  import-claude         Import existing Anthropic key from Claude Code config
  scan [--root <dir>]   Find plaintext secrets your AI agents can read (--json)
  routing init          Generate default routing config
  routing show          Display current routing config
  routing enable        Enable cost-aware routing
  routing disable       Disable cost-aware routing

Pin hosts (--host, --set):
  api.example.com       that host on the default port (443 for https, 80 for http)
  host:port             that host on that port only, e.g. localhost:8080
  [::1]:port            an IPv6 address, bracketed, with or without :port
  *                     any host, default port only
  *:N                   any host on port N
  *:*                   any host on any port

Passphrase-mode vaults read AGENTPASS_PASSWORD, or prompt on a TTY.

Examples:
  agentpass scan
  agentpass init
  agentpass add openai
  agentpass add anthropic
  agentpass add stripe-test --host api.stripe.com --method GET,POST
  agentpass routing init
  agentpass link OPENAI_API_KEY openai
  agentpass run -- claude
  agentpass run -- cursor-agent
`);
}

async function ensureVaultFile(): Promise<void> {
  if (!existsSync(VAULT_FILE)) {
    throw new Error("Vault not initialized. Run: agentpass init");
  }
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("Interactive prompt requires a TTY. Set AGENTPASS_PASSWORD for the master password; pass secret values with -v.");
  }

  process.stdout.write(question);

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let value = "";

  return await new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
    };

    const finish = (result: string) => {
      cleanup();
      process.stdout.write("\n");
      resolve(result);
    };

    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onData = (chunk: string) => {
      if (chunk === "\r" || chunk === "\n") return finish(value);
      if (chunk === "\u0003") return fail(new Error("Cancelled"));
      if (chunk === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += chunk;
    };

    const onError = (err: Error) => fail(err);

    stdin.on("data", onData);
    stdin.on("error", onError);
  });
}

async function vaultPassword(): Promise<string> {
  if (vaultUnlockMode() === "keychain") {
    const secret = keychain()?.get(keychainAccount());
    if (!secret) throw new Error(`The OS keychain has no key for this vault (service sh.agentpass, account ${keychainAccount()})`);
    return secret;
  }
  if (process.env.AGENTPASS_PASSWORD) return process.env.AGENTPASS_PASSWORD;
  if (!process.stdin.isTTY) {
    throw new Error("The vault is in passphrase mode and there is no TTY to prompt on. Set AGENTPASS_PASSWORD, or switch with: agentpass unlock-mode keychain");
  }
  return promptHidden("Master password: ");
}

async function unlock(): Promise<void> {
  if (vault.check()) return;
  await vault.init(await vaultPassword());
}

async function newPassphrase(): Promise<string> {
  let password = process.env.AGENTPASS_PASSWORD;
  if (!password) {
    password = await promptHidden("Enter master password: ");
    const confirm = await promptHidden("Confirm master password: ");
    if (password !== confirm) throw new Error("Passwords do not match");
  }
  if (password.length < 8) throw new Error("Password must be at least 8 characters");
  return password;
}

async function handleInit(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      force: { type: "boolean", short: "f", default: false },
      passphrase: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (existsSync(VAULT_FILE) && !values.force) {
    console.log("Vault already exists. Use --force to reinitialize.");
    return;
  }

  const kc = values.passphrase || process.env.AGENTPASS_PASSWORD ? null : keychain();
  if (!kc) {
    await vault.init(await newPassphrase());
    vault.setUnlockMode("passphrase");
    console.log(`Vault initialized at ${VAULT_FILE} (passphrase mode)`);
    vault.close();
    return;
  }

  const isNew = !existsSync(VAULT_FILE);
  const secret = randomSecret();
  await vault.init(secret);
  vault.setUnlockMode("keychain");
  try {
    kc.set(keychainAccount(), secret);
  } catch (err) {
    vault.close();
    // the random key is gone, so a vault created for it could never be opened
    if (isNew) for (const suffix of ["", "-wal", "-shm"]) rmSync(VAULT_FILE + suffix, { force: true });
    throw new Error(`${err instanceof Error ? err.message : err}. Use agentpass init --passphrase to use a password instead.`);
  }
  console.log(`Vault initialized at ${VAULT_FILE} (keychain mode: it unlocks from your OS keychain, no password needed)`);
  vault.close();
}

async function handleUnlockMode(args: string[]) {
  const target = args[0];
  if (target !== "keychain" && target !== "passphrase") throw new Error("Usage: agentpass unlock-mode keychain|passphrase");
  await ensureVaultFile();
  if (vaultUnlockMode() === target) {
    console.log(`Vault already uses ${target} mode.`);
    return;
  }

  const kc = target === "keychain" ? keychain() : null;
  if (target === "keychain" && !kc) throw new Error("No OS keychain available (macOS Keychain or Linux secret-tool)");
  await unlock();
  const password = kc ? randomSecret() : await newPassphrase();
  // stored and read back before any value is re-encrypted under it
  kc?.set(keychainAccount(), password);
  const backup = await vault.rekey(password, target);
  vault.close();

  console.log(`Vault now uses ${target} mode. Backup of the previous vault: ${backup}`);
  if (target === "passphrase") {
    console.log(
      `The old key stays in the OS keychain (service sh.agentpass, account ${keychainAccount()}) so the backup still opens. Delete both once the new passphrase works.`
    );
  }
  const daemon = await daemonState();
  if (daemon.healthy) {
    console.log(`The background proxy (pid ${daemon.info?.pid}) still holds the old key; restart it: agentpass down && agentpass up`);
  }
}

async function handleAdd(args: string[]) {
  await ensureVaultFile();

  const { values, positionals } = parseArgs({
    args,
    options: {
      type: { type: "string", short: "t", default: "api_key" },
      value: { type: "string", short: "v" },
      host: { type: "string" },
      path: { type: "string" },
      method: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const name = positionals[0];
  const type = typeof values.type === "string" ? values.type : "api_key";

  if (!name) {
    throw new Error("Usage: agentpass add <name> [--host <host>[,<host>...]] [--path <prefix>] [--method GET,POST]");
  }
  const pins = pinsFromFlags(values.host, values.path, values.method);

  const value =
    typeof values.value === "string" && values.value.length > 0
      ? values.value
      : await promptHidden(`Secret value for ${name}: `);

  await unlock();
  await vault.add(name, value, type, pins);
  console.log(`Added secret: ${name}`);
  const stored = await vault.getPins(name);
  if (effectivePins(name, stored).length === 0) {
    const known = KNOWN_SERVICES[name.split("-")[0] ?? ""];
    console.log(
      `Warning: ${name} has no pins, so the proxy will never substitute it.` +
        ` Pin it with: agentpass pins ${name} --set ${known ?? "<host>"}` +
        (known ? ` (or re-add with --host ${known})` : "")
    );
  }
  vault.close();
}

function pinsFromFlags(host: unknown, path: unknown, method: unknown): Pin[] | undefined {
  if (host === undefined) {
    if (path !== undefined || method !== undefined) throw new Error("--path and --method require hosts (--host or --set)");
    return undefined;
  }
  const hosts = typeof host === "string" ? host.split(",").map((h) => h.trim()).filter(Boolean) : [];
  if (hosts.length === 0) throw new Error("--host needs at least one host");
  if (path !== undefined && typeof path !== "string") throw new Error("--path needs a value");
  if (method !== undefined && typeof method !== "string") throw new Error("--method needs a value");

  const methods = method?.split(",").map((m) => m.trim()).filter(Boolean);
  return validatePins(
    hosts.map((h) => ({ host: h, ...(methods ? { methods } : {}), ...(path ? { pathPrefix: path } : {}) }))
  );
}

function formatPins(name: string, stored: Pin[] | null): string {
  const format = (pin: Pin) =>
    `${pin.host}${pin.pathPrefix ?? ""}${pin.methods ? ` [${pin.methods.join(",")}]` : ""}`;
  if (stored) return stored.map(format).join(", ");
  const implicit = effectivePins(name, null);
  return implicit.length > 0 ? `${implicit.map(format).join(", ")} (implicit)` : "none (deny by default)";
}

async function handlePins(args: string[]) {
  await ensureVaultFile();

  const { values, positionals } = parseArgs({
    args,
    options: {
      set: { type: "string" },
      clear: { type: "boolean", default: false },
      path: { type: "string" },
      method: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const name = positionals[0];
  if (!name) throw new Error("Usage: agentpass pins <name> [--set <host>[,<host>...] [--path <prefix>] [--method GET,POST] | --clear]");
  if (values.set !== undefined && values.clear) throw new Error("Use either --set or --clear");
  const pins = values.clear ? null : pinsFromFlags(values.set, values.path, values.method);

  await unlock();
  if (!(await vault.has(name))) throw new Error(`Secret "${name}" not found`);
  if (pins !== undefined) await vault.setPins(name, pins);
  console.log(`${name}: ${formatPins(name, await vault.getPins(name))}`);
  vault.close();
}

async function handleList() {
  await ensureVaultFile();
  await unlock();

  const secrets = await vault.list();
  if (secrets.length === 0) {
    console.log("No secrets stored.");
  } else {
    console.log("Stored secrets:");
    for (const s of secrets) {
      console.log(
        `  ${s.name} (${s.type}) — pins: ${formatPins(s.name, s.pins)} — updated ${new Date(s.updated).toLocaleDateString()}`
      );
    }
  }
  vault.close();
}

async function handleGet(args: string[]) {
  await ensureVaultFile();

  const name = args[0];
  if (!name) throw new Error("Usage: agentpass get <name>");

  await unlock();
  const value = await vault.get(name);
  if (value === null) throw new Error(`Secret "${name}" not found`);

  console.log(`${name}: ${maskSecret(value)}`);
  vault.close();
}

async function handleDelete(args: string[]) {
  await ensureVaultFile();

  const name = args[0];
  if (!name) throw new Error("Usage: agentpass delete <name>");

  await unlock();
  const deleted = await vault.delete(name);
  if (deleted) console.log(`Deleted secret: ${name}`);
  else throw new Error(`Secret "${name}" not found`);
  vault.close();
}

async function handleProxy(args: string[]) {
  const action = args[0];

  if (action === "start") {
    if (rerunWithoutProxyEnv()) return;
    await ensureVaultFile();
    await unlock();
    await proxy.start();
    process.on("SIGINT", async () => {
      await proxy.stop();
      vault.close();
      process.exit(0);
    });
  } else if (action === "stop") {
    await proxy.stop();
  } else {
    throw new Error("Usage: agentpass proxy [start|stop]");
  }
}

async function handleRun(args: string[]) {
  const sep = args.indexOf("--");
  const argv = sep >= 0 ? args.slice(sep + 1) : args;
  const cmd = argv[0];
  if (!cmd) throw new Error("Usage: agentpass run -- <command> [args...]");

  let port = proxyPort();
  let local: ProxyServer | null = null;
  if (!(await proxyReachable(port))) {
    if (rerunWithoutProxyEnv()) return;
    await ensureVaultFile();
    await unlock();
    local = new ProxyServer({ port });
    await local.start();
    port = local.port();
  }

  const child: ChildProcess = spawn(cmd, argv.slice(1), {
    env: { ...process.env, ...buildEnv(process.cwd(), port) },
    stdio: "inherit",
  });

  const cleanup = async (code: number) => {
    await local?.stop();
    vault.close();
    process.exit(code);
  };

  process.on("SIGINT", () => cleanup(130));
  child.on("error", (err: Error) => {
    console.error(`Failed to start "${cmd}":`, err.message);
    cleanup(1);
  });
  child.on("exit", (code, signal) => cleanup(exitStatus(code, signal)));
}

function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? 128 + (signal ? constants.signals[signal] : 0);
}

const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"];

// A proxy started from a hooked shell inherits HTTPS_PROXY pointing at itself and loops its own upstream
// requests. Bun reads proxy env once at startup, so deleting it from process.env does nothing: rerun this
// command in a clean env instead. Returns true when it did.
function rerunWithoutProxyEnv(): boolean {
  if (!PROXY_ENV.some((name) => process.env[name])) return false;
  const env: Record<string, string | undefined> = { ...process.env, NO_PROXY: "*", no_proxy: "*" };
  for (const name of PROXY_ENV) delete env[name];
  const [exe, ...self] = selfCommand();
  const child = spawn(exe!, [...self, ...process.argv.slice(2)], { env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(exitStatus(code, signal)));
  return true;
}

async function handleDaemon(args: string[]) {
  const { values } = parseArgs({ args, options: { port: { type: "string" } }, allowPositionals: true, strict: false });
  const raw = values.port ?? "8888";
  const port = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 0 && port < 65536)) throw new Error("Usage: agentpass daemon [--port <port>]");
  if (rerunWithoutProxyEnv()) return;
  await ensureVaultFile();

  const existing = await daemonState();
  if (existing.healthy && existing.info) {
    throw new Error(`The AgentPass daemon is already running (pid ${existing.info.pid}, port ${existing.info.port})`);
  }
  await unlock();
  const server = new ProxyServer({ port });
  await server.start();
  writeDaemonInfo({ pid: process.pid, port: server.port(), startedAt: new Date().toISOString(), version });

  // Exit without draining: open tunnels would otherwise hold the process past the service manager's timeout.
  const shutdown = () => {
    removeDaemonInfo(process.pid);
    vault.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function handleUp() {
  await ensureVaultFile();
  if (vaultUnlockMode() !== "keychain") {
    throw new Error("The background proxy unlocks from the OS keychain, but this vault uses a passphrase. Switch first: agentpass unlock-mode keychain");
  }
  // fail here rather than in a service restart loop
  await unlock();
  vault.close();

  const env: Record<string, string> = process.env.AGENTPASS_HOME ? { AGENTPASS_HOME: agentPassDir() } : {};
  const result = installService({ command: [...selfCommand(), "daemon"], env, log: daemonLogFile() });
  if (result === "already running") console.log("The AgentPass background proxy is already running.");
  else console.log(`Started the AgentPass background proxy (${serviceFile()}). Logs: ${daemonLogFile()}`);
}

function handleDown() {
  if (removeService()) console.log("Stopped the AgentPass background proxy and removed it from login.");
  else console.log("The AgentPass background proxy was not installed.");
}

// Absolute invocation so hooks and services work without agentpass on PATH.
function selfCommand(): string[] {
  return Bun.main.endsWith(".ts") ? [process.execPath, Bun.main] : [process.execPath];
}

function handleEnv(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      shell: { type: "string", default: "zsh" },
      dir: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });
  const format = values.shell;
  if (format !== "zsh" && format !== "bash" && format !== "fish" && format !== "json") {
    throw new Error("Usage: agentpass env [--shell zsh|bash|fish|json] [--dir DIR]");
  }
  const dir = typeof values.dir === "string" ? values.dir : process.cwd();
  process.stdout.write(formatEnv(buildEnv(dir), format));
}

function handleHook(args: string[]) {
  const shell = args[0];
  if (shell !== "zsh" && shell !== "bash" && shell !== "fish") {
    throw new Error("Usage: agentpass hook zsh|bash|fish");
  }
  process.stdout.write(hookScript(shell, selfCommand()));
}

function handleLink(args: string[]) {
  const [name, secret] = args;
  if (!name || !secret) throw new Error("Usage: agentpass link <VAR> <secret>");
  console.log(`Linked ${name} -> ${secret} in ${linkVar(process.cwd(), name, secret)}`);
}

function handleUnlink(args: string[]) {
  const name = args[0];
  if (!name) throw new Error("Usage: agentpass unlink <VAR>");
  console.log(`Unlinked ${name} in ${unlinkVar(process.cwd(), name)}`);
}

async function handleProject() {
  const { manifest, env } = resolveProject(process.cwd());
  console.log(`Manifest: ${manifest ?? "none (global defaults only)"}`);
  const entries = Object.entries(env);
  if (entries.length === 0) {
    console.log("No env vars mapped. Add one with: agentpass link <VAR> <secret>");
    return;
  }

  // Only check the vault when it opens without prompting.
  const canOpen = existsSync(VAULT_FILE) && (vaultUnlockMode() === "keychain" || !!process.env.AGENTPASS_PASSWORD);
  if (canOpen) await unlock();
  for (const [name, { secret, source }] of entries) {
    const missing = canOpen && !(await vault.has(secret)) ? " MISSING from vault" : "";
    console.log(`  ${name} -> ${secret} (${source})${missing}`);
  }
  if (canOpen) vault.close();
  else if (existsSync(VAULT_FILE)) console.log("vault locked (set AGENTPASS_PASSWORD to check for missing secrets)");
  else console.log("vault not initialized");
}

async function vaultStatus(): Promise<string> {
  if (!existsSync(VAULT_FILE)) return "not initialized";
  const mode = vaultUnlockMode();
  if (mode === "passphrase" && !process.env.AGENTPASS_PASSWORD) return "passphrase mode, locked (needs the passphrase)";
  try {
    await unlock();
    return `${mode} mode, unlockable`;
  } catch (err) {
    return `${mode} mode, locked (${err instanceof Error ? err.message : err})`;
  } finally {
    vault.close();
  }
}

function describeDaemon({ info, alive, healthy }: Awaited<ReturnType<typeof daemonState>>): string {
  if (!info) return "not running";
  if (healthy) return `running (pid ${info.pid}, port ${info.port}, since ${info.startedAt})`;
  if (alive) return `not responding (pid ${info.pid}, port ${info.port})`;
  return `not running (stale daemon.json for pid ${info.pid})`;
}

async function handleStatus() {
  console.log(`Vault: ${await vaultStatus()}`);
  console.log(`Daemon: ${describeDaemon(await daemonState())}`);
  console.log(`Proxy port: ${proxyPort()}`);
  console.log(`CA certificate: ${certificateAuthority.certPath()}`);

  const configPath = claudeShim.findConfig();
  if (configPath) console.log(`Claude Code config: ${configPath}`);
}

async function handleAudit(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      limit: { type: "string", short: "n", default: "20" },
    },
    allowPositionals: true,
    strict: false,
  });

  const limit = Number(values.limit || "20");
  const rows = listAudit(Number.isFinite(limit) ? limit : 20);
  if (rows.length === 0) {
    console.log("No audit events.");
    return;
  }

  for (const row of rows) {
    const timestamp = new Date(row.timestamp).toISOString();
    const status = row.statusCode || "-";
    const secrets = row.secretNames.length > 0 ? row.secretNames.join(",") : "-";
    const error = row.error ? ` error="${row.error}"` : "";
    const wildcard = row.wildcard ? ` wildcard=${row.wildcard.join(",")}` : "";
    const session = row.sessionTag ? ` session=${row.sessionTag}` : "";
    console.log(
      `${timestamp} ${row.method} ${row.destination} status=${status} secrets=${secrets} duration=${row.durationMs}ms${error}${wildcard}${session}`
    );
  }
}

async function handleCa(args: string[]) {
  const action = args[0];
  if (action === "path" || !action) {
    console.log(certificateAuthority.certPath());
    return;
  }
  throw new Error("Usage: agentpass ca path");
}

async function handleImportClaude() {
  await ensureVaultFile();
  await unlock();
  await claudeShim.importFromConfig(vault);
  vault.close();
}

async function handleRouting(args: string[]) {
  const action = args[0];

  if (action === "init") {
    const path = writeDefaultConfig();
    console.log(`Routing config created at ${path}`);
    console.log("Edit the file to configure tier→provider/model mappings.");
    console.log("Routing is off until you run: agentpass routing enable");
    return;
  }

  if (action === "show") {
    const config = loadRoutingConfig();
    if (!config) {
      console.log("No routing config found. Run: agentpass routing init");
      return;
    }
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (action === "enable" || action === "disable") {
    const configPath = routingConfigFile();
    if (!existsSync(configPath)) {
      throw new Error("No routing config found. Run: agentpass routing init");
    }
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    config.enabled = action === "enable";
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    console.log(`Cost-aware routing ${action === "enable" ? "enabled" : "disabled"}.`);
    return;
  }

  throw new Error("Usage: agentpass routing [init|show|enable|disable]");
}

main();
