# AgentPass 30-Day Validation Sprint

## Decision

**Conditional GO for a 30-day validation sprint. NO-GO for the full six-month venture plan as written.**

The market pain is real, but the repo must prove the core technical wedge before cloud sync, Teams, Observability, enterprise design partners, or $50K+ MRR planning.

## Sprint Wedge

Focus on one workflow:

```bash
agentpass run claude
```

The sprint succeeds only if a solo developer can route agent traffic through AgentPass, keep raw credentials out of the agent config, inspect a local audit log, and understand the current HTTPS limitations without reading source code.

## Current Product Reality

- Implemented: encrypted local vault with AES-256-GCM, PBKDF2 key derivation, and password verification.
- Implemented: direct HTTP proxy placeholder substitution for configured credential headers.
- Implemented: HTTPS `CONNECT` tunneling so `HTTPS_PROXY` does not break normal HTTPS clients.
- Implemented: local audit events for direct proxy requests and CONNECT tunnels.
- Not yet implemented: trusted TLS MITM for rewriting headers inside standard HTTPS `CONNECT` traffic.
- Not yet implemented: key rotation, multi-key pools, cloud sync, Teams, Observability, signed releases, fuzzing, or a security review.

The critical technical blocker is HTTPS header rewriting. Standard HTTPS proxy clients use `CONNECT`; after the tunnel is established, request headers are encrypted and cannot be substituted unless AgentPass installs a trusted local CA and performs TLS interception. Until that is working and tested, the product must not claim that arbitrary HTTPS agent traffic can be credential-brokered at the wire.

## Day-30 Exit Criteria

Continue only if all of these are true:

- Public-quality README and demo for the Claude Code or Cursor wedge.
- Tests cover vault encryption/decryption, wrong password failure, placeholder substitution, missing secret handling, audit logging, and HTTPS CONNECT tunneling.
- A credible HTTPS credential-brokering story is complete: either tested TLS MITM with a clear trust flow, or a narrower runtime-specific integration that avoids claiming generic HTTPS rewriting.
- At least 10 target users have seen the demo, and at least 3 say they would replace their current workaround with AgentPass.
- Direct comparison against Infisical Agent Vault is written up on setup time, runtime support, local-first posture, and security caveats.

Kill or rotate if any of these are true:

- No tested solution for the HTTPS credential-brokering gap.
- No credible demo that survives hostile prompt/key-exfiltration scrutiny.
- No evidence that the target wedge prefers AgentPass over Infisical Agent Vault or existing `.env`/1Password workflows.

## Deferred Until Pull Exists

- Personal Cloud.
- Teams.
- Observability.
- Enterprise design partners.
- SOC 2, SAML, SCIM, or compliance positioning.
- $50K-$100K MRR planning.

For the next 30 days, the only revenue assumption worth using is: if this works, $2K-$8K MRR by month 12 is the realistic first-order target. Anything above that depends on OSS/community pull that does not exist yet.
