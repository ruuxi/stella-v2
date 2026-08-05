# Agent Metadata

These files define local capabilities such as tools and maximum agent depth.
They use the established agent markdown shape: frontmatter followed by a
non-empty body. Capability-only entries use a short HTML comment as that body.

`maxAgentDepth` caps how deep a spawn chain may go, and the effective limit is
the minimum of the agent's own declared value and the one inherited from its
parent. The Orchestrator declares `1`: it works directly and may create
one level of General agents. A top-level General still declares `2` for the
standalone General -> subagent mode.

Canonical prompt bodies normally live in the sibling `stella-backend`
repository and synchronize into `~/.stella/`. An entry with
`promptSource: bundled` intentionally owns its prompt in this packaged line;
remote reconciliation keeps the bundled body while preserving local edits.
