---
name: stella-v3-and-all-cloudflare
description: "2026-10-01 direction — build v3 (self-modifying app from source, native launchers) and move the whole backend to Cloudflare (delete Convex); Rust runtime port paused"
metadata:
  node_type: memory
  type: project
  originSessionId: 53cfdb37-b553-4192-9505-c698600ee951
  modified: 2026-10-01T20:19:45.624Z
---

Decided 2026-10-01 by the user:

- **All-Cloudflare.** Delete Convex entirely. Better Auth on D1 serves `/api/auth/*`, ownerId is the user id, and per-owner data lives in the owner's Durable Object (`OwnerGate`). D1 holds global data. Background work runs on alarms and Cron Triggers, and cross-owner analytics go to Basin. Greenfield, so nothing is migrated or kept for compatibility. Plan: `~/Documents/stella-v3-and-cloudflare-plan.md`.
- **v3.** v1's self-modifying model, rebuilt on v2's codebase without a dev server. The v1 repos live in `~/workspaces/old-stella`; context is in the `-home-alex-workspaces` memory `stella-self-mod-redesign`.
  - **Launcher:** native per OS — Swift/AppKit on macOS, C++/Win32 on Windows, C/GTK on Linux. Not Tauri.
  - **Apply:** happens automatically once the agent's preview verification passes. The user can undo; there is no Update card.
  - **Source:** distributed through Cloudflare Artifacts (git). Each user gets a fork of the upstream app repo, and updates are merges from upstream.
  - **Apps:** v2's plugin apps (`apps-sdk`, `create-stella-app`) fold into self-modification and are deleted.
- **Rust runtime port:** paused. Ignore it unless the user brings it back. v3 runs the TS runtime under Bun.

Progress (status lives in the plan doc): Cloudflare phases 1–3 and v3 steps 1–2 done 2026-10-01. Phase 3: billing ledger lives in each OwnerGate (`owner-store/domains/billing.ts`); gateway mints/settles via cloud-builder `BillingControl` service binding; Convex keeps abuse admission + a `billing_bridge` for still-metered features + an `owner_billing_plans` mirror the ledger pushes. Dev Stripe key is NOT test-mode — never create live Checkout/customers to verify. Step 2 shape: renderer served from source at `stella-app://desktop`; runtime + CLIs are Bun on `packages/runtime` TS; main/preload stay esbuild bundles rebuilt by `electron/start.mjs` when their fingerprint changes (chosen over Node module hooks for launch speed). `dev-electron-build.mjs --once` is now only the packaging build. The turn outbox still projects into Convex on purpose, because Convex readers in later phases need it and Convex must never call per-owner objects ([[do-placement-follows-first-caller]]). It is deleted once the last of those readers moves, not in phase 2.

**Why:** the user wants the self-modifying app as the product differentiator, and one platform instead of the Convex/Cloudflare split.
**How to apply:** don't propose Tauri, plugin apps or Rust runtime work. Treat Artifacts as the home of the source. See [[greenfield-two-plane-architecture]] (now superseded on the Convex half), [[world-do-decision]] and [[keep-plans-minimal]].
