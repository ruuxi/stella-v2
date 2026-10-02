/**
 * Kept in its own dependency-free module so workerd hosts (the cloud
 * orchestrator and resident agent) can share the type without pulling the
 * Node-facing tool host types into their build.
 */

/**
 * Replay classification for a tool call whose process died before it
 * reported a result (pi-durable's `replay`, plus Stella's `keyed`):
 *
 *   - `safe`: rerunning it with the same arguments has no effect beyond
 *     producing a result again (reads, searches, status snapshots).
 *   - `keyed`: it has an effect, but the effect is idempotent by the tool
 *     call id (a ledger, an idempotency key, or an id derived from it), so a
 *     rerun finds the first attempt's effect instead of repeating it.
 *   - `unsafe`: the effect may have happened and a rerun could repeat it.
 *     Recovery answers the call as interrupted, never reruns it.
 *
 * Recovery reruns `safe` and `keyed` calls and interrupts `unsafe` ones.
 */
export type ToolReplayPolicy = "safe" | "keyed" | "unsafe";
