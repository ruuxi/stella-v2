---
name: abuse-protection-shipped
description: Abuse protection phases 0-2 shipped 2026-09-02 (grants at mint, tier breakers, Turnstile, identity ladder, ASN policy, DPoP device-bound capabilities, Sybil counters, risk cron); deploy checklist in the Documents proposal
metadata:
  type: project
---

On 2026-09-02 the three abuse-protection stages landed on master (Stage A `16d58e536`, Stage B `89163cd88`, Stage C the following `feat(abuse): phase 2` commit). Design, numbers, and the "Implementation status" with the deploy checklist live in `/home/alex/Documents/stella-abuse-protection-proposal.md` (sections 5, 7, 12). The repo no longer has a `docs/` directory (removed upstream in `a3a0449a6`), so that file is the operating reference.

**Why:** Anonymous and signed-in Free stay available by product decision; protection is layered (ledger correctness, global breakers, identity cost ladder, network policy, device proof, detection).

**How to apply:** Before deploying, create the gateway/builder KV namespaces (`OWNER_ENFORCEMENT`, `ASN_POLICY`) and set `TURNSTILE_SECRET_KEY`, the public site keys, and `STELLA_ANON_LIFETIME_LIMIT_USD`. Known deliberate choices: a `challenged` owner passes a Turnstile on every mint until the status expires (no auto-clear); mobile has NO Turnstile and proves app integrity instead (App Attest / Play Integrity via `@expo/app-integrity`, verified in Convex with `node-app-attest` and Google's decode API); the user's stated reasoning is that mobile abuse should require real phones. Dev deployments run `STELLA_APP_INTEGRITY_MODE=off` so simulators work. Related: [[greenfield-two-plane-architecture]], [[no-users-greenfield-ok]], [[docs-go-to-home-documents]].

- 2026-09-02 (6b99729da): capability-mint challenges (sybil counters, risk-cron `challenged`) only fire while `TURNSTILE_SECRET_KEY` is set. Dev leaves it unset, so challenges are off there; set it plus `VITE_TURNSTILE_SITE_KEY` to test the flow. Verify-stella launches are fresh profiles; use `session launch --reuse` to keep one anonymous user per machine, omit it for a never-seen user.
