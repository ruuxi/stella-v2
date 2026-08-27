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
