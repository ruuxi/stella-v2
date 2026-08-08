# Stella Runtime Prompts

This directory is the canonical source of truth for Stella's synchronized
system prompts.

- Edit agent prompt bodies in `agents/`.
- Edit internal and personality prompts in `prompts/`.
- Run `bun run prompts:sync-defaults` to regenerate the checked-in Convex
  default snapshot.
- Run `bun run prompts:publish` only when the updated prompt set should be
  published.

The `stella` client repository contains capability-bearing agent metadata, not
prompt bodies. Do not add prompt copies or prompt fallbacks there.
