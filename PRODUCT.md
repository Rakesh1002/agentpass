# AgentPass — Product Definition

**Date:** 2026-05-23.
**Companion to:** [STRATEGY.md](./STRATEGY.md), [GTM.md](./GTM.md).
**Status:** Validation sprint. The local vault, direct proxy substitution, CONNECT tunneling, and audit log are implemented. Generic HTTPS header rewriting through standard `CONNECT` traffic is not yet implemented and must not be claimed as production behavior.

**Active plan:** [VALIDATION_SPRINT.md](./VALIDATION_SPRINT.md).

---

## 1. What it is

**One-liner:** The local-first credential broker for Claude Code, Cursor, and MCP power users — free, MIT, single binary.

**One paragraph:** AgentPass is a CLI + localhost proxy + encrypted SQLite vault for validating whether AI coding-agent users want local credential brokering. You store API keys in the vault once. For direct proxy requests, AgentPass substitutes `{{secret:openai}}`-style placeholders in configured credential headers and writes a local audit event. For standard HTTPS `CONNECT` traffic, AgentPass currently tunnels safely but cannot inspect or rewrite encrypted headers without a future trusted local-CA/TLS interception flow. Local-first by default — no cloud account required.

---

## 2. Why it exists

Three named pains, each with hard 2026 receipts.

### Pain 1 — Agents leak the keys they touch

