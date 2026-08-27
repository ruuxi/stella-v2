import { isMapRouteArtifact, } from "@stella/contracts/map-artifact";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";

const MAX_MAP_CARDS_PER_TURN = 3;
export const deriveTurnMapArtifacts = (events) => {
    const cards = [];
    for (const event of events) {
        if (!event || event.type !== "tool_result")
            continue;
        const payload = event.payload;
        if (!payload || payload.toolName !== "map")
            continue;
        if (typeof payload.error === "string" && payload.error)
            continue;

        const agentType = typeof payload.agentType === "string" ? payload.agentType : undefined;
        if (agentType !== undefined && agentType !== AGENT_IDS.ORCHESTRATOR) {
            continue;
        }
        if (!isMapRouteArtifact(payload.map))
            continue;
        cards.push({ id: event._id, map: payload.map });
        if (cards.length >= MAX_MAP_CARDS_PER_TURN)
            break;
    }
    return cards;
};
