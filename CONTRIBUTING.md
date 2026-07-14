# Contributing to AgentPass

Welcome! This guide covers what you need to get productive on AgentPass —
whether you're an intern starting today or a contributor opening your first
PR.

## 1. Prerequisites

- **Bun 1.3 or newer** — the project is Bun-native, not Node. Install from
  <https://bun.sh>. (`bun --version` to confirm.)
- **Git** with SSH or HTTPS access to GitHub.
- **macOS or Linux.** Windows is not supported today.

Optional, for working on the marketing site (`apps/web`):

- **Wrangler** (`bun add -g wrangler`) — only needed if you're deploying to
  Cloudflare Workers locally.

## 2. First-time setup

```bash
git clone https://github.com/Rakesh1002/agentpass.git
cd agentpass
bun install
bun test           # all tests should pass
bun run typecheck  # tsc --noEmit
```

If `bun test` fails on a clean checkout, that's a bug — open an issue or
ping in the team chat before you touch anything else.

## 3. Project tour

The CLI is intentionally small. Read these in order on your first day:

1. **`src/cli.ts`** — command dispatcher. Every `agentpass <subcommand>`
   lands in `handleX(args)` here.
2. **`src/vault.ts`** — SQLite-backed encrypted store. Uses Web Crypto
   (`crypto.subtle`) for AES-GCM. PBKDF2 derives the encryption key from the
   master password.
3. **`src/proxy.ts`** — the HTTP/HTTPS proxy. Three paths: `handleRequest`
   (direct HTTP, where we substitute placeholders), `handleForwardProxy`
   (absolute-URL forward proxy), and `handleConnect` (HTTPS CONNECT MITM
   — terminates TLS with a local CA cert, rewrites credential headers, then
   re-encrypts to the real upstream).
4. **`src/providers.ts`** — upstream provider routing table.
5. **`src/ca.ts`** — local certificate authority. Mints per-host TLS
   certificates signed by the local CA; used actively by the HTTPS MITM
   engine in `handleConnect`. Includes an in-memory cert cache so disk I/O
   only happens once per hostname per process lifetime.
6. **`src/agentpass.test.ts`** and **`src/proxy.test.ts`** — read the tests
   before changing the code they cover.

Everything outside `src/` is either the marketing site (`apps/web`), the
static landing page (`public/`), or top-level docs.

## 4. Development workflow

### Branches

- The trunk is `main`. Never commit to it directly.
- Branch naming: `<github-username>/<short-topic>`, e.g.
  `arjun/audit-log-rotation`.

### Running things locally

```bash
# Run the CLI without installing
bun run src/cli.ts <command>

# Watch tests
bun test --watch

# Typecheck (CI runs this)
bun run typecheck

# Start the marketing site
cd apps/web && bun install && bun run dev
```

The CLI writes to `~/.agentpass/` by default. Tests use a temp directory via
the `AGENTPASS_HOME` environment variable so they never touch your real
vault.

### Tests

We use Bun's built-in test runner. New code needs a test if it:

- Touches the vault (encryption, key derivation, persistence).
- Routes or substitutes a request in `proxy.ts`.
- Mints or validates a certificate in `ca.ts`.
- Adds a new provider to `providers.ts`.

If you're fixing a bug, write a failing test first, then fix it.

## 5. Commit + PR conventions

- **Imperative subject** under ~70 characters. e.g.
  `Add retry on 429 for OpenAI` (good), `fixed bug` (bad).
- One logical change per commit. If your PR has three unrelated fixes,
  split it.
- The PR description should answer two questions: *what changed* and *why*.
  If your change touches behavior interns will see in the CLI, include
  a sample command-line transcript.
- Run `bun test` and `bun run typecheck` before pushing. CI will reject
  anything red.
- Never commit:
  - real API keys (even your own throwaway ones — use placeholders like
    `sk-test` in tests)
  - a populated `~/.agentpass/vault.db`
  - `.env` files (use `.env.example` if you need to document an env var)

## 6. Security checklist (every PR)

Before you mark a PR ready for review:

- [ ] No real secrets in code, tests, or fixtures.
- [ ] No `console.log` of decrypted secret values, even in error paths.
- [ ] The audit log records secret *names*, never values.
- [ ] If you added a new header to scan in `proxy.ts`, document why.
- [ ] If you touched `ca.ts` or trust-store handling, flag it explicitly in
      the PR description — that code path is security-critical.

## 7. Known issues / good first projects

These are tracked technical debts. Pick one as a starter task if you're
looking for something real to work on:

- **No cooldown tracking on rate-limited keys.** The provider-routed
  proxy falls over to the next key on 429 within a single request, but
  it does not remember which key cooled down across requests. A short
  in-memory cooldown table (per provider, per key) would make sequential
  requests skip a cooling-down key without re-incurring its 429.
- **Streaming responses are buffered.** `sendUpstream` collects the
  upstream response body into a `Buffer` before forwarding. Fine for
  models endpoints; not fine for SSE / chat-completions streaming.
  Switch to streaming once a streaming-safe retry strategy is decided
  (you can't retry mid-stream).
- **`agentpass import-claude` is best-effort.** It assumes a specific
  Claude Code config layout; revisit when the upstream layout changes.

## 8. Where to ask for help

- Code questions: drop a comment in your PR or open a draft PR early.
- Product / scope questions: ask before you build. We'd rather rescope
  upfront than rewrite a 400-line PR.
- Security concerns: do **not** open a public issue. Email or DM the
  maintainer directly.

Welcome aboard.
