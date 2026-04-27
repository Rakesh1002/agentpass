# AgentPass — Venture Strategy Memo

**Pitch as given:** Credential manager for AI agents — API keys, passwords, secrets so they can keep working without any hiccups.
**Audience:** Rakesh (solo founder, 30-venture portfolio, profitable AudioPod, Bangalore).
**Date:** 2026-04-27.
**Verdict (so you can stop reading if you want):** **KILL the pitch as written.** A narrow re-pitch in §5 has a 25–30% chance. The broad pitch has a 5% chance.

---

## Phase 0 — Stop-the-clock: why I'm calling this early

The literal pitch — "vault that holds API keys, passwords, secrets for AI agents" — was shipped, in production, by four well-funded incumbents and three open-source projects in the last 90 days. Specifically:

- **1Password** launched **Unified Access** on **2026-03-17** with Anthropic, Cursor, GitHub, Perplexity, and Vercel as launch partners. Discovers exposed `.env`, SSH keys, and long-lived tokens; centralises them; will issue scoped credentials at runtime "later in 2026." ([1Password press release](https://1password.com/press/2026/mar/1password-unified-access))
- **Infisical** open-sourced **Agent Vault** — a credential-injecting HTTP proxy with the exact architecture you'd build (agents get placeholder keys, proxy substitutes the real ones at the network layer). It's free. ([Infisical / GitHub](https://github.com/Infisical/agent-vault), [Show HN](https://news.ycombinator.com/item?id=47865822))
- **Composio** ($29M, Lightspeed-backed): 850+ pre-built connectors with a token-brokering vault baked in. Free tier is 20K tool calls/mo, paid starts at $29/mo. ([Composio pricing](https://composio.dev/pricing), [Extruct funding profile](https://www.extruct.ai/hub/composio-dev/))
- **Arcade.dev** ($12M seed, March 2025, Laude Ventures): "MCP runtime for production AI agents" — auth+tools+governance bundled. ([Arcade funding](https://www.businesswire.com/news/home/20250318815130/en/))
- **HashiCorp Vault** is now IBM-owned (Feb 2025, $6.4B); Vault 2.0 shipped in 2026 with the Vault MCP server beta. ([InfoQ](https://www.infoq.com/news/2026/04/vault-2-0-ibm-identity/))
- Two more **Show HN credential proxies in 2025–26**: OneCLI (Rust) and AgentSecrets — same architecture, free.

When the headline feature has been shipped by the top three incumbents in the last 90 days, my standing kill rule fires. You wrote that rule yourself. I'm going to honour it, then see if there's a narrower wedge worth re-pitching.

---

## Phase 1 — Snapshot (the partner memo)

AgentPass wants to be the secrets/credentials layer between AI agents and the APIs they call. The thesis is that agents are non-deterministic, prompt-injection-prone, and leak secrets at industrial scale (GitGuardian: 28.6M secrets exposed on public GitHub in 2025, +34% YoY — [Help Net Security](https://www.helpnetsecurity.com/2026/04/14/gitguardian-ai-agents-credentials-leak/)). The product is, at minimum, an encrypted vault + a brokering proxy that injects creds into agent HTTP traffic so the agent process never holds them. At maximum, it grows into agent identity + scoped runtime auth + audit trail.

Stage: greenfield (empty repo, 2026-04-07). No customers, no MVP, no landing page. The category around it is in late seed / Series-A consolidation. The buyer profile (security-conscious dev team) is already buying 1Password, Doppler, Infisical, Composio, or HashiCorp. The wedge requires either an underserved segment those buyers don't reach, or a structural advantage you can hold for 12+ months. As pitched, neither is present.

---

## Phase 2 — Market diagnosis

### TAM / SAM / SOM (bottoms-up, not the analyst-deck $38B)

The "Non-Human Identity Access Management" reports throw $11.3B (2025) → $38.8B (2036) at 12.2% CAGR ([GlobeNewswire / Meticulous](https://www.globenewswire.com/news-release/2026/04/22/3279125/0/en/Non-Human-Identity-Access-Management-Market-Global-Forecast-Report-2026-2036.html)). Ignore that — those numbers count every machine identity (service accounts, IoT, K8s tokens, RPA), not the slice you'd actually own. Bottoms-up:

- **Sized by competitor revenue (proxy for spend that exists today):** Composio is reportedly at <$10M ARR with 850+ connectors and a free tier converting at indie-pricing ($29–229/mo). Doppler claims 16K customers serving 1.5B secrets/mo (2022 data, [SiliconANGLE](https://siliconangle.com/2022/04/27/)) — at a guess $30–60M ARR. Arcade.dev has 29 employees post-seed ([Tracxn](https://tracxn.com/d/companies/arcade/__wcClSaNlV_83fCQ_eaLxJCUM8WuOtHQX28FYfKTH8B0)) — under $5M ARR. **Visible spend on agent-specific credential tooling today: ~$50–100M global, growing 3–4x/yr.**
- **SAM you could realistically reach as a solo founder:** the long-tail of indie devs and 1–10 person teams building MCP-native agents who refuse to lock into 1Password Enterprise or HashiCorp. Cursor reportedly crossed 1M paying users in 2025; Claude Code is in similar territory. If 5% of those have agent-key management pain and 1% would pay $20/mo, that's **~5,000 customers × $240/yr = $1.2M ARR cap.** Below the $1.2M ARR ($100K MRR) goalpost — barely.
- **SOM for year 1:** 200–500 customers paying $15–30/mo if you nail an indie wedge. That's $3K–15K MRR realistic.

The honest read: **the slice you can win as a solo founder is ~$1–2M ARR, and it's contested.** Building to $100K MRR in this category requires either an enterprise pivot (which you're not equipped for) or a much narrower wedge.

### Tailwinds (concrete)

1. **MCP donated to the Linux Foundation's Agentic AI Foundation (AAIF) in Dec 2025.** Co-founders: Anthropic, Block, OpenAI. This makes MCP a multi-vendor standard, not an Anthropic project, which means MCP-related infra has a real future. ([Wikipedia: Model Context Protocol](https://en.wikipedia.org/wiki/Model_Context_Protocol))
2. **MCP 2025-06-18 spec mandates OAuth 2.1 for streamable HTTP transport.** Authentication is now a first-class part of the spec, not an afterthought. ([MCP spec](https://modelcontextprotocol.io/specification/2025-11-25), [Stack Overflow blog](https://stackoverflow.blog/2026/01/21/is-that-allowed-authentication-and-authorization-in-model-context-protocol/))
3. **Cloudflare Agents Week 2026 (Apr 13–17)** shipped Dynamic Workers (isolate sandboxes 100× faster than containers), Sandboxes GA, AI Search GA, expanded Workflows. ([Cloudflare blog recap](https://blog.cloudflare.com/agents-week-in-review/)) — runtime infra is cheaper and more available, *which is bad for you*: it lets every competitor ship the proxy version of this product in a weekend.
4. **GitGuardian's 2025 report**: 28.6M public-repo secret leaks, +34% YoY. Real, repeated, monetisable pain. ([Help Net Security](https://www.helpnetsecurity.com/2026/04/14/gitguardian-ai-agents-credentials-leak/))
5. **Recent breaches that prove the threat model is real:** Vercel breach via Context AI supply-chain attack (2026-04-19); infostealer malware targeting OpenClaw config files (Feb 2026). ([Hacker News](https://thehackernews.com/2026/02/infostealer-steals-openclaw-ai-agent.html))

### Headwinds (more concrete)

1. **1Password Unified Access (March 2026) is a category-extinction event for the consumer/prosumer slice.** It plugs into Cursor, GitHub, Vercel, Anthropic, Perplexity. If you're a developer, your org already uses 1Password for human creds; turning on Unified Access is a checkbox, not a buy decision.
2. **HashiCorp + IBM owns the enterprise.** Vault 2.0 ships agent dynamic secrets natively. Banks, fintechs, governments will not switch.
3. **Composio + Arcade + Nango are eating the integration layer.** Token brokering is a feature inside their broader "AI agent integration platform" pitch. They have $50M+ combined to give it away free at the bottom and upsell governance at the top.
4. **The "credential-injecting proxy" architecture has at least three open-source implementations** (Agent Vault, OneCLI, AgentSecrets) shipped as Show HN hits in 2025–26. Free, MIT-licensed, working. The HN comment thread on Agent Vault is itself a competitive moat — every smart objection has been raised and roadmapped.
5. **The buyer who pays is the one with compliance-driven pain (SOC 2, ISO 27001, DPDP, EU AI Act).** That buyer wants a vendor with an audit firm, a SOC 2 Type II report, and a sales engineer. You're none of those.

### Capital flows

- Composio: $29M Series A (Lightspeed, Together, Mar 2025).
- Arcade.dev: $12M seed (Laude, Mar 2025).
- Doppler: $28.9M cumulative; ISO 27001 cert Sep 2025; flat-ish growth signal.
- Infisical: well-funded; OSS-led; agent feature shipped 2026-Q1.
- HashiCorp: $6.4B exit to IBM (Feb 2025).
- 1Password: ~$6.8B last valuation; Unified Access launch Mar 2026.

This category is **overcapitalized at the top** and **commoditizing at the bottom** (3 free OSS proxies). The middle — which is where a solo founder has to live — is being squeezed.

### Regulatory / platform risk

- **MCP spec changes** can re-architect your product overnight. The spec moved from 2025-03 → 2025-06-18 → 2025-11-25 in 8 months. You'd be chasing it.
- **OpenAI / Anthropic / Cursor / Claude Code adding native vault features** kills your TAM. 1Password partnership with all five is the warning shot.
- **India DPDP Act Phase II (consent manager) goes live 2026-11-13; Phase III (full obligations) 2027-05-13.** Penalties up to ₹250 crore. ([IAPP](https://iapp.org/news/a/with-rules-finalized-india-s-dpdpa-takes-force)) This is *theoretically* a tailwind for credential governance — but the buyers under DPDP are large enterprises, not your reachable segment.

---

## Phase 3 — Competitive topology

```
                    BROAD (everything for everyone)         NARROW (one wedge)
                  ┌───────────────────────────────────┬─────────────────────────────┐
                  │  HashiCorp Vault (IBM)            │  Pomerium (zero-trust prxy) │
   INCUMBENTS     │  1Password Unified Access         │  Strata (identity fabric)   │
                  │  Doppler                          │  Pangea (AI security svcs)  │
                  │  Infisical                        │  Oso (authorization eng)    │
                  ├───────────────────────────────────┼─────────────────────────────┤
   UPSTARTS       │  Composio (850 connectors)        │  Arcade.dev (MCP runtime)   │
                  │  Nango (code-first integrations)  │  Agent Vault (OSS proxy)    │
                  │  Merge.dev (unified API)          │  OneCLI (Rust proxy)        │
                  │  Pipedream Connect                │  AgentSecrets (Show HN)     │
                  └───────────────────────────────────┴─────────────────────────────┘
```

There is no white space on this map. The "narrow upstart" quadrant — which is where you'd land — has four projects shipping the exact same architecture as your pitch.

### The three sharpest competitors and why you can't beat them on the broad pitch

**1Password Unified Access**
- *Strong:* distribution into every team that already uses 1Password (~150K business customers), launch partners are the exact tools indie devs use (Cursor, GitHub, Vercel, Anthropic, Perplexity).
- *Bleeds:* "later in 2026 will issue scoped credentials at runtime" — runtime token issuance not yet shipped; Unified Access is currently more discovery+vaulting than active brokering.
- *Why they can't fix it fast:* their core product is a consumer/SMB password manager; the enterprise agent runtime requires deep dev-tooling integrations they're now negotiating one-by-one. They'll get there in 12 months but Q3 2026 is genuine open ground.
- *What you could do:* go faster on the runtime brokering primitive, but only if you have a distribution channel they don't.

**Composio**
- *Strong:* 850 connectors is a real moat; Lightspeed funding; their content engine ([composio.dev/content](https://composio.dev/content)) is *eating SEO* in this category — half my Phase 0 search results were Composio articles.
- *Bleeds:* tool calls billed per-call ($29 → $229) is the wrong meter for "I want my agent to remember my Gmail token forever" — users want a flat sub or BYO-storage. The brokering pattern locks you into Composio's runtime.
- *Why they can't fix it:* their pricing model assumes you keep paying them per agent action; flipping to flat or self-hosted breaks the unit economics they pitched to Lightspeed.
- *What you could do:* ship "Composio's auth pattern, but flat-priced and self-hosted" — but Nango is already that, and Infisical Agent Vault is already free.

**Infisical (Agent Vault)**
- *Strong:* MIT-licensed, free, extends the dominant OSS secrets manager. Shipping the agent feature out of an existing 50K+ star project means distribution is solved on day 0.
- *Bleeds:* generic developer-tool focus; not optimized for any one agent runtime (Cursor, Claude Code, OpenClaw); HN comments flagged real gaps — token-refresh leakage, WebSocket support, MCP server outbound calls, agent-bootstrapping (where the agent itself signs up for new accounts).
- *Why they can't fix everything fast:* OSS roadmap is community-driven and they're optimising for enterprise upsell, not indie polish.
- *What you (a solo founder) could do that they structurally can't:* be opinionated about ONE runtime (e.g., "we are the credential broker for Claude Code / OpenClaw users") and ship runtime-specific magic. This is the only narrow re-pitch I'd entertain.

### Shape of rivalry

This is **not** a winner-take-most market. There's no network effect (your secrets are private; one user's vault doesn't enrich another's). There's no data moat. There's no marketplace dynamic. It's a **fragmented, commoditizing race to the bottom on the OSS side and a bundled-into-the-bigger-platform race at the top.** That is the worst possible market shape for a solo founder: low switching cost, low differentiation ceiling, well-funded competitors in both directions squeezing the middle.

---

## Phase 4 — Verdict: **KILL the broad pitch.**

Hits 4 of the 5 explicit kill criteria you wrote:

1. ❌ Top-3 incumbents shipped the headline feature in the last 90 days. (1Password Unified Access Mar 2026; Infisical Agent Vault Q1 2026; Vault 2.0 with MCP server Apr 2026.)
2. ❌ Distribution channel is dominated by platforms that can shut you out. (1Password owns the human-vault relationship; Anthropic/OpenAI can ship native MCP credential primitives; Cloudflare's Agents Week shipped half the runtime in one week.)
3. ❌ No unfair advantage beyond "I'll work harder." Your AudioPod audience is podcasters, not security-conscious devs. Your Bangalore base is a cost advantage but not a distribution one. You don't have a security brand.
4. ❌ Solo unfunded path to validation > 6 months. To match Composio's 850 connectors or 1Password's 5 launch partners would take ≥9 months alone.
5. ✅ Unit economics are technically OK at $20–50/mo prosumer pricing, but only if you can find buyers — and you can't, see #2.

**What I'd be willing to be wrong about:** I'd reverse to BUILD if (a) you have a personal distribution channel I don't know about into MCP/Cursor/Claude Code power-user communities, (b) you're willing to make this a 6-month time-box with a hard kill at month 6, and (c) you accept the narrow re-pitch in §5 instead of the broad "credential manager for AI agents."

---

## Phase 5 — The narrow re-pitch (only if you ignore the kill)

**"AgentPass = the local-first credential broker for power users running personal AI agents (Claude Code, Cursor, OpenClaw, Codex, custom MCP). One-line install, no cloud account required for the free tier, and it actually solves the four open problems Infisical's HN thread flagged: token-refresh leakage, WebSocket auth, MCP server outbound calls, agent-bootstrapping for new account creation."**

Wedge: be the **opinionated, runtime-specific** vault for the developer who already has Claude Code / Cursor / OpenClaw open right now and just got a Slack ping that their OpenAI key got rotated and three of their agents broke. Not enterprise. Not org-wide. *Personal*. Then expand to "AgentPass Teams" for 2–10 person AI-native startups when you have the user love.

Falsifiable in 6 months. If by month 6 you don't have:
- 500+ GitHub stars,
- 100+ active users on the local CLI,
- 25+ paying customers at $15–30/mo,
- and at least one of {Cursor, Claude Code, OpenClaw} mentioning AgentPass in their docs/community,

…you're wrong, the broad incumbents have eaten you, kill it and rotate the assets.

In 24 months if it works: $50–100K MRR with ~3K paying users at $20/mo + a Teams plan at $99/seat/mo for ~50 small teams. A nice business, not a venture-scale one. Acquirable by 1Password/Doppler/Infisical for talent + tech for $5–15M.

---

## Phase 6 — Path to $100K MRR (reverse-engineered, narrow re-pitch)

**Pricing model:** 1,000 customers × $100/mo. (Not 100×$1K — you can't sell mid-market as a solo. Not 10K×$10 — your CAC is too high for that volume.)

- **JTBD:** "I have 6 AI agents wired into my dev workflow and they keep breaking when keys rotate or hit rate limits, and my .env has 47 secrets in it that I'm scared of losing or leaking." Today they pay this with `.env` files + 1Password manual paste + private notes. Existing tool that does this *for them*: nothing clean — Composio exists but is per-call billed; Infisical Agent Vault is free but generic; 1Password is org-locked.
- **WTP anchor:** Composio Hobby $29/mo ([pricing](https://composio.dev/pricing)), 1Password personal $36/yr (so $3/mo), Doppler Developer free → Team $19/seat/mo. **A flat $29–49/mo for a personal AgentPass plan is defensible.** $99/seat/mo for Teams is in line with Doppler/Vercel.
- **CAC tolerance:** at $29/mo flat with 24-month LTV, LTV ≈ $696. Sustainable CAC is $50–80 for prosumer. That rules out paid ads (Google CPC for "AI agent" terms is $4–11). Channel must be organic.
- **Realistic monthly add rate:**
  - Months 1–3: 0 → 5/mo paying. Pre-launch, content-led.
  - Months 4–6: 5 → 25/mo. Post-Show HN + community traction.
  - Months 7–12: 25 → 60/mo. Compounding inbound.
  - This trajectory hits ~$15K MRR by month 12 if everything goes right. **$100K MRR is an 18–24 month target, not 12.** If your kill criterion is $100K in 12 months, KILL it now and don't start.

**Milestones with what-has-to-be-true:**

| Milestone | Month | What has to be true |
|---|---|---|
| 10 paying | 3 | Show HN landed in top 30; CLI works on Mac; Claude Code integration documented |
| 100 paying | 7 | Cursor or OpenClaw community knows the name; Teams plan launched |
| $10K MRR | 9 | ~350 prosumer + 5–8 Teams accounts |
| $50K MRR | 18 | 1.5K prosumer + ~30 Teams; first integration partnership signed |
| $100K MRR | 24 | 3K prosumer + 50–70 Teams; OR one design-partner enterprise at $5K/mo |

---

## Phase 7 — Roadmap

| COPY (table-stakes) | BUILD (the wedge) | INNOVATE (long-shot moat) |
|---|---|---|
| Encrypted local vault (sqlcipher / age) | **Runtime-specific shims** for Claude Code, Cursor, OpenClaw, Codex CLI: drop-in, no config | **Agent-bootstrap brokering**: when an agent says "sign me up for Stripe / Resend / OpenAI", AgentPass spins up the account, captures the key, never hands it to the agent |
| HTTP-injection proxy (placeholder→real key) | **WebSocket + MCP outbound** support (the gaps the Infisical HN thread flagged) | |
| `agentpass run <cmd>` wrapping | **Auto-rotation handling**: detects rotated keys, replays the request, no agent-side retry needed | |
| Audit log + secret scan of `.env`/`claude.json` | **Multi-key fallback for rate limits**: load-balance N OpenAI keys, auto-fallback on 429 | |
| Sync via Cloudflare D1 + R2 (encrypted) | **CLI-first UX**, `1Password CLI` muscle-memory for the Claude Code crowd | |

**Sequencing (hard scope, hard time):**

- **MVP (4 weeks):** local CLI + sqlcipher vault + HTTP proxy + Claude Code shim only. One config command. One demo video. Open-source MIT.
- **V1 (Week 5–10):** Cursor + OpenClaw shims, multi-key OpenAI fallback, WebSocket support, Show HN launch.
- **V2 (Week 11–18):** Cloud sync (D1/R2), Teams plan with seat-based billing, MCP outbound brokering, agent-bootstrap demo.

If you can't ship MVP in 4 weeks solo, this is the wrong venture.

---

## Phase 8 — Stack

Map to your defaults:

- **Local CLI**: Bun + TypeScript, single binary via `bun build --compile`. SQLite via `bun:sqlite`. SQLCipher for at-rest encryption.
- **Proxy**: Bun HTTP server, mitmproxy-style cert installation handled by `mkcert` invocation.
- **Cloud sync (V2)**: **Cloudflare Workers + D1 + R2**. D1 for metadata, R2 for encrypted blob, Workers KV for ephemeral session tokens. Agents Week 2026 just shipped Dynamic Workers + Sandboxes GA — you do not need GPU and you do not need Modal.
- **Auth**: Clerk for user accounts on the cloud-sync tier. Skip Razorpay for now (your buyer is global; Stripe-only is fine).
- **Billing**: Stripe. Add Razorpay only if you discover Indian dev demand at month 6.
- **MCP integration**: build native MCP server so Claude Code / Cursor users `npx agentpass-mcp` and immediately get vault tools exposed.

**Where defaults DON'T fit:**
- **No frontier API needed.** Don't use Claude/GPT for product features — this is an infra tool, not a content tool. AI in the product = "scan my .env for likely secret patterns" (regex + heuristics, not LLM).
- **No Postgres / PlanetScale needed.** D1 is fine for ≤10K users; if you need to migrate at $50K MRR, that's a happy problem.
- **No Sentry until V1.** Use OpenTelemetry → Cloudflare Workers Logs.

**Most likely thing to break at scale:** the proxy's MITM cert handling on Windows + corporate VPN environments. Swap-out: ship a Tailscale-style userspace network shim (gVisor / wireguard-go) instead of MITM at month 9 if it's biting.

---

## Phase 9 — Distribution & GTM

This is where the venture actually lives or dies. Don't skim.

### Top 3 channels (ranked, solo-founder-realistic)

1. **Show HN + r/LocalLLaMA + r/ClaudeAI launches.** Time-to-first-customer: 24h post-launch. CAC: $0. Tactic: ship MVP with a 90-second demo (Claude Code, key rotates, AgentPass auto-recovers, agent never sees the key). Leading indicator at 30 days: ≥250 GitHub stars, ≥30 signups on the cloud waitlist.
2. **Long-form posts on the four open Agent-Vault HN problems.** Title example: "Why your AI agent's WebSocket auth is leaking — and the proxy fix." Publish on your own blog + cross-post to dev.to + share on X. SEO/AEO target: when devs Google "agent credential proxy WebSocket" or "AI agent token refresh leak", AgentPass is the top result. This *is* your moat against Composio's content engine — pick fights with named problems they've ignored. Cadence: 1 long post/week for 12 weeks.
3. **Direct outreach to MCP server authors.** There are ~200 maintained MCP servers on GitHub. DM the top 30 maintainers offering a 1-line "use AgentPass for credential brokering" snippet for their READMEs. Trade: you write the integration code; they get safer-by-default users. Time-to-first-partner: 2–3 weeks.

**Reject:** Google/Bing ads. LinkedIn ads. Cold outbound to security teams. Sales-led GTM. Any channel needing a sales rep.

### Content engine

- **Cadence:** 1 deep technical post/week + 2 X threads + 1 short YouTube/Loom demo.
- **Home base:** your own blog (Astro on Cloudflare Pages, no Hashnode/Medium dependency), syndicated to dev.to and HN.
- **AEO/LLM-discoverability:** every post has a clear "Problem / Solution / Code" structure with a TL;DR ≤80 words at top — this is the format ChatGPT/Claude prefer when citing in answers. Sprinkle your name + "AgentPass" in every code block and screenshot.
- **The angle Composio can't copy:** they're a 30-person company writing for SaaS PMs. You're a solo founder writing for the dev who's debugging at midnight. Voice differentiates.

### Community play

The buyers already cluster in: r/ClaudeAI (~200K), r/LocalLLaMA (~400K), r/cursor (~50K), Anthropic Discord, the MCP Discord, the Cursor Discord. **Be a credible regular in two of these for 60 days before you launch.** Answer questions, ship PRs to MCP server repos, file bug reports on Cursor. Then launch. Don't spam — your post must be the most useful thing in the channel that day.

### Launch sequence (with dates, anchored to today 2026-04-27)

- **2026-05-25:** Landing page + waitlist live. Tagline: "Your AI agents will never see your API keys again." 1-paragraph manifesto. Tally form for "what agents do you run?"
- **2026-06-15:** Private alpha to 10 hand-picked Claude Code / Cursor power users from your X DMs.
- **2026-07-01:** Show HN. Title: "Show HN: AgentPass — credential broker that makes Claude Code / Cursor agents un-leakable." OSS repo + downloadable binary on launch day.
- **2026-07-08:** Product Hunt (after HN heat dies down — never the same week).
- **2026-07-22:** Newsletter cross-promo (TLDR Newsletter Dev edition, Last Week in AI, Indie Hackers). Submit a guest post to one — *not* paid sponsorship.
- **Throughout July–Sep:** weekly long-form post + 1 maintainer-DM/day.

### Partnership leverage (3 trades worth attempting)

1. **Cursor team** — offer to write the official "secret management with Cursor agents" doc page. Trade: doc citation. Probability of close: 30% if you ship something useful first.
2. **Anthropic DevRel** — offer a Claude Code skill in the official skills repo + a "best practices for Claude Code secrets" blog post co-authored. Probability: 25%.
3. **One MCP gateway provider (Pomerium, Strata, or TrueFoundry)** — offer to be the "personal-tier" referral when their enterprise prospect's individual devs need a vault. Trade: their logo on your site, your name on theirs. Probability: 50% with one of the three.

**Skip** any partnership requiring a Bangalore-based founder to fly to a US conference. Stay async.

---

## Phase 10 — Devil's advocate

I've watched ~200 of these die. Here's the ranked failure mode list for the **narrow re-pitch** (the broad pitch is already dead per §4).

### 1. (40%) **1Password ships runtime credential issuance for Cursor/Claude Code in Q3 2026.**
- *Failure mode:* their roadmap explicitly promises this "later in 2026"; they have the partnerships locked.
- *Leading indicator (30–60 days early):* a 1Password blog post or DevRel talk announcing the runtime API.
- *Mitigation:* ship faster on the *agent-bootstrapping* and *multi-key fallback* features they don't have on the roadmap. Make AgentPass meaningfully better in 2 specific dimensions, not generally similar.
- *Pivot:* re-position as "the open-source companion to 1Password Unified Access for runtimes they don't support yet" — become a feature 1Password buys for $5–10M.

### 2. (25%) **Composio / Arcade.dev ship a free flat-priced personal tier and undercut you.**
- *Failure mode:* Composio's existing free tier (20K calls/mo) already covers most indie use; pushing it to "free forever for individuals" is one VC-pressured pricing change away.
- *Leading indicator:* Composio's pricing page changes; their Discord pivots messaging to "free for indie devs."
- *Mitigation:* lean harder on **local-first / no cloud account required**. That's the one thing a Lightspeed-funded startup can't honestly offer.
- *Pivot:* go OSS-hard — make AgentPass a Linux Foundation project, capture mindshare, build a paid hosted tier on top.

### 3. (15%) **MCP spec shifts again and obviates the proxy pattern.**
- *Failure mode:* the AAIF (Linux Foundation) ratifies a credential-passing primitive in MCP itself, e.g., a `secret://` URI scheme that all MCP runtimes resolve natively.
- *Leading indicator:* a working group RFC posted on the MCP spec repo.
- *Mitigation:* watch the spec repo daily; be on the WG if you can.
- *Pivot:* become the *implementation* of the spec primitive — an OSS reference implementation has its own brand.

### 4. (10%) **No GTM traction — content engine doesn't compound.**
- *Failure mode:* you ship MVP, post 6 articles, get 100 stars and 4 paying customers, and the curve flatlines. This is the most common solo-SaaS death.
- *Leading indicator:* by week 8, organic search impressions <500/week.
- *Mitigation:* enforce a hard post/week cadence; if cadence slips, you're already losing.
- *Pivot:* sunset the cloud product, keep the OSS, and use it as a credibility piece for consulting on the next venture.

### 5. (10%) **A breach. Your vault gets compromised. Trust evaporates.**
- *Failure mode:* a single CVE in your proxy or a sync-tier bug exposes a customer's keys. AI security tools are scrutinized 10× more than other categories.
- *Leading indicator:* dependabot alerts you ignore; a fuzz-tester filing issues you don't action.
- *Mitigation:* SOC 2 readiness from week 1 (audit logs, secret-scan dependencies, no telemetry on secret values). Engage Trail of Bits or similar for a paid security review at month 6.
- *Pivot:* there is no pivot from "the credential manager that leaked credentials." Brand is dead. You shut it down honourably.

### THE ONE assumption that, if wrong, kills it

**That MCP-native AI agents become the dominant runtime for >100K paying indie/prosumer developers within 18 months.** If MCP stalls — if Cursor and Claude Code abandon agent loops in favour of single-shot tool calls, or if the AAIF squabbles and the spec fragments — your buyer disappears. **Watch:** monthly MCP server count on the registry, Claude Code monthly active users (Anthropic publishes), Cursor agent-mode usage. Any flat-line over 60 days = kill.

---

## Phase 11 — 7 / 30 / 90 day plan

Concrete outputs only.

### Day 7 (2026-05-04)
- Decision committed: **kill or run the narrow re-pitch.** No middle ground.
- If running: domain `agentpass.dev` registered + Cloudflare Pages landing page live with email capture.
- 3 customer-discovery calls booked with Claude Code / Cursor power users from your X network.
- 1 X thread shipped: "Why your AI agent leaks API keys (and what 1Password's launch missed)."
- Empty-repo curse broken: `bun init` + first commit + GitHub repo public.

### Day 30 (2026-05-27)
- MVP CLI in 5 hands. `agentpass run claude` works end-to-end with one demo service (OpenAI key brokering).
- First $1: pre-order or Stripe Checkout for "Lifetime founder license, $99". Even 5 of these = product validation.
- Public weekly update rhythm established (X thread every Monday, blog post every Wednesday).
- Show HN draft written, not yet posted.

### Day 90 (2026-07-26)
- Show HN posted (target: top 30, ≥150 comments).
- $5–10K MRR or hard kill decision. The honest expectation given competitive density: **$2–4K MRR is the realistic range; if you're below $1K, kill.**
- 1 partnership conversation in motion (Cursor docs, MCP server maintainer co-marketing, or 1Password OSS-companion positioning).
- Content engine producing measurable inbound: ≥1K monthly organic visits to the blog, ≥3 inbound DMs/week from devs asking "is this for me?"

If the 90-day numbers come in below the kill thresholds, you've spent ~12 weeks of solo time, still have 29 ventures, AudioPod is still profitable, and you've validated the "this category is too crowded for solo" thesis cheaply. Rotate the assets (Cloudflare-Worker-based credential proxy code) into a feature inside another venture — it's a useful internal tool for AudioPod's webhook signing or any other product you build.

---

## Bottom line, said plainly

The category is real, the pain is real, the buyer exists — but the **slot you'd occupy as a solo founder is currently the most contested square on the AI infra board.** 1Password owns the human-vault relationship, Composio + Arcade own the integration layer, Infisical/Doppler own the dev-secrets layer, HashiCorp/IBM owns the enterprise, and three OSS Show HN projects own the indie technical pattern.

**Kill the broad pitch.** If you must build, build the runtime-specific local-first wedge in §5, time-box it to 6 months, and accept that the realistic ceiling is $30–80K MRR by month 18 — *not* $100K in 12. That's still a fine outcome, but it's not the kind of venture worth pulling focus off AudioPod or one of the 29 others. With 30 ventures already on the board, your scarce resource is *attention*, not ideas. Spend it where the competitive density is half this.

— end memo —