AI coding agents that hold raw credentials in process memory leak them. The leak surfaces are growing: prompt injection (the agent is tricked into echoing the key into its output), source-map exposure (the agent or its dev tool ships a sourcemap that contains the secrets it loaded), supply-chain (a malicious MCP server in the agent's context exfiltrates the env), and plain `.env`-in-git mistakes.

- GitGuardian [State of Secrets Sprawl 2026](https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026/): **28.65M new leaked secrets on public GitHub in 2025 (+34% YoY); AI-service credential leaks +81% YoY to 1.27M; 24,008 unique secrets in MCP config files; 2,117 verified valid.**
- [Johann Rehberger demoed end-to-end secrets exfiltration from Devin via prompt injection for $500](https://embracethered.com/blog/posts/2025/devin-can-leak-your-secrets/).
- [Anthropic's Claude Code source map leaked on 2026-03-31](https://www.zscaler.com/blogs/security-research/anthropic-claude-code-leak), making CVE-2026-21852 (API key exfiltration via malicious MCP servers) materially easier to weaponise.
- [WordPress 7.0 shipped 2026-05](https://www.techtimes.com/articles/317028/20260522/wordpress-70-ships-ai-agent-infrastructure-api-key-theft-risk-surfaces-launch-day.htm) with an AI integration form that autofills Anthropic keys in plaintext.
- [Wiz disclosed 1.5M exposed API keys + plaintext OpenAI keys in agent-to-agent messages on Moltbook](https://www.wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys) (Jan–Feb 2026).

### Pain 2 — Keys rotate and quotas burn; agents don't know

When a key rotates, the agent fails. When one of N OpenAI keys hits a 429, the agent retries forever. When a runaway loop spawns at 3am, you wake up to a $4,200 bill — or worse.

- [$4,200 over 63 hours](https://medium.com/@sattyamjain96/the-agent-that-burned-4-200-in-63-hours-a-production-ai-postmortem-d38fd9586a85) — production AI postmortem, April 2026.
- $72K overnight retry loop incident.
- [OpenClaw creator burned through $1.3M in OpenAI API tokens in a single month](https://www.tomshardware.com/tech-industry/artificial-intelligence/openclaw-creator-burns-through-1-3-million-in-openai-api-tokens-in-a-single-month).
- [Replit AI deleted a production database in July 2025](https://cybersrcc.com/2025/08/26/rogue-replit-ai-agent-deletes-production-database-and-executes-deceptive-cover-up/) — keys with no scope or rotation policy.

### Pain 3 — Sharing code with teammates leaks keys by accident

Multi-key reality: a serious agent-using dev now juggles 5+ LLM provider keys (Anthropic, OpenAI, Gemini, Groq, DeepSeek per [OpenClaw setup guide](https://haimaker.ai/blog/openclaw-api-key-setup/)) plus 10–15 MCP-server-scoped tokens (GitHub, Linear, Stripe, Sentry, Notion, HubSpot, Atlassian, Vercel — Q2 2026 MCP launches). When that dev shares a `.cursorrules` or `.claude/settings.json` or `Dockerfile` with a teammate, leakage is the default, not the exception.

- GitGuardian: internal repos are **6× more likely** to contain hardcoded secrets than public repos.
- Cline shipped [a single-key abstraction across Claude, Gemini, and GPT](https://cline.bot/blog/one-api-key-for-claude-gemini-gpt-and-everything-else) — would not exist if the pain weren't widespread.
- ngrok shipped an [AI Gateway SKU](https://ngrok.com/blog/ai-gateway-api-keys-credits) specifically because devs want one key fronting many providers.

---

## 3. How it works

### Architecture

```
┌────────────────┐   localhost     ┌─────────────────────┐    TLS     ┌──────────────────┐
│  AI Agent      │ ─────────────► │  AgentPass Proxy    │ ─────────► │  Destination API │
│  (Claude Code, │   :8888 HTTP   │  - placeholder scan │            │  (api.openai.com,│
│   Cursor, ...) │   plaintext    │  - vault lookup     │            │   api.anthropic, │
│                │   to localhost │  - header rewrite   │            │   github MCP, …) │
└────────────────┘                │  - request forward  │            └──────────────────┘
       ▲                          │  - audit append     │
       │ HTTP_PROXY env var       └──────────┬──────────┘
       │ set by `agentpass run`             │ encrypted reads only
       │                                    ▼
       │                          ┌─────────────────────┐
       │                          │  Encrypted Vault    │
       │                          │  AES-256-GCM        │
       │                          │  PBKDF2 100k iters  │
       │                          │  SQLite at-rest     │
       │                          │  ~/.agentpass/      │
       │                          └─────────────────────┘
```

### End-to-end request flow

1. **Setup** — `agentpass init` prompts for a master password, derives the KEK via PBKDF2-SHA256 with 100k iterations, generates a random DEK, encrypts the DEK with the KEK, and writes a fresh SQLite database at `~/.agentpass/vault.db`.
2. **Add a secret** — `agentpass add openai sk-proj-...` encrypts the secret value with AES-256-GCM under the DEK and stores the ciphertext + nonce in the `secrets` table. The plaintext is never persisted.
3. **Start the proxy** — `agentpass proxy start` opens a localhost HTTP server on port 8888 (configurable). The proxy holds the unlocked DEK in memory only for the lifetime of the process.
4. **Run the agent** — `agentpass run claude-code` sets `HTTP_PROXY=http://localhost:8888` and `HTTPS_PROXY=http://localhost:8888` in the child process environment, then execs the agent.
5. **Intercept** — when the agent issues a request, e.g. `Authorization: Bearer {{secret:openai}}`, the proxy parses the placeholder, queries the vault, substitutes the real value, and forwards to `api.openai.com`.
6. **Forward** — the proxy streams the response back to the agent unchanged. The agent process never sees the real key in any header, body, or environment variable it can introspect.
7. **Audit** — the proxy appends an immutable record to a local audit log: timestamp, destination host, secret name used, response status, byte counts. Secret values are never logged.

### Encryption and auth model

- **At rest:** SQLite database file encrypted via AES-256-GCM per-secret. Master password is the only thing the user types; it's converted to a KEK via PBKDF2-SHA256, 100,000 iterations, with a per-vault random salt.
- **In memory:** the unlocked DEK lives only inside the proxy process. The CLI does not cache it across invocations.
- **In transit:** the proxy speaks plaintext HTTP only on `localhost`. Outbound to the destination API is TLS as usual.
- **No telemetry on secret values, ever.** This is a product invariant — secret values cannot be transmitted to any AgentPass-owned endpoint, even for diagnostics.

### Placeholder substitution mechanic

The proxy scans only the headers it's been configured to scan — by default `Authorization`, `X-API-Key`, `Api-Key`, and any custom header listed in the vault metadata for that secret. The placeholder grammar is `{{secret:NAME}}` with optional `{{secret:NAME|fallback:NAME2}}` syntax for multi-key fallback. The proxy does NOT scan request bodies in V1 (avoids parsing JSON-streaming responses and breaking binary payloads).

### Key rotation and fallback

- **Rotation:** when a destination API returns 401 Unauthorized AND the vault has a marked-fresh replacement secret, the proxy retries the request with the new key. The agent sees a successful response. No agent-side retry logic required.
- **Multi-key fallback:** `agentpass add openai sk-... --pool openai-pool` adds the key to a pool. The proxy load-balances across the pool and auto-fails over on 429 (rate limit). Pools are first-class — the vault knows how to round-robin and what to do when all keys in the pool are exhausted.

---

## 4. Who it's for

Three personas, each with a real cohort and a real trigger event.

### Persona A — Claude Code Power User ("Priya")

- **Cohort:** Anthropic Claude Code users with 4+ wired-in MCP servers + 3+ LLM provider keys; estimated 50K–200K globally as of May 2026 (GitGuardian metric: Claude-Code-assisted commits leak secrets at 2× baseline).
- **Situation:** developer at a small startup, lives in Claude Code 6 hours/day, has a shell of agent loops that read GitHub, Linear, Sentry, Stripe, and write code. Six LLM keys in `.env`. Hits the OpenAI 429 rate limit twice a week.
- **Current workaround:** rotates keys manually when one hits 429; copies `.env` between machines via 1Password Secure Note; ignores the 3am bill emails.
- **Why current solutions fail:** 1Password Personal doesn't broker at runtime. Infisical Agent Vault is generic and the Claude Code shim is a TODO in their roadmap. `direnv` does env-var injection but not rotation.
- **Trigger event:** wakes up to a $400 OpenAI bill from an overnight loop; sees a tweet about AgentPass; installs in 90 seconds; runs `agentpass run claude` and her rate-limit problem disappears that morning.

### Persona B — Cursor + MCP Indie Builder ("Marco")

- **Cohort:** Cursor Pro users building MCP-integrated agents — Cursor has [>1M DAU](https://sacra.com/c/cursor/) and r/cursor has 77K members. We target the ~5–10% of those building serious MCP flows.
- **Situation:** solo builder shipping a SaaS, uses Cursor agent mode + Cline + custom MCP servers (GitHub MCP, Linear MCP, custom Stripe MCP). Stores keys in `.cursorrules` and shudders.
- **Current workaround:** keeps `.cursorrules` out of git, copies between machines manually, prays.
- **Why current solutions fail:** Cursor doesn't have native key isolation. Cline's [single-key abstraction](https://cline.bot/blog/one-api-key-for-claude-gemini-gpt-and-everything-else) only covers LLM providers, not MCP server tokens. Composio per-call billing wrong for "remember my Linear token forever."
- **Trigger event:** sees a GitHub Action of his fail with a leaked OpenAI key in the build log; AgentPass shows up in his next "secrets manager for AI" search; installs to fix it.

### Persona C — Two-to-Ten-Person AI-Native Startup Engineer ("Sara")

- **Cohort:** engineers at 2–10 person AI-native startups (Stripe Atlas + YC W26 batch points to ~5,000 such teams globally with serious agent infra). Estimated reachable in year 2: ~250 paying Teams accounts.
- **Situation:** founding eng at a 5-person AI startup. Their agents run in CI, in production, on dev laptops, and on a Render box. Keys are sprayed across `.env.production`, GitHub Actions secrets, Render env vars, and a shared 1Password vault.
- **Current workaround:** quarterly key rotation panic; "who has prod Stripe key?" Slack threads; one engineer always knows the breaking change before the others.
- **Why current solutions fail:** Doppler Team is $21/seat and SaaS-shaped (no runtime brokering). Infisical free tier is generic. HashiCorp Vault is enterprise overkill. 1Password Business doesn't broker at the wire.
- **Trigger event:** an intern accidentally commits `.env.production` to GitHub; the team migrates to AgentPass Teams in a week.

### Anti-personas (who we will refuse to sell to in year 1)

- **Enterprise CISO at a Fortune 500.** Wrong product. Sell them 1Password Unified Access or HashiCorp Vault. We do not have SOC 2 Type II.
- **Single-LLM hobbyist.** A dev with one OpenAI key in `.bashrc` should use `direnv` or 1Password Personal. AgentPass is overkill.
- **Security team buying SOC-2 vendors.** Sell them Doppler Enterprise. We are not on their procurement list and won't be in year 1.
- **No-code agent builder on Make/Zapier/n8n.** Their platform owns the secrets. We are not the right primitive.
- **Anyone who needs SAML, SCIM, or HSM in year 1.** Not our roadmap.

---

## 5. Platform value prop

Three promises. Each is structurally true and cannot be true of any one competitor simultaneously.

1. **Your agent never sees the raw key.** Proxy-substituted at the wire. No `process.env` exposure. No SDK call returns the value. Verifiable by snapshotting agent process memory.
2. **Works offline. No cloud account required.** The free tier is a single binary, local SQLite vault, localhost proxy. Personal Cloud is opt-in for sync. This is the structural advantage Infisical Agent Vault and 1Password cannot honestly match.
3. **Opinionated runtime DX.** First-class shims for Claude Code, Cursor, OpenClaw, Codex CLI. `agentpass run claude` does the right thing without configuration. `agentpass import-claude` auto-vaults keys already on disk. Generic mode exists but isn't the front door.

---

## 6. Jobs-to-be-done

Seven JTBDs. Each is a real trigger we can ground in 2026 evidence.

### JTBD 1 — "Stop my agent from seeing my OpenAI key in clear text"

- **Trigger:** read [Devin secrets-exfil writeup](https://embracethered.com/blog/posts/2025/devin-can-leak-your-secrets/) or [Claude Code source-map leak](https://www.zscaler.com/blogs/security-research/anthropic-claude-code-leak); felt the chill.
- **Current cost:** rotate the key after every public deploy; hope nothing got logged; pay for GitGuardian Pro.
- **AgentPass outcome:** key lives in vault; agent gets a placeholder; the leak surface goes from raw-key-in-process to opaque-token-with-no-side-channel.
- **Proof:** demo snapshot of process memory showing only the placeholder.

### JTBD 2 — "Handle key rotation without breaking my agent loop"

- **Trigger:** OpenAI rotates the key; three running agents fail at 2am; the dev wakes up.
- **Current cost:** manual restart of each agent; 30-minute downtime per rotation.
- **AgentPass outcome:** `agentpass rotate openai sk-new-...` updates the vault; in-flight requests auto-retry against the new key.
- **Proof:** repro the failure scenario, swap the key mid-flight, agent stays green.

### JTBD 3 — "Multiplex N OpenAI keys to dodge rate limits"

- **Trigger:** hit OpenAI's tier-3 rate limit during a batch job; agent stalls.
- **Current cost:** waste 30 minutes wiring `ngrok ai-gateway` or rolling a custom round-robin.
- **AgentPass outcome:** `agentpass pool openai sk-1 sk-2 sk-3`; the proxy load-balances and fails over on 429.
- **Proof:** synthetic 429 test; pool exhausts; clear error to agent only when all keys are dead.

### JTBD 4 — "Share an agent project with a teammate without leaking my keys"

- **Trigger:** clones a teammate's repo and gets a Slack DM saying "oh wait, that has my Anthropic key in `.env`."
- **Current cost:** force-push to remove the key; rotate; awkward Slack apology.
- **AgentPass outcome:** the repo ships with `{{secret:anthropic}}` placeholders. Teammate has their own vault; placeholders resolve to their own keys. No secret crosses the wire.
- **Proof:** clone, run, work — without ever copying a key.

### JTBD 5 — "Know which agent burned my OpenAI quota at 3am"

- **Trigger:** wake up to a $400 bill from an overnight loop ([the real $4,200 / 63 hours postmortem](https://medium.com/@sattyamjain96/the-agent-that-burned-4-200-in-63-hours-a-production-ai-postmortem-d38fd9586a85)).
- **Current cost:** spelunk OpenAI dashboard; correlate with local agent logs; rough guess.
- **AgentPass outcome:** `agentpass audit` shows every request made via any agent in the last 30 days, grouped by destination host and time. Spend attribution becomes a SQL query.
- **Proof:** demo audit log with request volume curves per agent.

### JTBD 6 — "Onboard a teammate to my agent setup in <5 minutes"

- **Trigger:** new hire joins; needs the same six MCP servers + four LLM keys configured.
- **Current cost:** 1Password vault share + manual `.env` setup + Slack DM chain; takes 90 minutes.
- **AgentPass outcome (Teams tier):** `agentpass team join $invite_token` provisions the shared vault read-only; new hire installs, runs, works.
- **Proof:** stopwatch demo from clean machine to first proxied agent call.

### JTBD 7 — "Audit-log every API call my agents make for compliance"

- **Trigger:** EU AI Act 2026-08-02 obligations live; legal asks "show me your AI vendor access logs"; CTO asks "do we have any?"
- **Current cost:** no good answer; cobble together CloudTrail + provider logs.
- **AgentPass outcome (Observability tier, V2):** every agent HTTP call routed through AgentPass logged with destination, secret used, response status, byte counts, and (optionally) request fingerprint. Exportable as JSONL for SIEM ingestion.
- **Proof:** export 30 days of audit; show diff of "which agent talked to Stripe vs only OpenAI."

---

## 7. User expectations (the bars we promise)

Explicit service-level promises the product must meet from V1. Bars below kill adoption regardless of feature parity.

| Bar | Target | Why this number |
|---|---|---|
| Proxy added-latency | <50ms p99 per request | Anything above 100ms breaks streaming agent UX. Test with a `time curl` against `api.openai.com` proxied vs direct. |
| Cold start (binary launch → first request servable) | <500ms | A dev who runs `agentpass run claude` waits ~no perceivable time. |
| Vault unlock (password → DEK in memory) | <200ms on M1+ | PBKDF2 100k iters is ~80ms on M1; budget for I/O and prompt. |
| Memory footprint | <50MB resident | Single dev laptop runs Cursor + Claude Code + AgentPass simultaneously. |
| Binary size | <15MB compiled | Bun `--compile` output should be small enough to ship via Homebrew without grumbling. |
| Telemetry on secret values | Zero. Ever. | Invariant. Will not be relaxed. Code-enforced (no network calls from the vault module). |
| Telemetry on usage (opt-in) | Anonymous counts only | Off by default. Opt-in via `agentpass telemetry on`. Reports installs + command counts only. |
| Audit log retention (local) | 90 days default, configurable | SQLite same file; rotated weekly. |
| Restoration of vault from password | Always succeeds if password is correct | Vault file is portable; no machine-binding. |
| Offline operation | 100% of free tier features | Free tier never makes outbound calls except to the destinations the agent itself calls. |

---

## 8. User flows

Text walkthroughs for the eight critical journeys. ASCII screens for each follow in §9.

### Flow A — Install + first proxied call (90-second target)

1. `brew install agentpass` (or `curl -fsSL agentpass.dev/install.sh | sh`)
2. `agentpass init` — prompted for master password; vault created at `~/.agentpass/vault.db`.
3. `agentpass add openai sk-proj-...` — secret stored encrypted.
4. `agentpass run -- curl https://api.openai.com/v1/models -H "Authorization: Bearer {{secret:openai}}"` — proxy starts ephemerally; request goes out with real key; response returns; proxy stops.
5. Success.

### Flow B — First agent run with Claude Code

1. Install + init (Flow A steps 1–2).
2. `agentpass import-claude` — auto-detects `~/.claude/settings.json` and `.claude/env`, imports the existing Anthropic key, replaces it on disk with `{{secret:claude}}`.
3. `agentpass run claude` — opens Claude Code with proxy env vars set.
4. Claude Code makes its first API call; AgentPass logs it.
5. `agentpass audit --since 1m` shows the call.

### Flow C — Key rotation

1. OpenAI rotates the key out-of-band; you receive `sk-proj-newkey-...`.
2. `agentpass rotate openai sk-proj-newkey-...` — vault updates; in-flight retries against new key on next 401.
3. Agent continues running. No agent-side restart.

### Flow D — Multi-key fallback pool

1. `agentpass pool openai sk-1 sk-2 sk-3 --strategy round-robin --fallback-on 429,503`
2. Agent issues 100 requests; proxy distributes evenly. One key hits 429; proxy excludes it from the rotation for 60s.
3. `agentpass pool status openai` shows current health per key.

### Flow E — Sharing a repo with a teammate

1. You commit code that uses `{{secret:openai}}` in your client config — no actual key in the repo.
2. Teammate clones the repo.
3. Teammate runs `agentpass init` + `agentpass add openai $THEIR_KEY`.
4. Teammate runs `agentpass run -- ./your-script.sh` — placeholders resolve against teammate's vault.
5. No key crosses any wire either of you don't control.

### Flow F — Audit + spend triage

1. Bill from OpenAI is $400 higher than expected for the month.
2. `agentpass audit --destination api.openai.com --group-by hour --since 30d` shows request volume curves.
3. Identify the 3am spike; the audit log shows the agent name + secret used.
4. Disable that agent's key in the pool until you fix the loop.

### Flow G — Multi-device with Personal Cloud (V1.5)

1. On Machine A: `agentpass cloud login` — magic-link auth via Clerk.
2. `agentpass cloud sync enable` — vault encrypts with a new device-bound key, ciphertext blob ships to R2; metadata in D1.
3. On Machine B: install + `agentpass cloud login` + `agentpass cloud sync pull` — vault appears with the same secrets.
4. Master password is required on each device; the cloud never has plaintext.

### Flow H — Onboarding a teammate (Teams tier, V2)

1. Owner: `agentpass team create $team_name` (during Teams subscribe flow).
2. Owner: `agentpass team invite teammate@example.com --role member --scope "openai/*,anthropic/*"`.
3. Teammate gets a magic-link email.
4. Teammate: `brew install agentpass && agentpass team join $invite_token` — local vault created, scoped read-only access to team secrets.
5. Teammate: `agentpass run claude` — works.

---

## 9. UI / UX screens

### CLI screens (V1, working today or shipped within 30 days)

**Screen 1 — `agentpass init` (first run)**

```
$ agentpass init
AgentPass — local credential broker for AI agents.

Create a master password (used to encrypt your vault):
> ****************
Confirm:
> ****************

Generating encryption keys (PBKDF2-SHA256, 100k iters)... done.
Vault created at ~/.agentpass/vault.db
Vault size: 8.0 KB

Next:
  agentpass add openai sk-proj-...
  agentpass import-claude     # auto-import Claude Code keys
  agentpass proxy start       # start localhost proxy

Tip: lock your vault with `agentpass lock`. Unlock on demand.
```

**Screen 2 — `agentpass list`**

```
$ agentpass list
NAME           TYPE        ADDED        LAST USED      POOL
anthropic      bearer      2d ago       12m ago        -
openai         bearer      2d ago       3s ago         openai-pool
openai-backup  bearer      1d ago       never          openai-pool
github         api_key     5h ago       1h ago         -
linear         bearer      5h ago       never          -
stripe         bearer      2h ago       never          -

6 secrets · 1 pool (openai-pool: 2 keys, 0 disabled)
Vault: unlocked · Proxy: running on :8888
```

**Screen 3 — `agentpass status`**

```
$ agentpass status
Vault          ~/.agentpass/vault.db (12 KB)
Lock state     UNLOCKED (auto-lock in 47m)
Secrets        6
Pools          1
Proxy          RUNNING on http://localhost:8888 (PID 41281)
Audit log      ~/.agentpass/audit.db (2.4 MB, 1,847 entries, last 30d)
Cloud sync     OFF (free tier)

Recent activity (last 5m):
  10:42:18  api.openai.com         openai-pool[sk-…aB2]    200  1.2s
  10:42:11  api.anthropic.com      anthropic               200  0.8s
  10:41:55  api.github.com         github                  200  0.1s
  10:41:33  api.openai.com         openai-pool[sk-…7Xz]    429  retried
  10:41:34  api.openai.com         openai-pool[sk-…aB2]    200  1.4s
```

**Screen 4 — `agentpass audit`**

```
$ agentpass audit --since 1h --destination api.openai.com
DEST                 COUNT   p50     p99     ERR    SECRET
api.openai.com       128     1.1s    3.4s    2.3%   openai-pool
                                                    ├ sk-…aB2 (67%)
                                                    ├ sk-…7Xz (23%)
                                                    └ sk-…9mN (10%)

Errors:
  3x  401 Unauthorized (sk-…9mN, auto-rotated)
  1x  429 Rate Limit (sk-…7Xz, fell back to sk-…aB2)
```

**Screen 5 — `agentpass run claude` (success)**

```
$ agentpass run claude
[agentpass] Vault unlocked (47m until auto-lock).
[agentpass] Proxy started on :8888 (will stop when claude exits).
[agentpass] HTTP_PROXY=http://localhost:8888 HTTPS_PROXY=http://localhost:8888

> Claude Code 0.4.7
> Workspace: /Users/rakesh/code/audiopod
> ...
```

**Screen 6 — `agentpass init` (error: vault exists)**

```
$ agentpass init
Error: vault already exists at ~/.agentpass/vault.db

Choose:
  agentpass unlock    # open existing vault
  agentpass init --vault ~/.agentpass/work.db    # create a new named vault
  agentpass init --force --backup    # overwrite, backing up the existing vault

Need help? https://agentpass.dev/docs/multi-vault
```

**Screen 7 — `agentpass add` (validation error)**

```
$ agentpass add openai abcd1234
Warning: 'abcd1234' does not match the expected OpenAI key format (sk-proj-*, sk-*).

Continue anyway? [y/N] n
Aborted. Run `agentpass add openai sk-... --no-validate` to skip checks.
```

**Screen 8 — `agentpass proxy start` (port in use)**

```
$ agentpass proxy start
Port 8888 is in use (PID 41280, command: agentpass).
Use --port to choose another port: agentpass proxy start --port 8889
Or: agentpass proxy stop && agentpass proxy start
```

### Future cloud console wireframes (V1.5 / V2, ASCII only)

**Screen 9 — Cloud login page (V1.5)**

```
┌──────────────────────────────────────────────────────────────────┐
│  AgentPass                                          [Docs] [GitHub]│
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│              Sign in to AgentPass Cloud                           │
│                                                                    │
│              ┌──────────────────────────────────┐                 │
│              │ you@example.com                  │                 │
│              └──────────────────────────────────┘                 │
│                                                                    │
│              [   Send magic link   ]                              │
│                                                                    │
│              or [Continue with GitHub]                            │
│                                                                    │
│              Free tier? Stay local — no signup needed.            │
│              ↓                                                     │
│              brew install agentpass                                │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

**Screen 10 — Cloud vault overview (V1.5)**

```
┌──────────────────────────────────────────────────────────────────┐
│  AgentPass        Personal   Teams   Audit   Settings   rakesh@  │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Personal Vault                                                    │
│  ────────────────────────────────────────────────────────────     │
│  Synced 4m ago from mac-rakesh                                    │
│                                                                    │
│  NAME            TYPE     LAST USED      DEVICES                  │
│  anthropic       bearer   12m ago        mac-rakesh, mbp-work     │
│  openai          bearer    3s ago        mac-rakesh, mbp-work     │
│  openai-backup   bearer   never          mac-rakesh               │
│  github          apikey    1h ago        mac-rakesh, mbp-work     │
│  linear          bearer   never          mac-rakesh               │
│  stripe          bearer   never          mac-rakesh               │
│                                                                    │
│  6 secrets · 2 devices · last sync 4m ago                         │
│                                                                    │
│  [+ Add secret]  [↻ Sync now]  [⚙ Sync settings]                  │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

**Screen 11 — Audit log (Observability tier, V2)**

```
┌──────────────────────────────────────────────────────────────────┐
│  AgentPass        Personal   Teams   Audit   Settings   rakesh@  │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Audit · Last 30 days · Filter: [agent: claude-code] [secret: *]  │
│                                                                    │
│  Spend per agent ───────────────────────────────────────────      │
│      claude-code  ████████████████████████ $342.18                │
│      cursor       ██████████ $124.07                              │
│      cline        ███ $38.42                                      │
│      custom-mcp   █ $9.13                                         │
│                                                                    │
│  Request volume ────────────────────────────────────────────      │
│    │                                ▆                              │
│    │                                █                              │
│    │      ▂      ▃                  █                ▂            │
│    │   ▁▁ █▁  ▂▁ █▁ ▁▂  ▁    ▁▁ ▁  █▁  ▁ ▂▁ ▁  ▂▁ ▁ █  ▁         │
│    └─────────────────────────────────────────────────────         │
│       May 1                                          May 23        │
│                                                                    │
│  Anomalies (3) ─────────────────────────────────────────────      │
│  ⚠  May 18 03:14  claude-code · 14,200 req in 6h to api.openai    │
│  ⚠  May 12 09:03  custom-mcp · 401 burst (1,200 in 5m)            │
│  ℹ  May  9 22:11  cursor · new destination api.linear.app         │
│                                                                    │
│  [Export JSONL]  [Configure alerts]                                │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

**Screen 12 — Teams console (V2)**

```
┌──────────────────────────────────────────────────────────────────┐
│  AgentPass        Personal   Teams   Audit   Settings   rakesh@  │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Team: AudioPod                                                    │
│  Plan: Teams · 3 of 5 seats used · billing@audiopod.ai            │
│                                                                    │
│  Members ────────────────────────────────────────────────────     │
│  rakesh@audiopod.ai      owner    last active 2m ago              │
│  arjun@audiopod.ai       admin    last active 14h ago             │
│  meera@audiopod.ai       member   last active 3d ago              │
│                                                                    │
│  Team Secrets ──────────────────────────────────────────────      │
│  NAME              SCOPE        OWNER     ROTATED      DEVICES    │
│  prod-openai       prod-only    rakesh    7d ago       3          │
│  prod-anthropic    prod-only    rakesh    7d ago       3          │
│  stripe-test       dev-only     arjun     never        2          │
│  ...                                                               │
│                                                                    │
│  [+ Invite member]  [+ Add team secret]  [📋 Audit]                │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## 10. User journey mapping

Five stages. Each has an entry event, the desired action, the friction we must remove, and the failure mode if we don't.

### Stage 1 — Acquisition (Stranger → Aware)

- **Entry:** dev sees an X thread / Show HN post / blog headline / r/ClaudeAI comment / MCP server README link about AgentPass.
- **Desired action:** click through to `agentpass.dev`; read the one-paragraph what-it-is.
- **Friction to remove:** landing page that explains "what + why" in <15 seconds, with a single CTA (`brew install agentpass` or "Star on GitHub").
- **Failure mode:** marketing page reads like a SaaS deck; dev bounces.

### Stage 2 — Activation (Aware → First Proxied Call)

- **Entry:** dev runs `brew install agentpass`.
- **Desired action:** complete Flow A — first successful proxied call within 90 seconds.
- **Friction to remove:** init prompt has good defaults; `import-claude` works on first try; error messages are actionable (Screens 6–8).
- **Failure mode:** `agentpass init` fails on a permission error and dev gives up. Mitigation: error message says "Run `agentpass init --dir ~/somewhere-else` if you don't have write access to `~/.agentpass/`."
- **Activation metric:** time from `brew install` to first 200 OK from any destination via proxy. **Target: <5 minutes p95.**

### Stage 3 — Habit (First Call → Daily Use)

- **Entry:** dev has run AgentPass once and it worked.
- **Desired action:** wire it into Claude Code / Cursor / agent loops permanently within 7 days.
- **Friction to remove:** `agentpass run claude` should be a one-liner; the dev should not have to read 4 docs to get there.
- **Failure mode:** dev uses AgentPass for the demo, then unsets `HTTP_PROXY` and goes back to raw `.env`. Mitigation: shell hint on first successful run — "Want this in every Claude Code session? Run `agentpass shell-init >> ~/.zshrc`."
- **Habit metric:** ≥3 agent runs/week, ≥2 different runtimes wired in, ≥7 distinct secrets in the vault. **Target: 30% of activated users hit this by day 14.**

### Stage 4 — Expansion (Daily Use → Paying)

- **Entry:** dev has habit and a problem the free tier doesn't solve (multi-device sync, team-sharing, audit-log retention >90d, observability).
- **Desired action:** upgrade to Personal Cloud ($7/mo) or Teams ($19/seat/mo).
- **Friction to remove:** in-CLI upgrade nudges at the moment of friction ("You're configuring AgentPass on a new machine. Sync your vault across devices for $7/mo: `agentpass cloud signup`"). One-click checkout via Stripe.
- **Failure mode:** dev never sees the upgrade prompt because we never figure out the right friction-moment.
- **Expansion metric:** 5–10% of habit-stage users convert to Personal Cloud within 60 days; 1–2% of those convert to Teams within 90 days.

### Stage 5 — Advocacy (Paying → Referrer)

- **Entry:** dev has been paying for ≥2 months and AgentPass has prevented at least one rotation pain / leak.
- **Desired action:** GitHub star + tweet + blog mention + MCP-server-README link.
- **Friction to remove:** in-product prompt after a "save event" (a 401 auto-rotation that kept their agent running): "AgentPass just auto-rotated your OpenAI key. Tell other devs?" + share button.
- **Failure mode:** the product silently does its job and never asks for credit. Mitigation: ship a quarterly "your AgentPass year in review" email with stats they can share (e.g., "AgentPass handled 12,400 requests for you this quarter, including 47 auto-rotations").
- **Advocacy metric:** referral-driven installs >25% of monthly new installs by month 6.

---

## 11. Out of scope for V1 (deferred)

- Windows native binary (V2; WSL works in V1).
- Linux server / daemon mode (V1.5).
- WebSocket auth (V1; pattern is real, just not P0).
- MCP outbound brokering (V1; specific MCP-server-side patterns).
- Agent bootstrapping (V2 long-shot — the agent itself signs up for new accounts and the credential is captured at first use).
- HSM integration / BYOK (Enterprise tier, V3+).
- SAML, SCIM, SOC 2 Type II (Enterprise tier, V3+).
- Browser extension (no plan to ship).
- Mobile vault (no plan to ship).

---

## 12. References

All claims in this document trace back to the source list in `STRATEGY.md` §2 (Market diagnosis) and §7 (Tailwinds and headwinds). Pricing comparisons in §4 (Anti-personas and current solutions) match the anchors in `GTM.md` §7 (Pricing).
