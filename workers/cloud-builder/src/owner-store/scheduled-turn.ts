/**
 * Starts a scheduled prompt as a turn: through the gate's `submit()` for a
 * named desktop, or as a cloud chat turn otherwise.
 */

import type { GateHostDependencies } from "./gate-host.js";
import type { ScheduledTurnStart } from "./registry.js";

export const startScheduledTurn = async (
  _deps: GateHostDependencies,
  _input: ScheduledTurnStart,
): Promise<void> => {
  throw new Error("Scheduled turns are not implemented yet.");
};
