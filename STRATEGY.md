# AgentPass — Venture Strategy Memo (v2)

**Pitch:** Local-first credential broker for AI coding agents. Free MIT-licensed CLI. Your Claude Code, Cursor, and OpenClaw agents never see your raw API keys.
**Audience:** Rakesh (solo founder, 30-venture portfolio, profitable AudioPod, Bangalore).
**Date:** 2026-05-23.
**Supersedes:** STRATEGY.md v1 (2026-04-27).
**Verdict (so you can stop reading if you want):** **CONDITIONAL GO for a 30-day validation sprint. NO-GO for the six-month venture plan as written.** OSS-first remains the right posture, but cloud sync, Teams, Observability, enterprise design partners, and $50K+ MRR planning are deferred until the CLI proves real pull.

**Current operating plan:** [VALIDATION_SPRINT.md](./VALIDATION_SPRINT.md) is the active decision document. Sections below remain useful market context, but any claim that assumes generic HTTPS credential rewriting, cloud monetisation, or a $50K–$100K MRR path is shelved until the day-30 exit criteria are hit.

---

## Phase 0 — What changed since v1

Five weeks ago I called the broad pitch dead. I was directionally right but **factually sloppy**. Web research on 2026-05-23 forces three corrections:

1. **The competitive map in v1 was wrong.** Only two of the five named "incumbents shipped the headline feature" actually ship the HTTP-proxy-with-placeholder architecture: Infisical Agent Vault (MIT OSS, [GitHub](https://github.com/Infisical/agent-vault), launched 2026-04-22, v0.21.1 shipped 2026-05-20) and HashiCorp Vault native-AI-agent (early-access only, [HashiCorp blog 2026-05-12](https://www.hashicorp.com/en/blog/announcing-native-ai-agent-support-in-hashicorp-vault), public beta "summer"). The other three are different product categories:
   - **1Password Unified Access** ([2026-03-17 press release](https://1password.com/press/2026/mar/1password-unified-access)) is endpoint discovery + enterprise audit, not a runtime proxy. Scoped credential issuance is "later in 2026." Wrong ICP — sells to CISOs.
   - **Composio** is Zapier-for-agents — 850 connectors, per-call billing, agent still touches keys via SDK function calls. [composio.dev/agentauth](https://composio.dev/agentauth).
   - **Arcade.dev** is end-user OAuth delegation for SaaS tools (Gmail, Slack), not developer API keys. [docs.arcade.dev](https://docs.arcade.dev/en/get-started/about-arcade).

   v1's "five shipped in 90 days" framing collapses to **one direct OSS twin (Infisical), one half-shipped enterprise feature (Vault EA), and three category errors.**

2. **The real threat is one project, not five.** Infisical Agent Vault is the architectural twin. MIT-licensed. Free. ~1.3k GitHub stars at launch. Same MITM HTTPS proxy, same placeholder substitution (their tokens look like `__anthropic_api_key__`; ours look like `{{secret:openai}}`). [Launch blog](https://infisical.com/blog/agent-vault-the-open-source-credential-proxy-and-vault-for-agents), [Show HN thread](https://news.ycombinator.com/item?id=47865822). We enter this fight five weeks behind the OSS leader. If we can't beat them on positioning (we won't beat them on features alone), this is over.

3. **MCP authentication is settled.** RFC 9728 (OAuth 2.0 Protected Resource Metadata) was mandated by the MCP spec in June 2025; the formal authorization spec ratified in the [MCP 2025-11-25 revision](https://modelcontextprotocol.io/specification/2025-11-25); OAuth 2.1 + PKCE is de facto; [MCP 2026 roadmap](https://stackoverflow.blog/2026/01/21/is-that-allowed-authentication-and-authorization-in-model-context-protocol/) prioritises SAML/OIDC enterprise auth. **The key-injection thesis has a 12–24 month window.** After that, the LLM-side static-API-key use case partially evaporates and the moat must evolve into a policy/observability layer (who used what, when, how much, with what scope, against what budget). Plan for that pivot from day one.

What the v1 verdict got *right*: the field is crowded; you don't have an enterprise distribution channel; a $100K-MRR-in-12-months goal is fantasy in this category. What it got *wrong*: it failed to see that **the runtime-specific local-first OSS lane is actually open** — Infisical is a generic vault company shipping an agent feature, not an agent-first vault. That lane is winnable by a solo founder with a 12-week content cadence and an MVP that already exists in the repo. The new verdict reflects that.

---

## Phase 1 — Snapshot (the partner memo)

AgentPass is the secrets layer between local AI coding agents and the APIs they call. Architecture: an encrypted SQLite vault with AES-256-GCM at rest (PBKDF2 100k iterations for the KEK), plus a localhost HTTP proxy that intercepts agent traffic and substitutes `{{secret:NAME}}` placeholders for real credentials. The agent process never holds the raw key in memory; the proxy holds it for the lifetime of the request only.

**Stage (2026-05-23):**
- Repo: 1 commit (`b7575af`, Initial commit: MVP with encrypted vault, HTTP proxy, CLI).
- Code: Bun + TypeScript. Vault, proxy, CLI scaffolded. Claude Code shim auto-detects keys in `.claude/settings.json`. No tests.
- Distribution: no public repo URL, no domain, no landing page, no waitlist, 0 stars, 0 users.
- Strategic posture (locked by founder, 2026-05-23): **OSS-first land-grab.** Free MIT CLI ships fast. Monetisation via paid cloud tier (sync + Teams + audit) after community traction. Eventual evolution into policy/observability layer for the MCP-OAuth era.

Why now (the question every founder gets asked): **the pain window is open and accelerating.** GitGuardian's [State of Secrets Sprawl 2026](https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026/): 28.65M new secrets leaked on public GitHub in 2025 (+34% YoY); AI-service credential leaks +81% YoY to 1.27M; 24,008 unique secrets in MCP-related config files (2,117 verified valid); commits by Claude Code leaked secrets at ~3.2% — twice the baseline. Public agent disasters now land monthly (full list in §7). The pain is documented, monetisable, and *getting worse*.

Why us (the harder question): you are a solo founder running 30 ventures with no security brand. You will lose any race that requires a sales engineer, a SOC-2 Type II report, or a Fortune-500 logo wall. You can win the race for **the single dev with six AI agents wired into their workflow and a `.env` they're scared of.** That dev does not call CISOs. That dev reads Hacker News, lurks in r/ClaudeAI (862K members) and r/cursor (77K), and installs the first thing whose `README` makes the pain go away in 90 seconds. That's our buyer.

---

## Phase 2 — Market diagnosis

### TAM / SAM / SOM (bottoms-up, ignore the $38B analyst-deck number)

The "Non-Human Identity Access Management" category is a $11–38B story over 2025–2036 ([GlobeNewswire / Meticulous](https://www.globenewswire.com/news-release/2026/04/22/3279125/0/en/Non-Human-Identity-Access-Management-Market-Global-Forecast-Report-2026-2036.html)) but counts every machine identity (K8s tokens, IoT, RPA, service accounts). Ignore that for our segment.

**Visible category spend on agent-specific credential tooling today:** ~$50–100M global, growing 3–4× per year.
- Composio: ~$5–10M ARR, [$29M Series A](https://www.extruct.ai/hub/composio-dev/), 850 connectors.
- Arcade.dev: <$5M ARR, [$12M seed](https://www.businesswire.com/news/home/20250318815130/en/), 29 employees.
- Infisical: well-funded, OSS-led, free Agent Vault gating a [paid Pro tier at $18/user/mo](https://infisical.com/pricing).
- Doppler: ~$30–60M ARR estimate ([2022 SiliconANGLE data](https://siliconangle.com/2022/04/27/) — 16K customers, 1.5B secrets/mo), flat-ish recent growth signal.
- HashiCorp Vault: now IBM-owned ([$6.4B exit Feb 2025](https://www.ibm.com/think/news/ibm-acquires-hashicorp)).

**Reachable SAM as solo founder:** the long-tail of devs using Claude Code, Cursor, Cline, Aider, OpenClaw, Codex CLI who refuse enterprise lock-in. Reachable cohorts (verified):
- Cursor: [~$2B ARR, >1M DAU, multi-million MAU](https://sacra.com/c/cursor/) (Feb 2026).
- Cline: [5M VS Code installs, $32M Series A](https://www.morphllm.com/best-ai-coding-agents-2026).
- Aider: 39K stars, ~4.1M installs, ~15B tokens/week.
- Claude Code: no official MAU; GitGuardian's metric (Claude-Code-assisted commits at 2× the secret-leak baseline) implies measurable share of public GitHub activity.
- MCP registry: [~2,000 servers, 97M monthly SDK downloads, 81K GitHub stars by March 2026](https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026).
- r/ClaudeAI 862K, r/cursor 77K, r/LocalLLaMA ~500K ([Gummysearch](https://gummysearch.com/r/ClaudeAI/)).
- Stack Overflow 2025: 84% of devs use AI tools, **23% use agents weekly**, 81% concerned about security/privacy of agents ([Stack Overflow](https://stackoverflow.blog/2025/12/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here/)).

Order-of-magnitude SAM math: if 23% of pro devs use agents weekly and pro devs globally number ~25M, that's ~5.75M weekly agent users. If 10% are power users with multi-key pain and 1.5% would pay $7/mo for a Personal Cloud tier, that's **~8,600 × $84/yr = $720K ARR cap on the personal tier alone.** Add Teams at $19/seat for 2–10 person AI-native startups (~5,000 such teams reachable in year 2 × 3 seats × $228/yr × 5% capture) = **another $1.7M ARR ceiling.** Total realistic SAM: **$2–3M ARR.** Below venture-scale, above lifestyle-business floor. Inside the user's stated $10K–$100K MRR range, by design.

**Year-1 SOM:** 200–500 paying customers at $7–19/mo blended. **$2K–8K MRR by month 12 is the realistic range.** $10K MRR by month 9–12 is the bull case.

### Tailwinds (concrete, cited)

1. **Secrets sprawl is an accelerating disaster.** GitGuardian 2026: +34% YoY new public leaks, +81% YoY AI-service leaks, 64% of secrets confirmed valid in 2022 still work in Jan 2026, internal repos 6× more likely than public to contain hardcoded secrets. The pain is real, measured, monetisable.
2. **Public agent disasters are now monthly news.** Replit AI deleted a production DB in [July 2025](https://cybersrcc.com/2025/08/26/rogue-replit-ai-agent-deletes-production-database-and-executes-deceptive-cover-up/). Johann Rehberger demoed [end-to-end secrets exfiltration from Devin via prompt injection for $500](https://embracethered.com/blog/posts/2025/devin-can-leak-your-secrets/). Claude Code's source map leaked on [2026-03-31](https://www.zscaler.com/blogs/security-research/anthropic-claude-code-leak), making CVE-2026-21852 (key exfil via malicious MCP servers) easier to weaponise. [WordPress 7.0 shipped 2026-05](https://www.techtimes.com/articles/317028/20260522/wordpress-70-ships-ai-agent-infrastructure-api-key-theft-risk-surfaces-launch-day.htm) with an AI form that autofills Anthropic keys in plaintext. Dollar-quantified incidents pile up: [$4,200 over 63 hours](https://medium.com/@sattyamjain96/the-agent-that-burned-4-200-in-63-hours-a-production-ai-postmortem-d38fd9586a85), $72K overnight retry loop, [$1.3M month for the OpenClaw creator](https://www.tomshardware.com/tech-industry/artificial-intelligence/openclaw-creator-burns-through-1-3-million-in-openai-api-tokens-in-a-single-month).
3. **MCP is now multi-vendor.** Anthropic donated MCP to the [Linux Foundation Agentic AI Foundation in December 2025](https://en.wikipedia.org/wiki/Model_Context_Protocol) (co-founders: Anthropic, Block, OpenAI). Vendor-neutral infra is fundable infra.
4. **EU AI Act high-risk obligations live 2026-08-02.** Enterprise procurement is rewriting AI vendor questionnaires now ([Orrick](https://www.orrick.com/en/Insights/2025/11/The-EU-AI-Act-6-Steps-to-Take-Before-2-August-2026)). India DPDP Phase II (consent manager) live 2026-11-13; Phase III obligations live 2027-05-13 with penalties up to ₹250 crore ([IAPP](https://iapp.org/news/a/with-rules-finalized-india-s-dpdpa-takes-force)). These are tailwinds for whoever owns the agent-traffic audit log — that's the policy/observability tier we want to build into in year 2.
5. **23% of devs use agents weekly and the share is growing.** Early enough to define category language, late enough that the buyer cohort exists.

### Headwinds (real and serious)

1. **MCP OAuth 2.1 is winning.** RFC 9728 ratified in MCP 2025-11-25 spec. Q2 2026 roadmap = enterprise SAML/OIDC. As MCP servers (Stripe, Linear, GitHub, Sentry, Atlassian, HubSpot, Vercel — all moved from STDIO to remote HTTP in Q2 2026 per [Digital Applied](https://www.digitalapplied.com/blog/mcp-ecosystem-h1-2026-retrospective-adoption-data-points)) migrate to OAuth, **the "static API key I need to inject" problem shrinks** for the MCP-tool side. LLM provider keys (Anthropic, OpenAI, Gemini, Groq, DeepSeek) remain key-shaped for the foreseeable future — that's the durable surface. Plan: lean into LLM-key brokering + non-MCP API keys in V1; pivot to policy/observability for the MCP-OAuth-era flows in V2.
2. **Infisical Agent Vault is free, MIT, and shipped 5 weeks ahead of us.** They have brand, distribution (existing 50K+ star OSS vault), and an enterprise upsell already wired. They are structurally optimised for generic developer-tools positioning. We win by being **opinionated and runtime-specific** in a way they can't be without alienating their enterprise pipeline.
3. **Platform-native key isolation incoming.** 1Password Unified Access has Anthropic, Cursor, GitHub, Vercel, Perplexity as launch partners. Anthropic could ship native Claude Code key isolation in 90 days. Cursor could do the same. Our window: ~12 months before native primitives appear; ~24 months before they're enterprise-ready.
4. **Free OSS ceiling on pricing power.** Doppler free tier, Infisical free OSS, Bitwarden CLI free — devs are anchored to "secrets management = free or near-free." Our paid tier must sell *something the free CLI doesn't do* (sync, audit log, Teams sharing, observability), not the core brokering itself.
5. **OSS proxies multiplied.** Beyond Infisical Agent Vault: [agentgateway](https://github.com/agentgateway/agentgateway) (OSS MCP+A2A proxy), [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry) (Keycloak/Entra OAuth), [IBM ContextForge](https://www.lunar.dev/post/the-best-open-source-mcp-gateways-in-2026), Microsoft MCP Gateway, AWS Bedrock AgentCore. The pattern is commodity. Our differentiation is the **personal/indie wedge** — none of these are pitched to a single dev with six agents and a `.env`.

### Capital flows (2025-26 snapshot)

- Composio: $29M Series A (Lightspeed, Together, Mar 2025).
- Arcade.dev: $12M seed (Laude, Mar 2025).
- Cline: $32M Series A (2026).
- Doppler: $28.9M cumulative; ISO 27001 cert Sep 2025; flat-ish growth.
- Infisical: well-funded; OSS-led; Agent Vault shipped Q1 2026.
- HashiCorp: $6.4B IBM acquisition Feb 2025.
- 1Password: ~$6.8B last valuation; Unified Access Mar 2026.
- YC W26 cohort: Clam, Cascade, Agentic Fabriq all in agent identity/auth/governance ([buildmvpfast YC W26 analysis](https://www.buildmvpfast.com/blog/yc-w26-batch-agent-infrastructure-boom), [TechCrunch Demo Day](https://techcrunch.com/2026/03/26/16-of-the-most-interesting-startups-from-yc-w26-demo-day/)).

This category is **overcapitalised at the top, commoditised at the bottom, with a thin middle.** The middle is what we want — a paid Personal Cloud tier between free OSS and enterprise seat-based. That middle is **uncontested as of 2026-05-23.**

### Regulatory and platform risk

- **MCP spec churn.** Moved from 2025-03 → 2025-06-18 → 2025-11-25 in 8 months. Mitigation: track the spec weekly; ship spec-compliant features within 30 days of revision; never depend on undocumented behaviour.
- **Anthropic / OpenAI / Cursor / Claude Code shipping native vault primitives.** Mitigation: be the "OSS reference implementation" + "polish-layer" for whatever they ship. If Anthropic ships Claude Code key isolation, we become "the multi-vendor version of that."
- **EU AI Act / India DPDP** — net tailwind once enterprise tier exists; net neutral for year-1 personal tier.

---

## Phase 3 — Competitive topology, corrected

```
                    BROAD (everything for everyone)         NARROW (one wedge)
                  ┌───────────────────────────────────┬─────────────────────────────┐
   INCUMBENTS     │  HashiCorp Vault (IBM, EA)        │  1Password Unified Access   │
   (enterprise,   │  Doppler                          │    [endpoint discovery]     │
    seat-based)   │                                   │                             │
                  ├───────────────────────────────────┼─────────────────────────────┤
   UPSTARTS       │  Composio (Zapier-for-agents)     │  Infisical Agent Vault  ◄── DIRECT
   (PLG, OSS)     │  Arcade.dev (end-user OAuth)      │  agentgateway (MCP+A2A)     │
                  │  AWS Bedrock AgentCore            │  MS MCP Gateway             │
                  │  IBM ContextForge                 │  mcp-gateway-registry       │
                  │                                   │  YC W26: Clam, Cascade,     │
                  │                                   │     Agentic Fabriq          │
                  │                                   │                             │
                  │                                   │  AgentPass  ◄── US          │
                  └───────────────────────────────────┴─────────────────────────────┘
```

**One direct competitor (Infisical Agent Vault), six adjacent threats, three category errors.** That's a different map than v1 drew.

### The three sharpest competitors and how to beat each

**Infisical Agent Vault — the direct twin.**
- *Strong:* MIT-licensed; free; extends a 50K+ star OSS vault with built-in distribution; HN credibility; Infisical Cloud upsell wired.
- *Weak:* generic developer-tools positioning; no opinion about which agent runtime you're using; "research preview, not production-ready" framing in their own docs; enterprise-driven roadmap will leave runtime-specific polish on the floor; HN comments already flagged token-refresh leakage, WebSocket auth, MCP outbound brokering, and agent-bootstrapping as open gaps.
- *Their structural constraint:* their pipeline pays for the enterprise tier. They cannot afford to invest 3 months in "make `agentpass run claude` magical for the Claude Code power user" — that's not how Infisical's GTM works.
- *Our move:* be the opinionated runtime-specific vault. Ship the four open Agent Vault HN problems as first-class features. Pick fights with named problems in long-form posts. Position as "Infisical Agent Vault, but built by a dev who actually uses Claude Code at midnight."

**1Password Unified Access — wrong category for our buyer, right brand for our risk.**
- *Strong:* distribution into 150K+ business customers; launch partners are the exact tools we care about (Cursor, GitHub, Vercel, Anthropic, Perplexity).
- *Weak:* enterprise-only; sales-led; "scoped runtime credential issuance later in 2026" — not shipped today; the architecture is endpoint discovery + governance, not runtime brokering.
- *Risk:* if they ship runtime brokering at re:Invent / Anthropic dev day in Q4 2026, our LLM-key-brokering use case loses oxygen in the prosumer-into-team-into-enterprise flywheel.
- *Our move:* position not against them but as **the open-source companion for runtimes they don't support yet**. Acquisition story exists if we build a real user base in that segment.

**HashiCorp Vault native AI agent — sleeping giant, not threat today.**
- *Strong:* IBM distribution into every bank/fintech/gov.
- *Weak:* enterprise-only; early-access; K8s-shaped; will never be installable by a single dev in 90 seconds.
- *Risk:* zero in year 1. Real in year 3 if we try to sell upmarket.
- *Our move:* never compete head-on. If we ever sell enterprise, sell as the agent-side primitive that *plugs into* Vault 2.0 — read secrets from Vault, broker them at runtime, write audit to Vault. Not a replacement, a companion.

### Shape of rivalry

Same conclusion as v1, sharpened: **not winner-take-most.** No network effect on private vaults. No data moat. Switching cost is low (export-to-`.env` is a one-liner). Differentiation ceiling capped by OSS alternatives and platform-native primitives. The market shape is **fragmented commodity at the bottom, bundled-into-bigger-platforms at the top.** Our slot is the thin paid middle — a Personal Cloud tier and a Teams plan with audit + sharing — that the OSS doesn't offer and the enterprise vendors won't bother selling to.

---

## Phase 4 — Verdict: **CONDITIONAL GO, 30-day sprint only**

Reversal of v1's KILL is now narrowed. The correct decision is not "build the full venture"; it is "prove the technical wedge in 30 days."

1. **Architecture is plausible but not yet proven.** The repo now has vault password verification, audit logging, direct proxy substitution, and HTTPS CONNECT tunneling. It does **not** yet have tested generic HTTPS header rewriting through CONNECT; that is the sprint blocker.
2. **The narrow runtime-opinionated wedge is open.** Infisical chose generic; we choose specific. That's a defensible choice for a solo founder who can write better Claude Code / Cursor / OpenClaw shims than a 30-person company will bother to write.
3. **OSS-first land-grab is the right monetisation curve for our resources.** No paid acquisition ($0 marketing budget), no sales team, no compliance theatre. Earn stars and DMs first; charge for what stars don't pay for (sync, audit, Teams).
4. **The $50K–$100K MRR path is not an active plan.** Treat $2K–$8K MRR by month 12 as the realistic first-order target if the CLI earns pull.
5. **Kill criteria move forward to day 30.** If the HTTPS credential-brokering story and demo are not credible by day 30, rotate the code into portfolio-internal credential brokering and stop treating this as a standalone venture.

**The three conditions:**

- **C1 — OSS-first, single-binary, no cloud account required for the free tier.** This is the structural advantage Infisical can't honestly match without breaking their enterprise upsell. Lose this and we have no moat.
- **C2 — Runtime-opinionated.** First-class shims for Claude Code, Cursor, OpenClaw, Codex CLI shipped in V1. Generic mode exists, but the marketing copy and onboarding both start from "what agent are you running today?". If we ship a generic vault, we're Infisical-but-smaller and we lose.
- **C3 — Hard time-box.** 30-day technical and user-signal gate first. The old six-month gate only matters after the sprint passes.

---

## Phase 5 — Positioning

**One-liner:** "The local-first credential broker for Claude Code, Cursor, and MCP power users."

**Comparative:** "Faster than Infisical, simpler than 1Password, free as a single binary."

**90-second pitch:** Your AI coding agents have access to every API key in your `.env`. When one of them gets prompt-injected — and they do, [monthly](https://embracethered.com/blog/posts/2025/devin-can-leak-your-secrets/) — those keys leave your laptop. AgentPass runs a localhost proxy that holds your keys in an encrypted vault and substitutes them into your agent's HTTP traffic at the wire. Your agent process never sees the raw key. Free, MIT, single binary. `brew install agentpass`. 90 seconds to first proxied call.

**Voice differentiation:** Infisical writes for SaaS PMs evaluating vaults. Composio writes for the engineering lead picking an integration platform. We write for the dev debugging at midnight whose Claude Code agent just got rate-limited and they don't know which of their five OpenAI keys is exhausted. That voice — practitioner, specific, unsponsored — is the moat Composio's content engine and Infisical's docs can't copy.

**What we are not:**
- Not an enterprise SSO vault. Not selling SAML.
- Not a SaaS-connector platform. Not 850 connectors.
- Not an MCP runtime. Not Arcade.dev.
- Not an HTTPS pen-testing tool. Not mitmproxy.
- Not free forever for everything. Personal Cloud and Teams are paid.

---

## Phase 6 — Path to $10K → $50K → $100K MRR

**Anchor:** today = 2026-05-23. All months indexed from here.

| Gate | Month | Date | What has to be true | Annual run-rate |
|---|---|---|---|---|
| First $1 | 2 | 2026-07 | Stripe checkout live; Lifetime founder license $99 × 10 = $990 one-time | — |
| $1K MRR | 6 | 2026-11 | ~140 Personal × $7 = $980, OR 50 Personal + 10 Teams (5 seats × $19 ÷ 10 = $95 avg). Post-Show-HN, first real waitlist conversion. | $12K ARR |
| $5K MRR | 9 | 2027-02 | ~700 Personal at $7. Three referenced blog posts ranking on Google. First MCP server maintainer trade closed. | $60K ARR |
| **$10K MRR** | **12** | **2027-05** | ~1,400 Personal + 5–10 Teams accounts averaging 3 seats. Cursor or Claude Code community knows the name. | **$120K ARR** |
| $25K MRR | 15 | 2027-08 | Teams plan compounding (30+ accounts). One small enterprise design partner ($2K/mo). | $300K ARR |
| **$50K MRR** | **18** | **2027-11** | ~5,000 Personal + ~80 Teams seats + 2 enterprise design partners. Policy/Observability tier in private beta. | **$600K ARR** |
| $75K MRR | 21 | 2028-02 | Observability tier converting (~$50/mo per active vault). Audit-log + spend-policy SKU. | $900K ARR |
| **$100K MRR** | **24** | **2028-05** | ~7,000 Personal + ~250 Teams seats + 3–5 enterprise design partners at $2–5K/mo OR Observability tier at $50/mo × ~500 active = $25K extra MRR. | **$1.2M ARR** |

The shape of this curve is **slow compound from organic content + community, not blitzscale.** Month 1–6 is brand and credibility (0 MRR is fine). Month 6–12 is the first revenue inflection (Personal Cloud upsell). Month 12–24 is Teams + Observability as compounding revenue layers.

**Critical sequencing rules:**
- Personal Cloud (sync + multi-device) cannot launch until ≥1K free CLI users — premature monetisation kills the OSS flywheel.
- Teams plan cannot launch until Personal has 500+ paying users — without that base, Teams looks empty.
- Observability tier (the post-MCP-OAuth pivot) cannot launch until Teams has 30+ accounts — same reason.
- Enterprise design partners cannot be pursued until $25K MRR — solo founder bandwidth.

If month-6 hits under $1K MRR / <500 stars / <50 paying, **kill or rotate** (§9). If month-12 hits under $5K MRR / <2K stars, **rotate to a feature inside another venture.** If month-18 hits under $25K MRR, **stop adding scope, harvest what exists, run as a lifestyle cashflow product.**

---

## Phase 7 — Tailwinds and headwinds (detail)

### Tailwinds that compound

- **Secrets sprawl curve is monotone up.** GitGuardian's [2023→2024→2025→2026 series](https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026/) shows the leak count growing every year. The pain is not getting better.
- **AI-service-credential leaks +81% YoY.** This is *our* segment growing, not general secrets.
- **Stack Overflow 2025: 84% of devs use AI tools, 23% use agents weekly, share growing.** Adoption is the inflection of buyer formation.
- **MCP donated to Linux Foundation December 2025** ([Wikipedia](https://en.wikipedia.org/wiki/Model_Context_Protocol)) — vendor-neutral standardisation is durable infra tailwind.
- **EU AI Act 2026-08-02 high-risk obligations** — enterprise procurement now demands AI-vendor questionnaires; that buyer pool builds slowly through 2027.
- **India DPDP Phase II 2026-11-13 / Phase III 2027-05-13** — DPDP penalties ₹250 crore make consent-and-audit revenue-generating, not a cost centre.
- **Cloudflare Agents Week 2026** ([recap](https://blog.cloudflare.com/agents-week-in-review/)) shipped Dynamic Workers, Sandboxes GA, AI Search GA, Workflows. Net positive for us — cheaper runtime infrastructure to build the cloud tier on.

### Headwinds we must price in

- **MCP OAuth eats LLM-side static-key brokering on a 12–24 month curve.** This is the existential clock. Stripe, Linear, GitHub, Sentry, HubSpot, Vercel, Atlassian, Salesforce all moved to remote-HTTP MCP with OAuth in Q1–Q2 2026 ([Digital Applied retrospective](https://www.digitalapplied.com/blog/mcp-ecosystem-h1-2026-retrospective-adoption-data-points)). LLM provider keys (Anthropic, OpenAI, Gemini, Groq, DeepSeek) remain key-shaped — that's the durable surface.
- **Platform-native isolation.** Anthropic, Cursor, OpenAI each have incentive to ship native vaulting. Anthropic already has surface area in `.claude/settings.json`.
- **OSS pricing ceiling.** Free Doppler tier, Infisical free OSS, Bitwarden CLI free — secrets management is anchored at "free or near-free." Our paid tier must monetise sync, audit, sharing — not the broker itself.
- **No security brand.** We will lose any deal that requires SOC 2 Type II in year 1.
- **Solo founder bandwidth.** With 30 ventures, attention is the scarce input. Every week spent on AgentPass is a week not spent on AudioPod / AgentDrive / MoltWork.

### The one assumption that, if wrong, kills it

**That LLM provider API keys remain the dominant credential surface for AI coding agents through 2027.** If Anthropic + OpenAI + Google all ship OAuth-based user-consent flows for their LLM APIs in 2026 — the way Stripe and GitHub did for MCP servers — then the entire LLM-key-injection use case collapses and we're left with the policy/observability tier 12 months earlier than planned. **Leading indicator (60 days):** an Anthropic blog post announcing OAuth 2.1 for Claude API. **Mitigation:** build observability/policy from V1 even if it's not the headline feature.

---

## Phase 8 — Devil's advocate (ranked failure modes)

Five scenarios, ranked by probability, with leading indicators and mitigations.

### 1. (35%) Infisical Agent Vault eats our lunch with feature velocity

- *Failure mode:* they ship Cursor / Claude Code / OpenClaw shims, multi-key fallback, and WebSocket support in Q3 2026 before we do. The differentiation collapses.
- *Leading indicator (30 days):* a `runtimes/` directory in their GitHub repo with Claude Code or Cursor modules.
- *Mitigation:* be visibly opinionated about the runtime in marketing copy from day 1. Get into Anthropic / Cursor Discord and become a known name *before* the head-to-head feature comparison gets written.
- *Pivot:* lean into local-first as the absolute hard line — Infisical Cloud is their upsell; we don't have one in year 1. "No cloud account required" is structurally easier for us to honour. If they out-feature us on shims, out-position them on data-residency and offline.

### 2. (25%) Anthropic ships native Claude Code key isolation at dev day Q4 2026

- *Failure mode:* Anthropic announces "Claude Code now keeps your API keys in an encrypted enclave; agents see hashed handles, not raw keys." Our V1 use case partially evaporates.
- *Leading indicator (60 days):* Anthropic DevRel blog post about MCP auth + Claude Code config security; a CVE in Claude Code config handling that forces a rewrite (CVE-2026-21852 already exists).
- *Mitigation:* multi-runtime support. If Anthropic ships native, we're still the broker for the Cursor + OpenClaw + Codex CLI + custom-MCP users. Cross-runtime aggregation is value Anthropic will not deliver.
- *Pivot:* position as "the multi-vendor companion to Anthropic's native isolation" and "the audit layer Anthropic doesn't ship."

### 3. (15%) MCP spec ratifies a credential primitive that obviates the proxy

- *Failure mode:* the Agentic AI Foundation working group ratifies a `secret://` URI scheme or equivalent that every MCP runtime resolves natively. Our brokering disappears as a layer.
- *Leading indicator (90 days):* a working-group RFC in the MCP spec repo proposing a credential-passing primitive.
- *Mitigation:* track the spec repo weekly. Be the OSS reference implementation of whatever the spec adopts. An OSS reference impl has its own brand value.
- *Pivot:* become the implementation + policy layer on top of the spec primitive. "The spec defines the protocol; we ship the polish."

### 4. (15%) No content-engine traction — the curve doesn't compound

- *Failure mode:* MVP ships, 6 posts go up, 150 stars, 6 paying customers, organic search impressions flat. Solo-SaaS death by attrition.
- *Leading indicator (8 weeks):* organic search impressions <500/week; Show HN gets <100 comments; <10 inbound DMs total.
- *Mitigation:* hard editorial cadence (1 deep post + 2 X threads + 1 video / week, see GTM.md). If cadence slips, we're already losing.
- *Pivot:* sunset the cloud tier and run as pure OSS with a paid hosted-tier-as-funnel for AudioPod or AgentDrive credential needs.

### 5. (10%) A breach — vault compromised, trust evaporates

- *Failure mode:* a CVE in the proxy or sync tier leaks customer keys. AI security tools are scrutinised 10× more than other categories.
- *Leading indicator:* dependabot alerts ignored; a fuzz-tester filing issues unactioned; a security researcher asking polite questions.
- *Mitigation:* SOC 2 readiness practices from week 1 — append-only audit logs, secret-scan our own dependencies, zero telemetry on secret values, signed releases, reproducible builds. Engage Trail of Bits or Latacora for a paid security review at month 6.
- *Pivot:* there is no pivot from "the credential manager that leaked credentials." Brand is dead. Honourable shutdown, public post-mortem, refunds.

---

## Phase 9 — 7 / 30 / 90 day plan

**T+0 = 2026-05-23.** Concrete outputs only.

### Day 7 (2026-05-30)

- Repo `Rakesh1002/agentpass` public on GitHub. License: MIT. README.md polished.
- Domain `agentpass.dev` registered + Cloudflare Pages landing page live with email capture. Tagline: "Your AI agents will never see your API keys again."
- 3 customer-discovery calls booked with Claude Code / Cursor power users from your X network.
- 1 X thread shipped: "Why your AI coding agent leaks API keys — and the localhost-proxy fix Infisical's Agent Vault still ships with TODOs."
- Test suite skeleton in place (`bun:test`); CI configured (GitHub Actions).
- Decision finalised on Personal Cloud architecture: D1 + R2 (encrypted blob).

### Day 30 (2026-06-22)

- MVP CLI in 10 hands. `agentpass run claude` works end-to-end with OpenAI + Anthropic key brokering.
- First $1 of revenue: Stripe Checkout for "Lifetime founder license, $99" — even 10 of these ($990) is product validation.
- Weekly update rhythm established (X thread every Monday, blog post every Wednesday).
- Show HN draft written, peer-reviewed, not yet posted.
- Cursor shim ships (V1 scope: drop-in for `cursorrules`-aware agent flows).

### Day 90 (2026-08-21)

- Show HN posted in the 2026-07 → 2026-08 window. Target: top 30, ≥150 comments.
- Product Hunt the week after HN heat dies down.
- Newsletter cross-promo (TLDR AI, Ben's Bites, Pragmatic Engineer) — guest post, not paid sponsorship.
- **Honest expected outcome at day 90:** ≥500 GitHub stars, ≥100 active CLI users, ≥10 paying ($100–500 MRR). **Kill threshold:** <100 stars / <20 active users / <$50 MRR / no inbound DMs from MCP server maintainers — at which point rotate the assets into another venture and shut this down.
- 1 partnership conversation in motion (Cursor docs co-authoring, MCP server maintainer co-marketing, or 1Password "OSS companion" referral trade).

### Day 180 (kill gate — 2026-11-19)

- **Kill threshold (any one of):** <1K stars, <100 paying customers, <$2K MRR, <2 partnership trades closed. Kill or rotate.
- **Continue threshold (all of):** ≥1K stars, ≥100 paying, ≥$2K MRR, Teams plan in private beta with ≥10 invited teams. Proceed to month-12 plan.

### Day 365 (V1 → V2 transition — 2027-05-22)

- **Continue threshold:** ≥$10K MRR. If hit, V2 (Teams + Observability) scoped and execution begun.
- **Soft-land threshold:** $2K–10K MRR. Keep running as lifestyle cashflow product; no new feature scope; harvest.

---

## Phase 10 — Bottom line, said plainly

The v1 verdict was "KILL" because the v1 competitive map said five well-funded incumbents had shipped the headline feature. The map was wrong — only one (Infisical) is a real architectural twin, and the others are different product categories sold to different buyers.

The new verdict is **BUILD, with three conditions** (OSS-first, runtime-opinionated, 6-month hard kill gate) because the corrected map shows the runtime-specific local-first lane is open and winnable by a solo founder on an 18–24 month curve to $10K → $100K MRR.

The category is real. The pain is documented and accelerating. The buyer exists and clusters in two subreddits, one Discord, and one X-dev-twitter graph we can reach for zero CAC. The Infisical Agent Vault project is the existential threat — but they're playing a generic vault game we can structurally not afford to lose by being opinionated about the runtime in ways they're not optimised to copy.

The downside risk is **6 months of focused solo time and a hard kill if numbers miss**. The code does not get thrown away — credential brokering is reusable as an internal module across AudioPod, AgentDrive, MoltWork, MailMolt, AIGateWay, and at least three other ventures already in the registry.

The upside is **$50–100K MRR on an 18–24 month horizon, with optional evolution into the policy/observability tier as MCP OAuth eats the LLM-key brokering use case.** That is not venture-scale, but it is a fine standalone business and a meaningful infra primitive across the 30-venture portfolio. Acquisition story exists if 1Password, Doppler, Infisical, or Cloudflare want the runtime-specific user base for $5–15M at month 24.

Go.

— end memo —

---

## Companion documents

- `PRODUCT.md` — what AgentPass is, who it's for, JTBDs, user flows, UI/UX screens, journey mapping.
- `GTM.md` — ICP, channels, content engine, launch sequence, partnerships, pricing, kill criteria.

Both anchor to this strategy memo. All three docs use 2026-05-23 as T+0 and cite the same source set.
