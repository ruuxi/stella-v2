# Agent Metadata

These files are the authoritative source for bundled agent capabilities and
prompt bodies. They use the established agent markdown shape: frontmatter
followed by a non-empty prompt body.

`maxAgentDepth` caps how deep a spawn chain may go, and the effective limit is
the minimum of the agent's own declared value and the one inherited from its
parent.

The backend prompt generator reads these files directly and strips the leading
frontmatter before producing the cloud/default publication snapshot. It
requires the remaining body to be normalized already; it does not trim or
rewrite prompt content. Capability frontmatter is never published by the
backend, and an active prompt may not have a duplicate backend-owned source.

Each body is the one prompt for that agent everywhere: desktop, the cloud
orchestrator, and cloud agents on every engine. Text that only holds somewhere
sits in a line-level condition fence; everything else is shared:

```md
<!-- when desktop -->
Only rendered on the desktop.
<!-- end -->
<!-- when cloud -->
Only rendered in the cloud.
<!-- end -->
<!-- when tool:ask_user -->
Only rendered when this turn has `ask_user`.
<!-- end -->
<!-- when !tool:ask_user -->
Only rendered when it does not.
<!-- end -->
```

Fences may nest. `tool:` names come from `STELLA_PROMPT_FENCE_TOOLS` in
`@stella/contracts/stella-prompts`, where `renderStellaPrompt` lives;
`history` means the turn's `code` carries the history client. The generator
fails on an unbalanced fence or an unknown condition.
