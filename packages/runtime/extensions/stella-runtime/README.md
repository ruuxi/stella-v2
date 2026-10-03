# Stella Runtime Extension

This is Stella's built-in Pi-style runtime extension.

## What lives here

- `index.ts`: registers Stella's bundled agent definitions.
- `agent-metadata/*.md`: authoritative capability frontmatter and prompt body
  for each active bundled agent.
- `prompts/*.md`: authoritative active non-agent prompt bodies.

## Shipping a prompt change

Edit the file here, run `bun run prompts:sync-defaults` (CI's
`prompts:check-defaults` fails if the cloud-builder copy drifts), and deploy
cloud-builder. The cloud worker imports the generated module
(`workers/cloud-builder/src/prompts/defaults.generated.ts`), and the desktop
runtime reads cloud-builder's `/api/stella/prompts` with a conditional GET on
every orchestrator turn (`kernel/prompts/remote-prompts.ts`), so the change
reaches every client on the next message. The bundled files are the
offline/BYOK fallback and the source the publication is generated from;
nothing is written to the user's data dir.

## Why it exists

Stella's runtime was already partially derived from Pi, but core agent setup had
drifted back into hardcoded runtime code. This extension keeps the agent layer
shaped like Pi and remains authoritative for active bundled prompts:

- the cloud-builder generator reads prompt bodies from this extension;
- it strips capability frontmatter from agent metadata before publication;
- capability frontmatter remains runtime-only and never enters the served
  prompt manifest;
- the runtime loader discovers the extension from `runtime/extensions`

There is one orchestrator definition. The retired direct/orchestrated dual-mode
files and the retired Manager, Schedule, Dream, and install-update agents are
not prompt-manifest compatibility entries.

## Stella-specific differences

- Stella keeps thread/session state in SQLite, but the schema now mirrors Pi's append-only session structure more closely with session headers and linked entries.
- Stella keeps background execution in the local task manager. Pi's upstream extension examples show delegation patterns, but Stella still owns fire-and-forget task execution.
- Stella's provider surface stays OpenAI-chat-compatible for the app, while the backend Stella provider now executes through the Responses API upstream.

## Reference

- Pi docs: `/Users/rahulnanda/projects/pi-mono/packages/coding-agent/docs`
- Pi subagent example: `/Users/rahulnanda/projects/pi-mono/packages/coding-agent/examples/extensions/subagent`
- Stella reference example: `../examples/subagent-reference`
