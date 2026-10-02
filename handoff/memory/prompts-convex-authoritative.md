---
name: prompts-convex-authoritative
description: 2026-09-02 decision: system prompts are edited in the repo bundle, published via Convex, and read by desktop + cloud per turn with a conditional GET; no home-file sync, no user overrides; also the Aug 26 merge regression that dropped all orchestrator tools
metadata:
  type: project
---

Decision on 2026-09-02: one source of truth for system prompts, applied everywhere.

- Edit `packages/runtime/extensions/stella-runtime/agent-metadata/*.md` or `prompts/*.md`, run `bun run prompts:sync-defaults`, deploy Convex (`cd packages/backend && bunx convex dev --once` for dev). CI `prompts:check-defaults` fails on drift.
- Desktop runtime: `kernel/prompts/remote-prompts.ts` fetches `/api/stella/prompts` with `If-None-Match` at startup, on site-URL change, and on every orchestrator turn (stale-while-revalidate, never blocking). `loadAgentSystemPrompt` and `readRuntimePrompt` prefer the served body; bundle is the offline/BYOK fallback; disk cache at `<data>/cache/prompt-manifest.json`. Cloud worker (`cloud-prompt.ts`) revalidates per turn too (5-minute gate removed).
- Cloud journal (`workers/cloud-builder/src/journal.ts` `stampUserMessageSequences`) stamps visible user messages with `<system-reminder>message #seq</system-reminder>` when building model history, so cloud-mode replies can cite `#seq`; journal payloads stay raw.
- The old home-file sync (`prompt-manifest-sync.ts`, `personality-sync.ts`, hash/override semantics) was deleted. User prompt presets (`~/.stella/prompts/<agent>/*.md`) still win when selected.
- Regression found the same day: merge `0fd31a775` (Aug 26) pointed the extension loader at `<data>/extensions`, which nothing seeds, so the bundled `stella-runtime` extension (4 agents, 5 hooks) never loaded and the orchestrator ran with the fallback prompt and no tools. Fixed by restoring `resolveRuntimeSourceAsset("extensions")` in `runner/context.ts`.

**Why:** the user wants to change the prompt in one place and have it apply to desktop and cloud within a message, without desktop releases, and explicitly rejected hash-merge/user-override machinery ("I don't want any syncing").
**How to apply:** never reintroduce home-file prompt sync; keep the bundle as fallback only; keep the loader on the bundled extensions dir. See [[reply-refs-and-focus-view]].
