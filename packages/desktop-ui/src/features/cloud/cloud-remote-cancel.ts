import type { TurnPhase } from "./conversation-protocol";

export type TurnPhaseObservation = {
  turnId: string;
  phase: TurnPhase | null;
};

/**
 * Advances the observed phases for turns launched by this desktop.
 *
 * A cancellation is actionable only when this renderer previously observed
 * the same turn running. Newly discovered historical canceled rows seed the
 * map without producing an action.
 */
export const advanceOwnDeviceTurnPhases = (
  previous: ReadonlyMap<string, TurnPhase | null>,
  observations: readonly TurnPhaseObservation[],
  ownTurnPrefix: string,
): {
  phases: ReadonlyMap<string, TurnPhase | null>;
  canceledTurnIds: readonly string[];
} => {
  const phases = new Map(previous);
  const canceledTurnIds: string[] = [];

  for (const observation of observations) {
    if (!observation.turnId.startsWith(ownTurnPrefix)) continue;
    const previousPhase = phases.get(observation.turnId);
    if (previousPhase === "started" && observation.phase === "canceled") {
      canceledTurnIds.push(observation.turnId);
    }
    phases.set(observation.turnId, observation.phase);
  }

  return { phases, canceledTurnIds };
};
