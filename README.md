# AgentPass

A local credential firewall for AI coding agents. Add a key once; every agent
and worktree uses it through placeholders, and the real value only goes to the
hosts you pin it to.

> **Status: alpha.** It works and is covered by tests, but commands and file
> formats may still change. macOS and Linux only.

## How it works

1. Keys live in an encrypted vault in `~/.agentpass`, unlocked from your OS
   keychain (or a passphrase).
2. A project's `.agentpass.json` maps env var names to vault secrets. Agents
   get placeholders such as `STRIPE_SECRET_KEY={{secret:stripe}}`, never the
   value.
3. Agents run with `HTTPS_PROXY` pointing at a local proxy. When a request to
   a pinned host carries a placeholder in its `Authorization`, `x-api-key` or
   `api-key` header, the proxy swaps in the real value. A placeholder sent to
   any other host, port, method or path is refused with `egress_blocked`.
4. Every proxied request is written to a local audit log with the secret
   names used (never the values) and a session tag for the repo, branch and
   agent.

## Quick start

Requires [Bun](https://bun.sh) 1.3 or newer.

```bash
git clone https://github.com/Rakesh1002/agentpass.git
cd agentpass
bun install
alias agentpass="bun run $PWD/src/cli.ts"

agentpass scan                                  # find plaintext keys your agents can read
agentpass onboard                               # vault, agent lockout, background proxy
agentpass add anthropic                         # value from a hidden prompt; pinned to its API host

cd ~/code/my-app
agentpass import                                # move keys from .env* into the vault, leave placeholders
agentpass link STRIPE_SECRET_KEY stripe         # or map one by hand in .agentpass.json
agentpass run -- claude                         # placeholders + proxy env for this project
```

`onboard` runs `init`, `protect` and `up` in turn, and `agentpass add stripe --host api.stripe.com` pins any
other key to the host you name.

To pipe a value instead of typing it: `printf %s "$VALUE" | agentpass add <name>`.
Values are never accepted as command-line arguments, because other processes can
read those.

Instead of `agentpass run`, you can add the shell hook to your rc file, so every
shell in a project gets its placeholders and proxy env as you `cd` in and out:

```bash
eval "$(agentpass hook zsh)"    # or bash, fish
```

## Commands

| Command | What it does |
| --- | --- |
| `agentpass onboard` | First-time setup: `init` if there is no vault, then `protect` and `up` |
| `agentpass import [file...] [--yes]` | Move recognised keys from `.env` files (default: `./.env*`) into the vault, pinned to their provider's host, replace each with its placeholder and link it in `.agentpass.json` |
| `agentpass protect [--remove]` | Add deny rules so Claude Code and Codex can't run `agentpass` or ask the keychain for the vault key, and Claude Code can't read the vault or edit `~/.agentpass` |
| `agentpass init [--passphrase] [--force]` | Create the vault. It unlocks from the OS keychain unless `--passphrase` (or `AGENTPASS_PASSWORD`) is given |
| `agentpass unlock-mode keychain\|passphrase` | Re-encrypt the vault for the other unlock mode (backs it up first) |
| `agentpass add <name> [--host h[,h]] [--path prefix] [--method GET,POST]` | Add a secret with its pins. The value comes from a hidden prompt, or stdin when piped |
| `agentpass pins <name> [--set h[,h] [--path prefix] [--method M] \| --clear]` | Show, replace or remove a secret's pins |
| `agentpass list` | List secrets and their pins |
| `agentpass get <name>` | Show a secret, masked |
| `agentpass delete <name>` | Delete a secret (alias `rm`) |
| `agentpass link <VAR> <secret>` | Map an env var to a secret in `.agentpass.json` |
| `agentpass unlink <VAR>` | Remove a mapping from `.agentpass.json` |
| `agentpass allow [dir]` | Trust this `.agentpass.json` as it is now |
| `agentpass deny [dir]` | Revoke trust in this `.agentpass.json` |
| `agentpass project` | Show the resolved mapping for the current directory |
| `agentpass env [--shell zsh\|bash\|fish\|json] [--dir DIR]` | Print the placeholder env for a directory (no vault needed) |
| `agentpass hook zsh\|bash\|fish` | Print the shell hook |
| `agentpass run -- <cmd> [args]` | Run a command with this project's placeholders and proxy env, starting a proxy for it if none is running |
| `agentpass up` | Start the proxy in the background, now and at login (keychain mode only) |
| `agentpass down` | Stop the background proxy and remove it from login |
| `agentpass status` (or `doctor`) | Show vault mode, lock state, background proxy, port, CA path, agent lockout and whether this shell uses the proxy |
| `agentpass proxy start` / `proxy stop` | Run the proxy in the foreground on port 8888 |
| `agentpass daemon [--port N]` | Run the proxy in the foreground (what the background service runs) |
| `agentpass audit [-n N]` | Show the last N proxied requests (default 20) |
| `agentpass scan [--root DIR]... [--json]` | Find plaintext secrets your AI agents can read |
| `agentpass ca path` | Print the local CA certificate path |
| `agentpass import-claude` | Import the Anthropic key from your Claude Code config |
| `agentpass routing init\|show\|enable\|disable` | Manage the optional cost-aware model routing config |

`agentpass help` prints the same list.

## Projects: `.agentpass.json` and `allow`

`agentpass link` updates the nearest manifest, or creates one at the git root
of the current directory:

```json
{
  "env": {
    "STRIPE_SECRET_KEY": "stripe"
  }
}
```

It holds names only, so it is safe to commit. Every worktree and clone of the
repo then gets the same placeholders from the same vault. Only names that look
like credentials (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AUTH`, `_URL`, ...) can
be mapped, and names a shell or toolchain reads (`PATH`, `NODE_OPTIONS`,
`GIT_*`, `*_PROXY` and similar) are refused.

A manifest you did not write yourself, for example one in a repo you just
cloned, does nothing until you review it and run `agentpass allow`. Trust is
recorded by the file's content hash, so any edit needs a new `allow`, and an
identical manifest in another worktree is already trusted. `agentpass run` and
`agentpass env` refuse to run against an unreviewed manifest; the shell hook
warns and exports nothing from it.

Defaults that apply everywhere go in `~/.agentpass/config.json` in the same
format.

## Pins

Each secret carries pins: the hosts, and optionally methods and a path
prefix, it may be sent to. A secret with no pins is never substituted.

| Host form | Matches |
| --- | --- |
| `api.example.com` | that host on the default port (443 for HTTPS, 80 for HTTP) |
| `host:port` | that host on that port only, e.g. `localhost:8080` |
| `[::1]:port` | an IPv6 address, bracketed, with or without `:port` |
| `*` | any host, default port only |
| `*:N` | any host on port N |
| `*:*` | any host on any port |

```bash
agentpass add stripe-test --host api.stripe.com --method GET,POST --path /v1
agentpass pins stripe-test --set api.stripe.com,localhost:12111
agentpass pins stripe-test --clear
```

- `--method` and `--path` apply to every host given with them. A path prefix
  matches whole segments (`/v1` matches `/v1/charges`, not `/v1beta`), and
  paths with dot segments or encoded slashes are refused.
- Secrets named after a built-in provider (`openai`, `anthropic`, `groq`,
  `openrouter`, or `openai-2` and so on) are pinned to that provider's API host
  on port 443 when you give no `--host`.
- Values only travel over HTTPS. A placeholder in a plain-HTTP request is
  refused (`insecure_scheme`) unless the host is loopback.
- Wildcard pins work, and every request that relies on one is flagged with
  `wildcard=` in the audit log.

The proxy only terminates TLS for hosts that some secret is pinned to. Other
traffic is tunnelled untouched, so an unpinned host receives the literal
placeholder text, never the value.

## The background proxy

```bash
agentpass up        # install a launchd (macOS) or systemd --user (Linux) service and start it
agentpass status    # Vault: keychain mode, unlockable / Daemon: running (pid ..., port 8888, ...)
agentpass down      # stop it and remove it from login
```

The service unlocks the vault from the OS keychain, so `up` needs a vault in
keychain mode (`agentpass unlock-mode keychain` to switch). Logs go to
`~/.agentpass/daemon.log`. Without it, `agentpass run` starts a proxy for the
lifetime of the command it runs.

The proxy env includes `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and
`REQUESTS_CA_BUNDLE`, pointing at the local AgentPass CA (plus your system
roots), so Node, Python and curl-based tools accept the proxy's certificates
without changes to your system trust store. For a secret named after a
built-in provider it also sets that SDK's base URL (`ANTHROPIC_BASE_URL`,
`OPENAI_BASE_URL`, `GROQ_BASE_URL`, `OPENROUTER_BASE_URL`) to a local route.
On that route, if you have several keys for the provider (`openai`,
`openai-2`, ...), a `429` or `401` from one key fails over to the next within
the same request.

## `scan`

```bash
agentpass scan               # current directory plus your home config files
agentpass scan --root ~/code --json
```

Looks for plaintext keys in the places agents read: shell rc files,
`~/.claude.json` and Claude settings, `~/.codex/config.toml`,
`~/.gemini/settings.json`, `~/.cursor/mcp.json`, and `.env`, `.mcp.json` and
`.claude/settings*.json` files in the scanned roots. Findings are masked and grouped by how exposed they are
(tracked in git first). It exits 1 when it finds something, so it can run in a
hook or CI.

## Audit and session tags

```
$ agentpass audit -n 2
2026-11-14T08:58:09.903Z GET api.stripe.com:443 status=200 secrets=stripe duration=348ms session=my-app@main+claude
2026-11-14T08:58:09.537Z GET api.openai.com:443 status=403 secrets=stripe duration=1ms error="egress_blocked" session=my-app@main+claude
```

Each request is tagged `<repo>@<branch>`, plus `+<agent>` when started with
`agentpass run`, so you can tell which worktree and agent used which key. The
log lives in `~/.agentpass/audit.db` and never contains secret values.

## What it protects against

- No plaintext keys in `.env`, shell rc or agent config files.
- Real values never enter the agent's environment, transcripts or commits.
  The agent only ever sees `{{secret:name}}`.
- Values are only sent over HTTPS to the hosts, ports, methods and paths each
  key is pinned to. Everything else is refused and logged.
- Manifests from cloned repos need your explicit approval before they map
  anything.
- With `agentpass protect`, Claude Code and Codex refuse to run `agentpass` or
  ask the keychain for the vault key. Claude Code also refuses to read the vault
  or the CA key, or to edit anything in `~/.agentpass`.

## What it doesn't

AgentPass keeps keys out of what an agent sees and limits where they can be
sent. It is not a sandbox. The `protect` rules stop an agent's ordinary commands,
not one that deliberately works around its own permission system, and Codex
has no rule that keeps it from reading files in `~/.agentpass` (the vault stays
encrypted). A process running as your user can still read AgentPass's files,
use your keychain, or change its configuration if it sets out to. If you run an agent you don't trust, run it in its own sandbox or
container as well.

## Security details

- Values are encrypted at rest with AES-256-GCM. Each value is bound to its
  name and pins, so a row edited outside AgentPass fails with
  `integrity_failed` instead of being sent.
- In keychain mode the vault key is a random secret in the macOS Keychain or
  Linux Secret Service. In passphrase mode it is derived with PBKDF2 (100k
  iterations) and read from `AGENTPASS_PASSWORD` or a TTY prompt.
- The local CA (`agentpass ca path`) is generated on first use and only signs
  certificates for pinned hosts.

## Repository layout

```
src/        CLI, proxy, vault, manifests, scan (Bun + TypeScript, tests alongside)
apps/web/   Marketing site (Next.js on Cloudflare Workers via OpenNext)
docs/       Design notes and ADRs
SPEC.md     Original MVP specification
```

## Contributing

New here? Start with [CONTRIBUTING.md](./CONTRIBUTING.md). It covers dev
setup, the test workflow, code style, and how to open your first PR.

## License

MIT
