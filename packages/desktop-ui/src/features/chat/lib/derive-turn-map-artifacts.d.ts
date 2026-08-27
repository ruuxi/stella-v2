/**
 * Per-turn map-card derivation.
 *
 * The orchestrator's `map` tool persists its resolved `map-route` artifact
 * onto the `tool_result` payload (`details: { map }`, spread by the worker —
 * see `runtime/kernel/tools/defs/map.ts`). When invoked through `code`, the
 * runtime lifts the same artifact onto its outer result. Each successful
 * call on the turn becomes one inline interactive map card, in call order.
 * Legacy `node_repl` rows remain readable after the public rename to `code`.
 *
 * Purely a renderer affordance derived from already-persisted events — the
 * model only sees the tool's text summary.
 */
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import type { MapRouteArtifact } from "@stella/contracts/map-artifact";
export type TurnMapArtifact = {
  /** Stable key (the tool_result event id, with a batch index when needed). */
  id: string;
  map: MapRouteArtifact;
};
export declare const deriveTurnMapArtifacts: (
  events: readonly EventRecord[],
) => TurnMapArtifact[];
