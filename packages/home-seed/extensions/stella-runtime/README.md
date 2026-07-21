# Stella Runtime Extension

This is Stella's Pi-style runtime extension, seeded into the Stella home.

## What lives here

- `index.ts`: registers backend-synchronized agent definitions from `~/.stella/agents`
- `hooks/*.ts`: Stella-specific lifecycle policy loaded from the home extension
- `agent-metadata/*.md`: local capability metadata joined to backend-owned prompt bodies during sync; `manager.md` also carries the transitional bundled default used only when a prompt manifest predates Manager

## Why it exists

Stella's runtime was already partially derived from Pi, but core agent setup had drifted back into hardcoded runtime code. This extension keeps the agent layer shaped like Pi while leaving prompt ownership with the backend:

- prompt bodies live in `stella-backend/prompts/stella-runtime/`
- synchronized, user-editable copies live in `~/.stella/agents/` and `~/.stella/prompts/`
- the extension entry point registers them
- the runtime seeds this directory on first run and discovers it from
  `~/.stella/extensions`
- extension code calls the injected runtime API and never imports repo-relative
  kernel modules

## Stella-specific differences

- Stella keeps thread/session state in SQLite, but the schema now mirrors Pi's append-only session structure more closely with session headers and linked entries.
- Stella keeps background execution in the local task manager. Pi's upstream extension examples show delegation patterns, but Stella still owns fire-and-forget task execution.
- Stella's provider surface stays OpenAI-chat-compatible for the app, while the backend Stella provider now executes through the Responses API upstream.

## Reference

- Pi docs: `pi-mono/packages/coding-agent/docs`
- Pi subagent example: `pi-mono/packages/coding-agent/examples/extensions/subagent`
