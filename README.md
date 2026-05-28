# AgentPass

A local-first credential broker for AI agents. Stores API keys in an encrypted
vault on your machine and brokers them to agents (Claude Code, Cursor,
OpenClaw, Codex) through a local HTTP proxy.

> **Status: early development.** Vault encryption, placeholder substitution for
> direct HTTP proxy requests, audit logging, and a local CA scaffold are
> working and covered by tests. Generic HTTPS header rewriting via TLS
> interception is **not wired up yet** — `CONNECT` traffic is tunneled
> unmodified. See [SPEC.md](./SPEC.md) for the current acceptance criteria.

## What it does

- **Encrypted vault** — secrets stored at rest with AES-256-GCM; master
  password derived with PBKDF2 (100k iterations).
- **Provider-routed proxy** — `agentpass run <cmd>` starts a local proxy on
  `:8888` and points `HTTP_PROXY` / `HTTPS_PROXY` at it. Requests to
  `/openai/*`, `/anthropic/*`, `/groq/*`, `/openrouter/*` are forwarded to the
  upstream provider with the right auth header attached.
- **Placeholder substitution** — for direct HTTP proxy requests, any
  `Authorization` / `x-api-key` / `api-key` header containing
  `{{secret:name}}` is substituted with the real value from the vault.
- **HTTPS `CONNECT` tunneling** — standard HTTPS clients tunnel through
  without breakage, but their encrypted headers are not (yet) rewritten.
- **Local audit log** — every proxied request appends `method`, `destination`,
  `status`, `duration`, and the secret *names* that were used. Raw secret
  values are never logged.

## Repository layout

```
.
├── src/                  # CLI + proxy + vault (Bun + TypeScript)
│   ├── cli.ts            # Command dispatcher
│   ├── vault.ts          # SQLite-backed encrypted store
│   ├── proxy.ts          # HTTP/HTTPS proxy
│   ├── providers.ts      # Upstream provider map (OpenAI, Anthropic, …)
│   ├── ca.ts             # Local CA + per-host cert minting (for future MITM)
│   ├── audit.ts          # Append-only audit log
│   ├── claude.ts         # Claude Code config importer
│   ├── paths.ts          # Path resolution (~/.agentpass)
│   ├── agentpass.test.ts # Vault, substitution, CONNECT, CA tests
│   └── proxy.test.ts     # Provider-routing tests
├── apps/web/             # Marketing site (Next.js → Cloudflare Workers)
├── public/               # Static landing page assets
├── SPEC.md               # MVP specification
├── CONTRIBUTING.md       # Onboarding + dev workflow
└── package.json
```

## Quick start

```bash
git clone https://github.com/Rakesh1002/agentpass.git
cd agentpass
bun install

# Initialize the vault (creates ~/.agentpass/vault.db)
bun run src/cli.ts init

# Add a key
bun run src/cli.ts add openai sk-...

# List the names (values never displayed)
bun run src/cli.ts list

# Run an agent through the proxy
bun run src/cli.ts run curl https://api.openai.com/v1/models
```

## Commands

| Command                         | What it does                                    |
| ------------------------------- | ----------------------------------------------- |
| `agentpass init`                | Initialize the vault with a master password     |
| `agentpass add <name> <value>`  | Add a secret                                    |
| `agentpass list`                | List secret names                               |
| `agentpass get <name>`          | Show a secret (masked)                          |
| `agentpass delete <name>`       | Delete a secret                                 |
| `agentpass proxy start`         | Start the proxy on `:8888`                      |
| `agentpass proxy stop`          | Stop the proxy                                  |
| `agentpass run <cmd>`           | Run `<cmd>` with `HTTP(S)_PROXY` set            |
| `agentpass audit`               | Show recent proxy audit events                  |
| `agentpass ca path`             | Print the local CA certificate path             |
| `agentpass import-claude`       | Import an Anthropic key from Claude Code config |
| `agentpass status`              | Show vault + proxy state                        |

## Architecture

```
┌─────────────┐    ┌───────────────┐    ┌───────────┐
│ AI Agent    │───▶│ AgentPass     │───▶│ Upstream  │
│ (Claude,    │    │ Proxy :8888   │    │ Provider  │
│  Cursor, …) │    │               │    │ (OpenAI,  │
└─────────────┘    └───────┬───────┘    │  …)       │
                           │            └───────────┘
                    ┌──────▼──────┐
                    │ Vault       │
                    │ (SQLite,    │
                    │  encrypted) │
                    └─────────────┘
```

## Security

- Secrets are encrypted at rest with AES-256-GCM under a PBKDF2-derived key.
- The vault file (`~/.agentpass/vault.db`) is unreadable without the master
  password. Wrong passwords are rejected before any secret is decrypted.
- The local CA (`~/.agentpass/ca.crt` / `ca.key`) is generated on demand and
  reserved for the upcoming TLS-interception flow. It is **not yet** used by
  the proxy — installing it in your trust store has no effect today.
- The audit log records secret *names* only. Raw values are never persisted.

## Contributing

New here? Start with [CONTRIBUTING.md](./CONTRIBUTING.md) — it covers dev
setup, the test workflow, code style, and how to open your first PR.

## License

MIT
