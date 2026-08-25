import { isMapRouteArtifact } from "@stella/contracts/map-artifact";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";

const MAX_MAP_CARDS_PER_TURN = 3;
export const deriveTurnMapArtifacts = (events) => {
  const cards = [];
  for (const event of events) {
    if (!event || event.type !== "tool_result") continue;
    const payload = event.payload;
    if (
      !payload ||
      (payload.toolName !== "map" && payload.toolName !== "node_repl")
    )
      continue;
    if (typeof payload.error === "string" && payload.error) continue;

    const agentType =
      typeof payload.agentType === "string" ? payload.agentType : undefined;
    if (agentType !== undefined && agentType !== AGENT_IDS.ORCHESTRATOR) {
      continue;
    }
    const candidates = Array.isArray(payload.maps)
      ? payload.maps
      : [payload.map];
    for (let index = 0; index < candidates.length; index += 1) {
      const map = candidates[index];
      if (!isMapRouteArtifact(map)) continue;
      cards.push({
        id: candidates.length === 1 ? event._id : `${event._id}:map:${index}`,
        map,
      });
      if (cards.length >= MAX_MAP_CARDS_PER_TURN) return cards;
    }
  }
  return cards;
};
