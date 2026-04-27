import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  apiKey?: string;
  anthropicApiKey?: string;
}

const CLAUDE_CONFIGS = [
  resolve(process.env.HOME || "~", ".claude.json"),
  resolve(process.env.HOME || "~", ".claude", "settings.json"),
  resolve(process.env.HOME || "~", ".config", "claude", "settings.json"),
];

const CLAUDE_ENV_FILE = resolve(process.env.HOME || "~", ".claude", "env");

export class ClaudeShim {
  findConfig(): string | null {
    for (const config of CLAUDE_CONFIGS) {
      if (existsSync(config)) {
        return config;
      }
    }
    return null;
  }

  readConfig(): ClaudeConfig | null {
    const configPath = this.findConfig();
    if (!configPath) return null;

    try {
      const content = readFileSync(configPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  getApiKeyFromConfig(): string | null {
    const config = this.readConfig();
    if (!config) return null;
    return config.apiKey || config.anthropicApiKey || null;
  }

  getApiKeyFromEnv(): string | null {
    const envPath = CLAUDE_ENV_FILE;
    if (!existsSync(envPath)) return null;

    try {
      const content = readFileSync(envPath, "utf-8");
      const match = content.match(/ANTHROPIC_API_KEY=(.+)/);
      return match ? match[1].trim() : null;
    } catch {
      return null;
    }
  }

  getApiKey(): string | null {
    return this.getApiKeyFromConfig() || this.getApiKeyFromEnv();
  }

  storeInVault(vault: { add: (name: string, value: string, type?: string) => Promise<void> }): Promise<void> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      console.log("No Claude API key found in config or env");
      return Promise.resolve();
    }
    return vault.add("claude", apiKey, "bearer");
  }

  importFromConfig(vault: { add: (name: string, value: string, type?: string) => Promise<void> }): Promise<boolean> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      console.log("No Claude API key found to import");
      return Promise.resolve(false);
    }

    return vault.add("claude", apiKey, "bearer").then(() => {
      console.log("✅ Imported Claude API key to vault");
      return true;
    });
  }

  createEnvBackup(): string | null {
    const envPath = CLAUDE_ENV_FILE;
    if (!existsSync(envPath)) return null;

    const backupPath = envPath + ".backup";
    try {
      const content = readFileSync(envPath, "utf-8");
      writeFileSync(backupPath, content);
      return backupPath;
    } catch {
      return null;
    }
  }

  setupVaultEnvRedirect(vaultProxyUrl: string): void {
    const envDir = resolve(process.env.HOME || "~", ".claude");
    const envPath = resolve(envDir, "env");

    if (!existsSync(envDir)) {
      mkdirSync(envDir, { recursive: true });
    }

    const comment = `# AgentPass: Redirect to proxy
# Original ANTHROPIC_API_KEY moved to vault
ANTHROPIC_API_KEY={{secret:claude}}
HTTP_PROXY=${vaultProxyUrl}
HTTPS_PROXY=${vaultProxyUrl}
`;

    const backupPath = this.createEnvBackup();
    if (backupPath) {
      console.log(`📁 Backed up .env to ${backupPath}`);
    }

    writeFileSync(envPath, comment);
    console.log("✅ Configured Claude to use AgentPass proxy");
  }
}

export const claudeShim = new ClaudeShim();