# Memory lifecycle rollout gates

Batch 6 keeps memory input migration staged:

- The live Dream pass continues to consume the durable inbox. Orchestrator
  deltas are derived only after a clean live pass and written to
  `memories/memory_shadow.md`, which is neither resident nor a Recall source.
- `dream.deltaShadow: false` may disable diagnostics. No configuration value
  can enable production delta consumption: the runtime compile-time gate
  `DREAM_PRODUCTION_DELTA_CUTOVER_ENABLED` remains `false` until a later,
  separately certified cutover.
- Shadow coverage uses a persisted per-conversation watermark. The proposal
  is atomically written and fsynced before coverage advances; stable window
  identities recover a write-before-watermark crash without duplicating the
  proposal.
- Thread-summary conversation provenance is two-phase. Finalization records an
  unstamped inbox row; only the branch that durably persists the matching
  orchestrator report promotes it. Stale, superseded, adopted, or interrupted
  attempts therefore remain ineligible for future mechanical consumption.

The MEMORY lifecycle is also non-destructive:

- Dream supersedes an active workstream block in place. Removed text is first
  appended to `archive/MEMORY-superseded.md`; a failed journal write rejects
  the active edit.
- A completed Dream pass rotates only dated old blocks after `MEMORY.md`
  exceeds 300 KB, retaining at least five active blocks and targeting 240 KB.
  Archive copies land before the active rewrite. Files are replaced by
  same-directory temp, fsync, verified read-back, rename, and directory fsync.
- Quarterly archives and the supersede journal are Recall-searchable, along
  with `profile.md`. Dream may read archives but cannot edit them. Retired
  `memory_summary.md` and `memory_index.md` are never deleted.
- `memory-deep-consolidation-report.mjs` is read-only against the memories
  directory. It reports rotation and near-duplicate merge work; supervised
  merges still go through the ordinary Dream StrReplace jail.
