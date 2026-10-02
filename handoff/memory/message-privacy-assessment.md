---
name: message-privacy-assessment
description: "2026-09-10 assessment of how far Stella can keep message text unreadable by the company; full E2EE ruled out, client-held key with transient server use recommended"
metadata:
  type: project
---

On 2026-09-10 the user asked how to keep cloud-stored messages unreadable by the company, ideally without an extra roundtrip. Assessment in `~/Documents/stella-message-privacy-options.md`. Findings: the conversation DO composes the prompt server-side, so true E2EE means moving the orchestrator loop to the client (rejected as a rewrite). Recommended: hygiene now (delete legacy Convex message tables, drop `lastPreview`, encrypt gateway replay cache), then client-held conversation key carried in the existing turn POST, ciphertext journal with client-side decryption of the fan-out, blind-index (HMAC token) recall, queued offline wakes by default with an opt-in key lease. No decision taken yet.

**Why:** the product promise (cloud owns the turn, agents finish while apps are closed) is incompatible with the server never seeing plaintext.
**How to apply:** when privacy or encryption work starts, start from that doc's option C ordering; see [[recall-search-in-conversation-do]], [[greenfield-two-plane-architecture]], [[no-users-greenfield-ok]].
