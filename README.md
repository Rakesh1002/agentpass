# AgentPass

Validation sprint for a local-first credential broker for AI agents.

See [VALIDATION_SPRINT.md](./VALIDATION_SPRINT.md) for the active go/no-go plan.

## Why AgentPass?

AI agents leak API keys. GitGuardian reported **28.6M secrets exposed on public GitHub in 2025** — a 34% YoY increase. When your agent breaks because a key rotated, or worse, when your key gets stolen — that's a real problem.

AgentPass is a local-first credential broker prototype that:
- Stores your API keys in an encrypted vault
- Substitutes credential placeholders for direct proxy requests
- Tunnels standard HTTPS `CONNECT` traffic without pretending it can inspect encrypted headers
- Writes local audit events for proxied traffic

## Features

- 🔒 **Encrypted local vault** — AES-256-GCM encryption, master password protected
- ✅ **Password verification** — wrong master passwords are rejected before secret access
- 🌐 **Direct proxy injection** — substitutes `{{secret:name}}` with real credentials in configured headers
- 🔌 **HTTPS CONNECT tunneling** — `HTTPS_PROXY` traffic is tunneled safely, but encrypted headers are not rewritten yet
- 📋 **Local audit log** — records destination, status, duration, and secret names, never secret values
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
| `audit` | Show recent proxy audit events |
| `ca path` | Print the local CA path reserved for the TLS interception spike |
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
- Direct proxy requests use placeholder substitution
- HTTPS `CONNECT` requests are tunneled; generic HTTPS header substitution requires a future trusted local-CA/TLS interception flow

## License

MIT

## Status

⚠️ **Validation sprint** — not ready for production use.

Direct proxy substitution is implemented and tested. Generic HTTPS credential rewriting through `CONNECT` is not implemented yet; the proxy currently tunnels HTTPS traffic without inspecting encrypted headers. That gap is the main day-30 go/no-go blocker.

See [STRATEGY.md](./STRATEGY.md) for product strategy and competitive analysis.
