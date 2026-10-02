---
name: no-flicker-launch-ux
description: "UX rule from the user — nothing on screen may swap or flicker during startup or auth; hold the splash until live, let dialogs own their waits, no placeholders/toasts for system states"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5af2db59-ccd1-40ee-b236-69a446068c59
  modified: 2026-09-02T03:59:38.237Z
---

The user wants the desktop app to feel like a native/social app on launch: the static launch splash stays up until the shell is actually live (auth resolved, active conversation selected), then one clean reveal. Bounded at 2 s (`packages/desktop-ui/src/shell/launch-splash.ts`). Never replace mounted UI with a placeholder screen for a transient state, and do not use toasts or banners for system waits either; a dialog the user opened (e.g. sign-in) should hold its own finishing state until the underlying work (ownership migration) completes.

**Why:** on 2026-09-01 a one-time remount of the home surface (the root layout swapped the shell for "Getting Stella ready…" during a status query round-trip) was called "bad ux/sloppy"; the user rejected both a placeholder and a toast/banner alternative and endorsed the splash-hold approach ("that's definitely what they all do").
**How to apply:** any new loading/auth state in desktop-ui must keep existing content mounted; gate behaviour (disable composer, skip fenced queries) rather than swap views. Verify with the verify-stella harness and the `cloud.*` readiness timing log lines.
