# AgentPass

Credential broker for AI agents — your AI agents will never see your API keys again.

## Why AgentPass?

AI agents leak API keys. GitGuardian reported **28.6M secrets exposed on public GitHub in 2025** — a 34% YoY increase. When your agent breaks because a key rotated, or worse, when your key gets stolen — that's a real problem.

AgentPass is a local-first credential broker that:
- Stores your API keys in an encrypted vault
- Injects credentials via HTTP proxy so agents never see raw keys
- Handles key rotation automatically

## Features

- 🔒 **Encrypted local vault** — AES-256-GCM encryption, master password protected
- 🔄 **Auto-rotation handling** — detects rotated keys, agents keep working
- 🌐 **HTTP proxy injection** — substitutes `{{secret:name}}` with real credentials
- 💻 **CLI-first** — built for developers who live in the terminal

## Installation

```bash
# Clone and install
git clone https://github.com/Rakesh1002/agentpass.git
cd agentpass
bun install
```

## Quick Start

```bash
# Initialize vault
bun run src/cli.ts init --password your-password

# Add a secret
bun run src/cli.ts add openai sk-xxx

# List secrets (values never shown)
bun run src/cli.ts list

# Run an agent with proxy
bun run src/cli.ts run curl https://api.openai.com/v1/models

# Or start proxy manually
bun run src/cli.ts proxy start
```

## Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize vault with master password |
| `add <name> <value>` | Add a secret |
| `list` | List all secret names |
| `get <name>` | Get secret (masked) |
| `delete <name>` | Delete a secret |
| `proxy start` | Start HTTP proxy (:8888) |
| `proxy stop` | Stop HTTP proxy |
| `run <cmd>` | Run command with proxy enabled |
| `import-claude` | Import Claude Code API key |
| `status` | Show vault and proxy status |

## Architecture

```
┌─────────────┐    ┌───────────────┐    ┌───────────┐
│ AI Agent    │───▶│ AgentPass     │───▶│ External  │
│ (Claude)    │    │ Proxy :8888   │    │ API       │
└─────────────┘    └───────────────┘    └───────────┘
                          │
                    ┌─────┴─────┐
                    │  Vault    │
                    │ (encrypted)│
                    └───────────┘
```

## Security

- Secrets encrypted at rest with AES-256-GCM
- Master password derived with PBKDF2 (100k iterations)
- Vault stored in `~/.agentpass/`
- Proxy uses placeholder substitution — real keys never exposed to agent processes

## License

MIT

## Status

⚠️ **Pre-alpha** — MVP in progress. Not ready for production use.

See [STRATEGY.md](./STRATEGY.md) for product strategy and competitive analysis.