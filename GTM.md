# AgentPass — Go-to-Market

**Date:** 2026-05-23.
**Companion to:** [STRATEGY.md](./STRATEGY.md), [PRODUCT.md](./PRODUCT.md).
**Posture:** 30-day validation sprint. Free MIT CLI first; paid Personal Cloud, Teams, Observability, and enterprise work are explicitly deferred until the CLI proves external pull.

**Active plan:** [VALIDATION_SPRINT.md](./VALIDATION_SPRINT.md). Treat revenue sections in this document as inactive until the sprint exits cleanly.

---

## 1. Ideal Customer Profile (ICP)

Three tiers, ranked by reachability for a solo founder.

### ICP 1 (primary) — The Multi-Agent Power User

- **Who:** professional dev (engineer or technical founder), 25–45, runs 2+ AI coding agents (Claude Code, Cursor, Cline, Aider, OpenClaw, Codex CLI) plus 2+ LLM provider keys and 4+ MCP-server-scoped tokens. Heavily English-language X / Reddit / HN consumer.
- **Where they cluster:**
  - r/ClaudeAI: 862K members ([Gummysearch](https://gummysearch.com/r/ClaudeAI/))
  - r/cursor: 77K members
  - r/LocalLLaMA: ~500K members
  - X dev twitter (Simon Willison, Logan Kilpatrick, Peter Steinberger, Karpathy followers, Mitchell Hashimoto-adjacent)
  - Anthropic / Cursor / MCP Discord (size unverified, ~50K–200K combined estimate)
  - HN front page on weekends
- **Sized cohort:** Cursor has [>1M DAU](https://sacra.com/c/cursor/) (Feb 2026). Cline has [5M VS Code installs](https://www.morphllm.com/best-ai-coding-agents-2026). MCP registry: [2,000 servers, 97M monthly SDK downloads, 81K GitHub stars](https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026). Stack Overflow 2025: [23% of devs use AI agents weekly](https://stackoverflow.blog/2025/12/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here/) of ~25M pro devs globally → ~5.75M weekly agent users.
- **Reachable as solo founder:** ~50K–200K globally. We need ~1.5–2% conversion to hit our year-1 SOM (200–500 paying customers).
- **What they pay for:** Personal Cloud ($7/mo) for multi-device sync + audit log retention >90 days.

### ICP 2 (secondary) — The AI-Native Startup Engineer

- **Who:** founding or early engineer at a 2–10 person AI-native startup (post-seed, pre-Series A). Ships agents in CI + production + dev. Has at least one outage from a leaked or rotated key in the last 90 days.
- **Where they cluster:** YC alumni network, Indie Hackers, X founder twitter, founder-only Discords (Pioneer, On Deck), AI-focused Slack communities.
- **Sized cohort:** YC W26 batch alone has ~30+ AI-native startups; YC active alumni roster ~5,000; broader cohort of pre-Series-A AI-native startups globally ~5,000–10,000.
- **Reachable as solo founder:** ~1,000–2,500 such teams in year 1 via the primary ICP's referral graph + content + Show HN.
- **What they pay for:** Teams ($19/seat/mo) for shared secrets + audit log + role-based access.

### ICP 3 (tertiary) — Indie Open-Source MCP Server Maintainer

- **Who:** developer maintaining a public MCP server (GitHub, Linear, Stripe, Notion, custom) with ≥50 stars. Pain: their users keep filing issues like "where do I put my key?"
- **Where they cluster:** GitHub trending repos with `mcp-` prefix, MCP Discord, specific MCP-server GitHub orgs.
- **Sized cohort:** estimated 200 maintained MCP servers as of Q2 2026 with >50 stars and active maintainers.
- **Reachable as solo founder:** ~30 named maintainers in year 1 via direct DM outreach.
- **What they pay for:** nothing directly — but they install AgentPass-snippet links in their README for their users. **They are the distribution layer, not the customer.**

### Anti-ICP — Who we will refuse to sell to in year 1

| Anti-ICP | Why refuse |
|---|---|
| Fortune 500 CISO buying for 1K+ employees | Wrong product (no SOC 2 Type II, no SAML, no SCIM, no enterprise sales). Refer to 1Password Unified Access. |
| Government / regulated industry buyer | DPDP / HIPAA / FedRAMP compliance is years out. Will sink dev time. |
| Single-LLM hobbyist with one OpenAI key | Overkill. Recommend `direnv` or 1Password Personal. |
| No-code agent platform (Make, Zapier, n8n) | Wrong abstraction layer. The platform owns the secret, not the agent. |
| Anyone asking for self-hosted Enterprise in year 1 | "Self-hosted free OSS" is the answer; "self-hosted paid Enterprise" is a year 3+ conversation. |
| Anyone needing HSM or BYOK in year 1 | Out of scope. Recommend HashiCorp Vault. |

Refusing these aggressively is itself a positioning act — it makes the wedge sharper for the buyers we want.

---

## 2. Channels (ranked, with right-to-win)

| # | Channel | Audience size | Signal quality | Cost | Time to first customer | Our right-to-win |
|---|---|---|---|---|---|---|
| 1 | Show HN | ~6M MAU; hit days reach 10K–100K views | High (credibility) | $0 | 24h post-launch | Story is sharp ("Infisical Agent Vault, but local-first") and the demo is dramatic |
| 2 | r/ClaudeAI | 862K members | High (single biggest concentration of ICP1) | $0 | 7–14 days for organic posts | Author replies inline; first-person practitioner voice |
| 3 | r/cursor | 77K members | High (small but concentrated) | $0 | 7 days | Same |
| 4 | r/LocalLLaMA | ~500K members | Mid (broader AI/inference) | $0 | 14 days | Self-hosted angle resonates here |
| 5 | X dev twitter | Long-tail; varies by amplifier | High when a top voice picks up | $0 | 30 days for first amplifier | Founder has existing AudioPod-adjacent network; Simon Willison-aligned voice |
| 6 | MCP Discord | ~50K estimated | Mid (high intent, low volume) | $0 | 14 days | We support MCP power users explicitly |
| 7 | GitHub trending | Free reach on hit days | High (one-time spike) | $0 | Unpredictable | OSS-MIT release timing aligned to Show HN |
| 8 | YouTube (Matthew Berman, Fireship) | Berman: ~700K subs; Fireship: 4.07M subs | High when a sponsor/shout-out lands | Variable | 60–90 days for organic mention | Earned via Show HN traction, not paid |
| 9 | Newsletters (TLDR AI, Ben's Bites, Pragmatic Engineer) | TLDR AI 500K+; Ben's Bites 100K+; Pragmatic Engineer ~700K | Mid–high (sponsor-shaped) | $0 (guest post) / $3–10K paid | 14 days for guest post | Better as guest post than paid sponsorship |
| 10 | dev.to / Hashnode cross-post | Crowded engineering blog SEO | Low–mid | $0 | 30+ days for SEO compound | Tag-juice on `#ai`, `#security`, `#cli` |

**Ruled out:** Google / Bing ads (CPC $4–11 for "AI agent" terms, LTV math doesn't support); LinkedIn ads (wrong audience); cold outbound to security teams (wrong buyer); conference sponsorships (cost-prohibitive for solo founder); affiliate networks (not enough partner products to leverage).

### Top 3 channel plays (the ones we execute on, ranked)

**Play 1 — Show HN + post-launch flywheel.**
- Time-to-first-customer: 24h post-launch.
- CAC: $0.
- Tactic: ship MVP with a 90-second demo (Claude Code, key rotates mid-flight, agent never sees the key, audit log shows the rotation). Title: "Show HN: AgentPass — credential broker that makes Claude Code agents un-leakable."
- Leading indicator at 30 days: ≥500 GitHub stars, ≥30 cloud-waitlist signups, ≥10 inbound DMs from MCP server maintainers.

**Play 2 — Long-form posts targeting the four open Agent-Vault HN gaps.**
- Cadence: 1 deep technical post / week for 12 weeks.
- Channel: own blog (Astro on Cloudflare Pages) + dev.to cross-post + X thread + r/ClaudeAI repost.
- Topics pre-allocated (week-by-week):
  1. "Why Infisical Agent Vault's WebSocket auth is leaking, and how AgentPass closes it"
  2. "MCP server outbound calls: the credential gap nobody's writing about"
  3. "Token-refresh leakage in proxy brokers: a small bug, a big leak"
  4. "Agent-bootstrapping: when your agent signs up for Stripe, who holds the key?"
  5. "Multi-key OpenAI fallback: stop your batch job from stalling at 3am"
  6. "The 5-minute Claude Code setup that survives key rotation"
  7. "What `agentpass audit` taught me about a $400 agent loop"
  8. "Local-first vs cloud-first: why the proxy belongs on your machine"
  9. "From `.env` to vault in 90 seconds: a Cursor case study"
  10. "What the MCP 2025-11-25 spec means for your agent's secrets"
  11. "We replaced direnv with AgentPass — here's the diff"
  12. "Show your work: 90 days of `agentpass audit` from a working agent stack"
- SEO/AEO target: when devs search "agent credential proxy WebSocket," "AI agent token refresh leak," "Claude Code key rotation," AgentPass is the top result. This is the moat against Composio's content engine.

**Play 3 — Direct outreach to MCP server maintainers.**
- ~200 maintained MCP servers on GitHub with ≥50 stars. Top 30 by usage are the targets.
- Trade: we write the one-line `agentpass`-integration snippet for their README + a 200-word "secret management" section. They get safer-by-default users; we get a backlink and an install funnel.
- Cadence: 5 DMs / week × 12 weeks = 60 DMs. Close rate target: 5%, so 3 partnerships.
- Time-to-first-partner: 2–3 weeks.

---

## 3. Content engine

### Editorial rules (non-negotiable)

- **1 deep technical post per week, every Wednesday.** ~1,500–2,500 words. Format: Problem / Solution / Code / Result. TL;DR ≤80 words at top (AEO-friendly).
- **2 X threads per week, Monday and Thursday.** Either a story about a specific agent incident or a sharp opinion on a current ecosystem move (MCP spec change, 1Password partner announcement).
- **1 short Loom or YouTube demo per week, every Friday.** 60–120 seconds. One specific feature, recorded in the dev's actual workflow, no production polish.
- **Voice:** practitioner, specific, unsponsored. We are the dev debugging at midnight, not the SaaS marketing team. Voice differentiates from Composio (writes for SaaS PMs) and Infisical (writes for engineering leads).

### Cadence anchors

- Monday: X thread (often a reaction to a weekend incident or Sunday's news cycle).
- Wednesday: deep blog post.
- Thursday: X thread (often a clip or quote from the Wednesday post).
- Friday: Loom/YouTube demo.
- Weekend: rest, observe, build.

### AEO (Answer Engine Optimisation) format spec

Every long-form post follows this structure to maximise pickup by Claude / ChatGPT / Perplexity citations:

1. **TL;DR** (≤80 words, declarative, no marketing copy).
2. **Problem** (1 paragraph + named entity — e.g., "Infisical Agent Vault's WebSocket auth").
3. **Why it matters** (1 paragraph + a hard cited number).
4. **Solution** (heading + 3–5 specific steps).
5. **Code** (verbatim copy-paste block, runnable).
6. **Result** (before/after with timings or counts).
7. **What to try next** (one CTA, no email-gate).

Sprinkle "AgentPass" + the founder's name + a screenshot once per post (this is the format LLMs cite cleanly).

---

## 4. Launch sequence

T+0 = 2026-05-23. Anchors below are concrete dates.

| When | Date | Output | Definition of done |
|---|---|---|---|
| T+7d | 2026-05-30 | Domain registered (`agentpass.dev`); Cloudflare Pages landing page live; email waitlist via Tally | DNS resolves; page loads; ≥1 waitlist signup |
| T+14d | 2026-06-06 | Repo `Rakesh1002/agentpass` public; README polished; license MIT; CI green | `git clone && bun install && bun run src/cli.ts init` works |
| T+30d | 2026-06-22 | Private alpha to 10 hand-picked Claude Code / Cursor power users | All 10 successfully ran `agentpass run claude` at least once |
| T+45d | 2026-07-07 | Stripe Checkout live for "Lifetime founder license $99" | First $1 of revenue (target: 10 sales × $99 = $990) |
| T+60d | 2026-07-22 | **Show HN launch** | Top 30 ranking; ≥150 comments |
| T+67d | 2026-07-29 | Product Hunt launch (one week after HN heat) | Top 10 of day |
| T+80d | 2026-08-11 | Newsletter cross-promo: guest post in TLDR AI + Ben's Bites | Both placements confirmed |
| T+90d | 2026-08-21 | First partnership trade closed (MCP server README link) | ≥1 README badge live |
| T+120d | 2026-09-20 | Personal Cloud private beta | 50 invited users on the cloud tier |
| T+180d | 2026-11-19 | **Kill gate** | See §11 |

### Show HN post template

```
Show HN: AgentPass — credential broker that makes Claude Code / Cursor agents un-leakable

Hi HN — I'm Rakesh. I built AgentPass because I watched my Claude Code
agent burn $400 overnight on an OpenAI rate-limit loop and I had no
idea which agent did it.

AgentPass is a single binary + localhost HTTP proxy that:
- holds your API keys in an encrypted SQLite vault (AES-256-GCM)
- substitutes `{{secret:NAME}}` placeholders in agent HTTP traffic
- handles key rotation and rate-limit fallback automatically
- audit-logs every request so you can answer "which agent burned my quota"

Free, MIT, single binary. `brew install agentpass`. ~90 sec to first
proxied call.

Why now: GitGuardian's 2026 report shows 28.65M leaked secrets on
public GitHub last year — AI-service leaks +81% YoY. Public agent
disasters (Replit deleting prod DB, Devin secrets exfil for $500,
Claude Code source-map leak, WordPress 7.0 plaintext autofill) keep
landing. Infisical shipped Agent Vault last month — same architecture,
generic positioning. AgentPass is the runtime-opinionated version
built for Claude Code / Cursor / OpenClaw power users.

Repo: github.com/Rakesh1002/agentpass
Demo: agentpass.dev/demo
```

---

## 5. Partnerships (three named trades)

### Trade 1 — Cursor docs co-authoring

- **Target:** Cursor team (DevRel; Eric Z / Sualeh-adjacent).
- **Ask:** offer to write the official "secret management for Cursor agents" doc page.
- **Give:** the doc, plus a `cursorrules`-aware shim in AgentPass.
- **Trade:** doc citation back to `agentpass.dev`; potentially a mention in Cursor changelog.
- **Probability of close:** 30%.
- **Why they might say yes:** Cursor's official answer to "how do I manage secrets for agents" today is `direnv` + 1Password — they need a better story.

### Trade 2 — Anthropic DevRel Claude Code skill

- **Target:** Anthropic DevRel (Alex Albert / Logan Kilpatrick was at OpenAI then Google; check the current DevRel lead in Q3 2026).
- **Ask:** publish a Claude Code skill in the official skills repo that wraps `agentpass run` + auto-import of `.claude/settings.json` keys.
- **Give:** the skill, a co-authored blog post on "best practices for Claude Code secret management."
- **Trade:** official skill placement; one Anthropic-blog co-byline.
- **Probability of close:** 25%.
- **Why they might say yes:** the Claude Code source-map leak (2026-03-31) put pressure on them to recommend better secrets hygiene.

### Trade 3 — MCP server maintainer "OSS companion" referral

- **Target:** 3 maintainers, one each from a high-traffic MCP server (Stripe MCP, Linear MCP, GitHub MCP).
- **Ask:** add a small "Secret management: see AgentPass" note in their README.
- **Give:** a polished AgentPass integration snippet they can paste; offer to send a PR if helpful.
- **Trade:** README backlink; install funnel from their user base.
- **Probability of close:** 50% (need only 1 of 3 to make this play work).
- **Why they might say yes:** their issue tracker has multiple "where do I put my key?" issues; this is a one-line fix for them.

**Trades we will NOT pursue in year 1:** Anything requiring travel, anything requiring legal review (MSAs, DPAs), anything requiring a sales engineer for a partner-side enterprise deal. Stay async.

---

## 6. Pricing

### Tiers

| Tier | Price | Who | What you get |
|---|---|---|---|
| **Free / OSS** | $0 | Anyone | CLI + local vault + proxy. MIT-licensed. Single binary. Offline. Up to 90 days local audit log. Forever free. |
| **Personal Cloud** | $7/mo (or $72/yr — 14% off) | ICP 1 | Everything in Free + encrypted multi-device sync (D1/R2) + extended audit retention (1 year) + priority support + magic-link Web UI for viewing your vault. |
| **Teams** | $19/seat/mo (min 2 seats; volume discounts at 10+) | ICP 2 | Everything in Personal Cloud + shared team vaults + role-based access (owner / admin / member) + team audit log + invitation flow + Slack notifications on rotation events. |
| **Observability** (V2) | $50/mo per active vault (add-on to Personal or Teams) | ICP 1 + ICP 2 advanced | Long-form audit retention (forever) + spend attribution per agent + anomaly detection + JSONL export for SIEM + webhook alerts. |
| **Enterprise** (V3+) | Quote (target: $5–25K/year per org) | F500-adjacent (year 2+) | Self-hosted option + SAML/SCIM + SOC 2 Type II + custom retention + dedicated support. |

### Pricing anchors

| Comparable | Price | Why this anchors us |
|---|---|---|
| 1Password Individual | $3.99/mo ([source](https://tech-insider.org/1password-vs-bitwarden-2026/)) | We're at $7 — above because we sell agent-safety, not password storage. |
| Bitwarden Premium | $0.83/mo | Floor signal — secrets management is anchored low. |
| Doppler Team | $21/user/mo ([source](https://www.doppler.com/pricing)) | We're at $19 — slightly below; same buyer, different feature set. |
| Infisical Pro | $18/user/mo ([source](https://infisical.com/pricing)) | We're at $19 — same range; differentiation is runtime-opinionation. |
| GitHub Copilot | $10/mo | Reference price for "AI dev tool." We sit at $7 personal — below Copilot to avoid being a budget-line decision. |
| Cursor Pro | $20/mo | Above us. Our user pays Cursor first. |
| Composio Hobby | $29/mo + per-call | Above us. Our user does not want per-call billing. |

### Why $7, not $5 or $10

- Below $5: leaves money on the table; perceived value too low for security-sensitive tier.
- $7: hits the "less than Copilot" anchor while clearing meaningful margin after Stripe fees and infra cost.
- Above $10: bumps against Copilot decision-budget; conversion drops.

### Volume discounts

- 5–9 seats: 5% off → $18.05/seat
- 10–24 seats: 10% off → $17.10/seat
- 25+ seats: 15% off → $16.15/seat (and Slack-based account management starts)

### Lifetime founder license ($99 one-time)

- Sold only during the first 90 days of public launch.
- Cap: 100 licenses. After cap, removed.
- Gets: lifetime access to Personal Cloud features.
- Purpose: first $10K of revenue + buyer-list bootstrap; treated as a marketing expense, not annuity.

---

## 7. Revenue model & unit economics

### LTV math

| Segment | Price | Assumed lifetime | LTV | CAC ceiling (3:1) |
|---|---|---|---|---|
| Personal Cloud | $7/mo | 24 months (industry indie tool norm; conservative) | $168 | $56 |
| Teams (3-seat avg) | $19 × 3 = $57/mo | 18 months (small-team churn) | $1,026 | $342 |
| Observability add-on | $50/mo | 18 months | $900 | $300 |
| Enterprise design partner | $2–5K/mo | 12 months (year 1 cohort) | $24–60K | very high |

### Why paid acquisition is ruled out

- "AI agent" Google CPC: $4–11.
- "Credential management" Google CPC: $8–18.
- Converting at industry average 2% gives effective CAC of $200–900 per Personal Cloud signup. **LTV $168 makes this insolvent.**
- Conclusion: 100% of acquisition in year 1 must be organic (content, community, partnerships, referral).

### COGS sketch (Personal Cloud at scale)

- Cloudflare D1: free tier covers up to ~5GB; paid above.
- Cloudflare R2: $0.015/GB-month. Vault blobs are tiny (~10KB encrypted); 10K users × 10KB = 100MB total = $0.0015/mo. Negligible.
- Workers: $5/mo flat for 10M requests; we won't hit 10M for the first 6 months.
- Clerk auth: free up to 10K MAU. After 10K, $25/mo + $0.02/MAU.
- Stripe: 2.9% + 30¢ per transaction.
- **Estimated COGS at 5,000 paying Personal Cloud users: ~$200/mo. Gross margin ~99%.**

### Where the money goes (not COGS — opex)

- Security review (Trail of Bits / Latacora) at month 6: ~$15–25K one-time.
- SOC 2 Type II readiness (Vanta / Drata) at month 12: ~$10K/yr + audit cost ~$15K.
- Founder's time. (Not on books, but the binding constraint.)

---

## 8. Path to $10K → $50K → $100K MRR

Concrete monthly plan, anchored to T+0 = 2026-05-23. Gates are conjunctive (all bullets must be true to proceed).

### Month 0–3 — Land the launch (target: $0–500 MRR)

- Repo public; landing page live; Show HN posted; Product Hunt posted; newsletter cross-promo done.
- Sell 10 lifetime licenses at $99 = $990 one-time (counted as revenue but not MRR).
- ≥500 GitHub stars; ≥100 active CLI installs; ≥30 cloud-waitlist signups.
- **Gate to month 4+:** ≥250 stars, ≥30 active installs, Show HN post above the median (≥50 comments).

### Month 4–6 — Personal Cloud private beta (target: $500–2K MRR)

- Personal Cloud private beta with 50 invited users; ~30 convert to paid at $7/mo = $210/mo.
- Content cadence holding (12 posts shipped); 1 partnership trade closed.
- ≥1K GitHub stars; ≥200 active CLI installs.
- **Gate to month 7+:** ≥1K stars, ≥100 paying total, ≥$1K MRR, partnership signal real.

### Month 7–9 — Open Personal Cloud + Teams alpha (target: $2K–5K MRR)

- Personal Cloud public; pricing locked at $7/mo.
- Teams plan in private alpha with ~10 invited teams; 3–5 convert at avg $57/team = $285/mo Teams contribution.
- ≥2K stars; ≥500 active CLI installs; ≥350 paying Personal + 5 Teams = ~$2.7K MRR.

### Month 9–12 — Hit $10K MRR (target: $5K–10K MRR)

- Personal Cloud: 1,200 × $7 = $8.4K MRR.
- Teams: 10 × ~$57 = $570 MRR.
- Lifetime sales tail off (~$0 MRR contribution).
- Content compounding; organic search drives ≥30% of new installs.
- ≥3K stars; ≥1.5K active installs.
- **$10K MRR by month 12 is the hit case. $5–8K is the realistic.** Below $5K → reassess scope.

### Month 12–18 — Hit $50K MRR (target: $25K–50K MRR)

- Personal Cloud: 4,500 × $7 = $31.5K MRR.
- Teams: 75 × ~$57 = $4.3K MRR.
- Observability tier launches at month 14; ~50 active = $2.5K MRR.
- 2 enterprise design partners at $2K/mo = $4K MRR.
- ≥6K stars; ≥4K active installs; SOC 2 Type II readiness work begins.

### Month 18–24 — Hit $100K MRR (target: $50K–100K MRR)

- Personal Cloud: 7,000 × $7 = $49K MRR.
- Teams: 250 × ~$57 = $14.25K MRR.
- Observability: 500 × $50 = $25K MRR.
- Enterprise: 3–5 design partners × $3K avg = $12K MRR.
- **Total: ~$100K MRR.** This requires every gate to hit; bear case lands at $50K. Either is acceptable.

### Cross-check against `STRATEGY.md` §6

Numbers match. Personal Cloud is the largest line; Observability is the post-MCP-OAuth pivot that becomes the headline product by month 24.

---

## 9. The lever pulls (acquisition → activation → expansion)

| Lever | Stage | Mechanism | Expected impact |
|---|---|---|---|
| Show HN demo video | Acquisition | A 90-second clip showing key rotation mid-flight | 3–5× install rate during launch week |
| `agentpass import-claude` | Activation | One command imports existing Claude Code keys | -50% time-to-first-proxied-call |
| Shell init snippet | Habit | `agentpass shell-init >> ~/.zshrc` makes proxy persistent | +20% week-2 retention |
| 401-rotation in-CLI nudge | Expansion | After auto-rotation event, prompt to upgrade for "audit log retention >90d" | 5–10% Personal Cloud conversion |
| "Year in review" email | Advocacy | Quarterly stats email with shareable numbers ("AgentPass auto-rotated 47 keys for you this quarter") | +25% referral-driven installs by month 6 |
| Teammate-invite flow | Teams expansion | One paying user invites N teammates | 1.5× ARR multiplier per Teams account |

---

## 10. 7 / 30 / 90 day GTM milestones (concrete)

### Day 7 (2026-05-30)

- Domain `agentpass.dev` registered + Cloudflare Pages landing page live.
- Tally form for waitlist + "what agents do you run?" question.
- 1 X thread shipped: "Why your AI coding agent leaks API keys — and the localhost-proxy fix Infisical's Agent Vault ships with TODOs."
- 3 customer discovery calls booked from founder's X DMs.
- GitHub repo public, MIT-licensed, with polished README.

### Day 30 (2026-06-22)

- MVP functional in 10 hands (private alpha).
- Stripe Checkout live for $99 Lifetime Founder License.
- Weekly content cadence established and shipping (4 posts deep, ~8 threads, ~4 demos).
- Show HN draft written + peer-reviewed.
- First $1 of revenue (target: 5–10 lifetime sales = $495–$990).

### Day 90 (2026-08-21)

- Show HN posted, ranked, archived.
- Product Hunt posted, top 10.
- Newsletter cross-promo done (TLDR AI + Ben's Bites).
- Personal Cloud private beta open with 50 invited.
- ≥500 stars, ≥100 active installs, ≥10 paying ($100–500 MRR).

---

## 11. Kill criteria

Quantitative thresholds. Hit any single trigger → rotate the assets and shut down honourably.

| Gate | Date | Kill if any of these |
|---|---|---|
| Month 3 | 2026-08-23 | <100 stars; <20 active installs; <$50 MRR; Show HN below median (<50 comments) |
| Month 6 | 2026-11-19 | <1K stars; <100 paying customers; <$2K MRR; no partnership trades closed |
| Month 9 | 2027-02-23 | <2K stars; <300 paying; <$5K MRR; organic search impressions <1K/week |
| Month 12 | 2027-05-23 | <$10K MRR (any path) → drop to lifestyle mode (no new scope; harvest) |
| Month 18 | 2027-11-23 | <$25K MRR → stop adding scope; run as cashflow product |

### What "rotate the assets" means

If killed at month 3 or 6, the working code (Bun + TS vault + proxy + Claude Code shim) becomes an internal module across the portfolio:
- AudioPod (webhook signing, OpenAI proxying).
- AgentDrive (connector credentials).
- MoltWork (marketplace seller credentials).
- MailMolt (SMTP/IMAP credentials).
- AIGateWay (provider key brokering — direct fit).

So the engineering work has at least four downstream consumers regardless of GTM outcome. The kill is a GTM kill, not a code kill.

---

## 12. Founder commitments (the parts that fail if I don't honour them)

Self-imposed rules, surfaced for honesty:

1. **One deep blog post per week, every Wednesday, for 12 weeks straight.** Missing two in a row triggers a check-in with myself.
2. **No paid acquisition in year 1.** Period. CAC math says no.
3. **No enterprise sales in year 1.** Refer to 1Password / HashiCorp.
4. **Lock the kill gates and honour them.** With 30 ventures, sunk-cost continuation is the worst failure mode.
5. **Zero telemetry on secret values, ever.** This is a product invariant, not a marketing claim.
6. **Ship the MVP completion in ≤6 weeks of focused solo dev time** (V1 spec = current `SPEC.md` features + Cursor shim + multi-key pool). If it slips past 8 weeks, scope was wrong.

---

## 13. References

All data points and citations trace back to the source list in `STRATEGY.md`. This document does not introduce any market claim not already cited there.
