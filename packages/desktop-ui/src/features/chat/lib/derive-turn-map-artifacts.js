/**
 * Per-turn map-card derivation.
 *
 * The orchestrator's `map` tool persists its resolved `map-route` artifact
 * onto the `tool_result` payload (`details: { map }`, spread by the worker —
 * see `runtime/kernel/tools/defs/map.ts`). When invoked through `node_repl`,
 * the REPL lifts the same artifact onto its outer result. Each successful
 * call on the turn becomes one inline interactive map card, in call order.
 *
 * Purely a renderer affordance derived from already-persisted events — the
 * model only sees the tool's text summary.
 */
import { isMapRouteArtifact, } from "@stella/contracts/map-artifact";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
/** Keep a runaway turn from stacking maps down the timeline. */
const MAX_MAP_CARDS_PER_TURN = 3;
export const deriveTurnMapArtifacts = (events) => {
    const cards = [];
    for (const event of events) {
        if (!event || event.type !== "tool_result")
            continue;
        const payload = event.payload;
        if (!payload ||
            (payload.toolName !== "map" && payload.toolName !== "node_repl"))
            continue;
        if (typeof payload.error === "string" && payload.error)
            continue;
        // Orchestrator-only affordance (absent agentType means orchestrator,
        // mirroring the worker's persistence default).
        const agentType = typeof payload.agentType === "string" ? payload.agentType : undefined;
        if (agentType !== undefined && agentType !== AGENT_IDS.ORCHESTRATOR) {
            continue;
        }
        const candidates = Array.isArray(payload.maps) ? payload.maps : [payload.map];
        for (let index = 0; index < candidates.length; index += 1) {
            const map = candidates[index];
            if (!isMapRouteArtifact(map))
                continue;
            cards.push({
                id: candidates.length === 1 ? event._id : `${event._id}:map:${index}`,
                map,
            });
            if (cards.length >= MAX_MAP_CARDS_PER_TURN)
                return cards;
        }
    }
    return cards;
};
