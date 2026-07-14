#!/usr/bin/env bun
import { parseArgs } from "util";
import { vault } from "./vault";
import { proxy } from "./proxy";
import { claudeShim } from "./claude";
import { listAudit } from "./audit";
import { certificateAuthority } from "./ca";
import { loadRoutingConfig, writeDefaultConfig } from "./router";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { vaultFile, routingConfigFile } from "./paths";

const VAULT_FILE = vaultFile();

let globalPassword: string | undefined;

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    process.exit(1);
  }

  const { values } = parseArgs({
    args,
    options: {
      password: { type: "string", short: "p" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  globalPassword = typeof values.password === "string" ? values.password : undefined;

  const command = args[0];

  try {
    switch (command) {
      case "init":
        await handleInit(args.slice(1));
        break;
      case "add":
        await handleAdd(args.slice(1));
        break;
      case "list":
        await handleList();
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
  init                  Initialize vault with master password
  add <name> <value>    Add a secret
  list                  List all secrets
  get <name>            Get a secret value
  delete <name>         Delete a secret
  proxy start           Start HTTP/HTTPS proxy (port 8888)
  proxy stop            Stop proxy
  run <cmd>             Run command with proxy enabled
  audit                 Show recent proxy audit events
  ca path               Print local CA certificate path
  status                Show vault and proxy status
  import-claude         Import existing Anthropic key from Claude Code config
  routing init          Generate default routing config
  routing show          Display current routing config
  routing enable        Enable cost-aware routing
  routing disable       Disable cost-aware routing

Examples:
  agentpass init
  agentpass add openai sk-...
  agentpass add anthropic sk-ant-...
  agentpass routing init
  agentpass run claude
  agentpass run cursor-agent
`);
}

async function ensureVaultFile(): Promise<void> {
  if (!existsSync(VAULT_FILE)) {
    throw new Error("Vault not initialized. Run: agentpass init");
  }
}

async function unlock(): Promise<void> {
  if (vault.check()) return;
  let password = globalPassword;
  if (!password) {
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await new Promise<string>((res) =>
      rl.question("Master password: ", (a) => {
        rl.close();
        res(a);
      })
    );
  }
  await vault.init(password);
}

async function handleInit(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      password: { type: "string", short: "p" },
      force: { type: "boolean", short: "f", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (existsSync(VAULT_FILE) && !values.force) {
    console.log("Vault already exists. Use --force to reinitialize.");
    return;
  }

  let password: string | undefined = typeof values.password === "string" ? values.password : undefined;
  if (!password) {
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string) =>
      new Promise<string>((res) => rl.question(q, (a) => res(a)));

    password = await ask("Enter master password: ");
    const confirm = await ask("Confirm master password: ");
    rl.close();

    if (password !== confirm) throw new Error("Passwords do not match");
  }

  if (password.length < 8) throw new Error("Password must be at least 8 characters");

  await vault.init(password);
  console.log("Vault initialized at ~/.agentpass/vault.db");
  vault.close();
}

async function handleAdd(args: string[]) {
  await ensureVaultFile();

  const { values, positionals } = parseArgs({
    args,
    options: {
      type: { type: "string", short: "t", default: "api_key" },
    },
    allowPositionals: true,
    strict: false,
  });

  const name = positionals[0];
  const value = positionals[1];
  const type = typeof values.type === "string" ? values.type : "api_key";

  if (!name || !value) {
    throw new Error("Usage: agentpass add <name> <value>");
  }

  await unlock();
  await vault.add(name, value, type);
  console.log(`Added secret: ${name}`);
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
        `  ${s.name} (${s.type}) — updated ${new Date(s.updated).toLocaleDateString()}`
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

  const masked =
    value.length <= 12
      ? "*".repeat(value.length)
      : value.slice(0, 7) + "..." + value.slice(-4);
  console.log(`${name}: ${masked}`);
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
  if (args.length === 0) throw new Error("Usage: agentpass run <command> [args...]");

  await ensureVaultFile();
  await unlock();
  await proxy.start();

  const cmd = args[0];
  if (!cmd) throw new Error("Usage: agentpass run <command> [args...]");
  const cmdArgs = args.slice(1);

  const child: ChildProcess = spawn(cmd, cmdArgs, {
    env: {
      ...process.env,
      HTTP_PROXY: `http://127.0.0.1:${proxy.port()}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxy.port()}`,
      NODE_EXTRA_CA_CERTS: certificateAuthority.certPath(),
    },
    stdio: "inherit",
  });

  const cleanup = async (code: number) => {
    await proxy.stop();
    vault.close();
    process.exit(code);
  };

  process.on("SIGINT", () => cleanup(130));
  child.on("error", (err: Error) => {
    console.error(`Failed to start "${cmd}":`, err.message);
    cleanup(1);
  });
  child.on("exit", (code: number | null) => cleanup(code ?? 0));
}

async function handleStatus() {
  const vaultExists = existsSync(VAULT_FILE);
  console.log(`Vault: ${vaultExists ? "initialized" : "not initialized"}`);
  console.log(`Proxy: ${proxy.isRunning() ? `running on :${proxy.port()}` : "stopped"}`);
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
    console.log(
      `${timestamp} ${row.method} ${row.destination} status=${status} secrets=${secrets} duration=${row.durationMs}ms${error}`
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
