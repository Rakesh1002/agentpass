# AgentPass

A local-first credential broker for AI agents. Stores API keys in an encrypted
vault on your machine and brokers them to agents (Claude Code, Cursor,
OpenClaw, Codex) through a local HTTP proxy.

> **Status: production-ready core.** Vault encryption, provider-routed
> reverse proxy with multi-key fallback, placeholder substitution, full
> HTTPS MITM interception (TLS CONNECT tunneling with per-host certificate
> minting), and audit logging are all working and covered by tests. The
> forward-proxy mode rewrites encrypted headers over both HTTP and HTTPS.
> See [SPEC.md](./SPEC.md) for the acceptance criteria.

## What it does

- **Encrypted vault** — secrets stored at rest with AES-256-GCM; master
  password derived with PBKDF2 (100k iterations).
- **Provider-routed reverse proxy with multi-key pool** — point your agent at
  `http://localhost:8888/openai/...`, `/anthropic/...`, `/groq/...`, or
  `/openrouter/...` and the proxy makes the HTTPS call to the real upstream
  with the right auth header attached from the vault. Add `openai`,
  `openai-2`, `openai-3` and the proxy falls over to the next key when one
  returns `429` (rate limited) or `401` (rotated), inside a single request,
  with the same secret never re-tried.
- **Placeholder substitution (forward-proxy mode)** — for clients that set
  `HTTP_PROXY=http://localhost:8888` and send absolute URLs, any
  `Authorization` / `x-api-key` / `api-key` header containing
  `{{secret:name}}` is substituted with the real value from the vault.
- **HTTPS MITM interception (forward-proxy mode)** — for clients in
  `CONNECT` tunnel mode, the proxy terminates TLS using a per-host
  certificate signed by the local CA, rewrites `Authorization` /
  `x-api-key` / `api-key` headers via `{{secret:name}}` substitution,
  then re-encrypts and forwards to the real upstream. Both HTTP and HTTPS
  forward-proxy traffic is fully intercepted and rewritten.
- **`/_/health`** — returns `{ "ok": true }` so process supervisors and the
  CLI can probe the proxy.
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
│   ├── ca.ts             # Local CA + per-host cert minting (for MITM engine)
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

# Add a primary key plus a pool of fallbacks
bun run src/cli.ts add openai
bun run src/cli.ts add openai-2
bun run src/cli.ts add openai-3

# Start the proxy
bun run src/cli.ts proxy start

# In another shell, hit the provider-routed endpoint directly
curl http://localhost:8888/openai/v1/models

# Or point an agent through forward-proxy mode
bun run src/cli.ts run curl https://api.openai.com/v1/models
```

## Commands

| Command                         | What it does                                    |
| ------------------------------- | ----------------------------------------------- |
| `agentpass init`                | Initialize the vault with a master password     |
| `agentpass add <name>`          | Add a secret                                    |
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
- The local CA (`~/.agentpass/ca.crt` / `ca.key`) is generated on demand
  and used actively by the HTTPS MITM engine. Install it in your OS/browser
  trust store so the proxy's per-host certificates are accepted by TLS
  clients without warnings (`agentpass ca path` prints the file location).
- The audit log records secret *names* only. Raw values are never persisted.

## Contributing

New here? Start with [CONTRIBUTING.md](./CONTRIBUTING.md) — it covers dev
setup, the test workflow, code style, and how to open your first PR.

## License

MIT
