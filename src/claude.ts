import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

interface ClaudeConfig {
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
      if (existsSync(config)) return config;
    }
    return null;
  }

  private readConfig(): ClaudeConfig | null {
    const configPath = this.findConfig();
    if (!configPath) return null;
    try {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return null;
    }
  }

  private getApiKeyFromConfig(): string | null {
    const config = this.readConfig();
    if (!config) return null;
    return config.apiKey || config.anthropicApiKey || null;
  }

  private getApiKeyFromEnv(): string | null {
    if (!existsSync(CLAUDE_ENV_FILE)) return null;
    try {
      const content = readFileSync(CLAUDE_ENV_FILE, "utf-8");
      const match = content.match(/ANTHROPIC_API_KEY=(.+)/);
      return match && match[1] ? match[1].trim() : null;
    } catch {
      return null;
    }
  }

  getApiKey(): string | null {
    return this.getApiKeyFromConfig() || this.getApiKeyFromEnv();
  }

  async importFromConfig(vault: {
    add: (name: string, value: string, type?: string) => Promise<void>;
  }): Promise<boolean> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      console.log("No Claude API key found in ~/.claude/* — skipping.");
      return false;
    }
    await vault.add("anthropic", apiKey, "api_key");
    console.log("Imported Anthropic key into vault as 'anthropic'.");
    return true;
  }
}

export const claudeShim = new ClaudeShim();
