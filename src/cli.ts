#!/usr/bin/env bun
import { parseArgs } from "util";
import { vault } from "./vault";
import { proxy } from "./proxy";
import { claudeShim } from "./claude";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

const VAULT_FILE = resolve(process.env.HOME || "~", ".agentpass", "vault.db");
const PROVIDERS = ["openai", "anthropic", "groq", "openrouter"];

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

  globalPassword = values.password as string | undefined;

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
      case "import-claude":
        await handleImportClaude();
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

Vault:
  init                       Initialize encrypted vault
  add <name> <value>         Add a secret
  list                       List secret names (values never shown)
  get <name>                 Show a secret (masked)
  delete <name>              Remove a secret

Multi-key pool (auto-fallback on 429):
  add openai sk-...          Primary key
  add openai-2 sk-...        Pool member #2
  add openai-3 sk-...        Pool member #3

Runtime:
  proxy start                Start provider-routed proxy on :8888
  proxy stop                 Stop proxy
  run <cmd> [args...]        Run cmd with OPENAI/ANTHROPIC base URLs pointed at proxy
  status                     Show vault + proxy status
  import-claude              Import existing Anthropic key from Claude Code config

Supported providers: ${PROVIDERS.join(", ")}

Examples:
  agentpass init
  agentpass add openai sk-...
  agentpass add anthropic sk-ant-...
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

  let password = (values.password as string | undefined) || globalPassword;
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
  const type = (values.type as string) || "api_key";

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
      : value.slice(0, 7) + "…" + value.slice(-4);
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

  const port = proxy.port();
  const baseEnv = {
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/openai/v1`,
    OPENAI_API_KEY: "agentpass-managed",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
    ANTHROPIC_API_KEY: "agentpass-managed",
    GROQ_BASE_URL: `http://127.0.0.1:${port}/groq/openai/v1`,
    GROQ_API_KEY: "agentpass-managed",
    OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/openrouter/api/v1`,
    OPENROUTER_API_KEY: "agentpass-managed",
  };

  const cmd = args[0];
  if (!cmd) throw new Error("Usage: agentpass run <command> [args...]");
  const cmdArgs = args.slice(1);

  console.log(`Running "${cmd}" with AgentPass providers wired up.`);

  const child: ReturnType<typeof spawn> = spawn(cmd, cmdArgs, {
    env: { ...process.env, ...baseEnv },
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

  if (vaultExists) {
    await unlock();
    for (const p of PROVIDERS) {
      const pool = await vault.getPool(p);
      console.log(`  ${p}: ${pool.length} key${pool.length === 1 ? "" : "s"}`);
    }
    vault.close();
  }

  const configPath = claudeShim.findConfig();
  if (configPath) console.log(`Claude Code config: ${configPath}`);
}

async function handleImportClaude() {
  await ensureVaultFile();
  await unlock();
  await claudeShim.importFromConfig(vault);
  vault.close();
}

main();
