import { parseArgs } from "util";
import { vault } from "./vault";
import { proxy } from "./proxy";
import { claudeShim } from "./claude";
import { listAudit } from "./audit";
import { certificateAuthority } from "./ca";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { existsSync } from "fs";
import { vaultFile } from "./paths";

const VAULT_FILE = vaultFile();

let globalPassword: string | undefined;

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    process.exit(1);
  }

  const { values, positionals } = parseArgs({
    args: args,
    options: {
      password: { type: "string", short: "p" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help && positionals[0] === "help") {
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
      case "help":
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
🔐 AgentPass - Credential broker for AI agents

Usage: agentpass <command> [options]

Commands:
  init                  Initialize vault with master password
  add <name> <value>    Add a secret
  list                  List all secrets
  get <name>            Get a secret value
  delete <name>         Delete a secret
  proxy start           Start HTTP proxy (port 8888)
  proxy stop            Stop HTTP proxy
  run <cmd>             Run command with proxy enabled
  audit                 Show recent proxy audit events
  ca path               Print local CA certificate path
  status                Show vault and proxy status

Examples:
  agentpass init
  agentpass add openai sk-xxx
  agentpass list
  agentpass run curl https://api.openai.com/v1/models
`);
}

async function ensureVault(): Promise<void> {
  if (!existsSync(VAULT_FILE)) {
    throw new Error("Vault not initialized. Run 'agentpass init' first.");
  }
}

async function getPassword(): Promise<string> {
  if (globalPassword) return globalPassword;

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve));
  const password = await question("Master password: ");
  rl.close();
  return password;
}

async function handleInit(args: string[]) {
  const { values } = parseArgs({
    args: args,
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
    const question = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve));

    password = await question("Enter master password: ");
    const confirm = await question("Confirm master password: ");
    rl.close();

    if (password !== confirm) {
      throw new Error("Passwords do not match");
    }
  }

  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  await vault.init(password);
  console.log("✅ Vault initialized successfully");
  vault.close();
}

async function handleAdd(args: string[]) {
  await ensureVault();

  const { values, positionals } = parseArgs({
    args: args,
    options: {
      type: { type: "string", short: "t", default: "api_key" },
    },
    allowPositionals: true,
    strict: false,
  });

  const password = await getPassword();
  await vault.init(password);

  const name = positionals[0];
  const value = positionals[1];
  const type = typeof values.type === "string" ? values.type : "api_key";

  if (!name || !value) {
    throw new Error("Usage: agentpass add <name> <value> [--type api_key|bearer|basic]");
  }

  if (!vault.check()) {
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve));
    const password = await question("Master password: ");
    rl.close();
    await vault.init(password);
  }

  await vault.add(name, value, type);
  console.log(`✅ Added secret: ${name}`);
  vault.close();
}

async function handleList() {
  await ensureVault();

  if (!vault.check()) {
    const password = await getPassword();
    await vault.init(password);
  }

  const secrets = await vault.list();
  if (secrets.length === 0) {
    console.log("No secrets stored.");
  } else {
    console.log("Stored secrets:");
    secrets.forEach((s) => {
      console.log(`  ${s.name} (${s.type}) - updated ${new Date(s.updated).toLocaleDateString()}`);
    });
  }
  vault.close();
}

async function handleGet(args: string[]) {
  await ensureVault();

  const name = args[0];
  if (!name) {
    throw new Error("Usage: agentpass get <name>");
  }

  if (!vault.check()) {
    const password = await getPassword();
    await vault.init(password);
  }

  const value = await vault.get(name);
  if (value === null) {
    throw new Error(`Secret "${name}" not found`);
  }

  const masked = value.slice(0, 7) + "*".repeat(Math.max(0, value.length - 7));
  console.log(`${name}: ${masked}`);
  console.log("(Use without masking not implemented for security)");
  vault.close();
}

async function handleDelete(args: string[]) {
  await ensureVault();

  const name = args[0];
  if (!name) {
    throw new Error("Usage: agentpass delete <name>");
  }

  if (!vault.check()) {
    const password = await getPassword();
    await vault.init(password);
  }

  const deleted = await vault.delete(name);
  if (deleted) {
    console.log(`✅ Deleted secret: ${name}`);
  } else {
    throw new Error(`Secret "${name}" not found`);
  }
  vault.close();
}

async function handleProxy(args: string[]) {
  const action = args[0];

  if (action === "start") {
    await ensureVault();

    if (!vault.check()) {
      const password = await getPassword();
      await vault.init(password);
    }

    await proxy.start();
  } else if (action === "stop") {
    await proxy.stop();
  } else {
    throw new Error("Usage: agentpass proxy [start|stop]");
  }
}

async function handleRun(args: string[]) {
  if (args.length === 0) {
    throw new Error("Usage: agentpass run <command>");
  }

  await ensureVault();

  if (!vault.check()) {
    const password = await getPassword();
    await vault.init(password);
  }

  await proxy.start();

  const cmd = args[0];
  const cmdArgs = args.slice(1);

  if (!cmd) {
    throw new Error("Usage: agentpass run <command>");
  }

  const child: ChildProcess = spawn(cmd, cmdArgs, {
    env: {
      ...process.env,
      HTTP_PROXY: `http://127.0.0.1:${proxy["config"].port}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxy["config"].port}`,
      NODE_EXTRA_CA_CERTS: certificateAuthority.certPath(),
    },
    stdio: "inherit",
  });

  process.on("SIGINT", async () => {
    await proxy.stop();
    vault.close();
    process.exit(0);
  });

  child.on("exit", async (code: number | null) => {
    await proxy.stop();
    vault.close();
    process.exit(code || 0);
  });
}

async function handleStatus() {
  const vaultExists = existsSync(vaultFile());
  console.log(`Vault: ${vaultExists ? "✅ exists" : "❌ not initialized"}`);
  console.log(`Proxy: ${proxy.isRunning() ? "✅ running" : "❌ stopped"}`);
  console.log(`CA certificate: ${certificateAuthority.certPath()}`);

  const configPath = claudeShim.findConfig();
  if (configPath) {
    console.log(`Claude config: ${configPath}`);
    const apiKey = claudeShim.getApiKey();
    console.log(`Claude API key: ${apiKey ? "✅ found" : "❌ not found"}`);
  } else {
    console.log(`Claude config: ❌ not found`);
  }
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
  await ensureVault();
  const password = await getPassword();
  await vault.init(password);

  await claudeShim.importFromConfig(vault);
  vault.close();
}

main();
