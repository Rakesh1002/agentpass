# AgentPass MVP Specification

## Project Overview

**Name:** AgentPass
**Type:** CLI tool (local-first credential broker for AI agents)
**Core functionality:** Encrypted vault + HTTP proxy that injects credentials into agent HTTP traffic so agents never see raw API keys
**Target users:** Developers running Claude Code, Cursor, OpenClaw agents who manage multiple API keys

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  AI Agent       │────▶│  AgentPass Proxy │────▶│  External API   │
│  (Claude Code)  │     │  :8888           │     │  (OpenAI, etc)  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │
                        ┌─────▼─────┐
                        │  Vault    │
                        │  (SQLite) │
                        └───────────┘
```

### Components

1. **Vault** — Local SQLite database with encryption (using `age` for file encryption, SQLCipher alternative)
2. **Proxy Server** — HTTP server that intercepts requests, substitutes placeholder tokens with real credentials
3. **CLI** — Commands to manage secrets, run agents with proxy

---

## Functionality Specification

### Core Features (MVP)

1. **Encrypted Local Vault**
   - Store secrets: API keys, tokens, passwords
   - AES-256-GCM encryption at rest
   - Master password protection
   - CRUD operations: `agentpass add`, `agentpass get`, `agentpass list`, `agentpass delete`

2. **HTTP Proxy with Credential Injection**
   - Start proxy: `agentpass proxy start`
   - Default port: 8888
   - Intercept outgoing HTTP/HTTPS requests
   - Replace `{{secret:SECRET_NAME}}` patterns in Authorization headers with real keys
   - Support API key (`Bearer xxx`), Basic auth, custom headers

3. **Agent Runner**
   - `agentpass run <command>` — runs command with proxy env vars set
   - Automatically sets `HTTP_PROXY`, `HTTPS_PROXY`
   - Optional: inject specific secrets as env vars

4. **Claude Code Shim**
   - Detect Claude Code config (`claude.json`, `.claude/settings.json`)
   - Auto-rotate rate-limit keys
   - Store Claude Code API key securely

### Data Model

```typescript
interface Secret {
  id: string;
  name: string;          // e.g., "openai", "github"
  type: "api_key" | "bearer" | "basic" | "custom";
  value: string;         // encrypted at rest
  metadata: {
    created: number;
    updated: number;
    lastUsed?: number;
  };
}
```

### CLI Commands

```
agentpass init              Initialize vault with master password
agentpass add <name> <value> [--type api_key|bearer|basic]
agentpass list              List all secret names (not values)
agentpass get <name>        Show secret value (redacted)
agentpass delete <name>     Remove secret
agentpass proxy start       Start HTTP proxy on :8888
agentpass proxy stop        Stop proxy
agentpass run <cmd>         Run command with proxy enabled
agentpass status            Show vault status, proxy state
```

### Edge Cases

- Master password wrong: max 3 attempts, then lock
- Proxy port in use: try next port, report
- Invalid secret format: validation error with helpful message
- Network error during proxy: pass through, log error

---

## Technical Stack

- **Runtime:** Bun 1.3+
- **Language:** TypeScript
- **Database:** bun:sqlite (SQLite)
- **Encryption:** `age` (https://github.com/FiloSottile/age) for file-level, or native Web Crypto API
- **Proxy:** Bun HTTP server with request interception

---

## Acceptance Criteria

1. ✅ `agentpass init` creates encrypted vault file, prompts for master password
2. ✅ `agentpass add openai sk-xxx` stores encrypted secret
3. ✅ `agentpass list` shows secret names only (never values)
4. ✅ `agentpass proxy start` starts HTTP proxy on port 8888
5. ✅ Proxy intercepts requests to `api.openai.com`, replaces placeholder with real key
6. ✅ `agentpass run curl https://api.openai.com/v1/models` works end-to-end
7. ✅ Vault file is encrypted — cannot read secrets with `cat` or text editor
8. ✅ MVP ships as single binary or runnable via `bun run`

---

## File Structure

```
agentpass/
├── src/
│   ├── cli.ts          # CLI entry point
│   ├── commands/       # Command handlers
│   │   ├── init.ts
│   │   ├── add.ts
│   │   ├── list.ts
│   │   ├── get.ts
│   │   ├── delete.ts
│   │   └── proxy.ts
│   ├── vault.ts        # Vault encryption/storage
│   ├── proxy.ts        # HTTP proxy server
│   └── index.ts        # Main exports
├── bin/
│   └── agentpass       # Executable entry
├── package.json
└── README.md
```

---

## Out of Scope (MVP)

- Cloud sync (D1/R2) — V2
- Teams/ seat-based billing — V2
- WebSocket support — V1
- MCP server outbound — V1
- Agent bootstrapping — V2
- Windows support — future