import { sha256Hex } from "./hash.js";

/**
 * One immutable logical model operation per cloud app turn. Prompt bytes are
 * deliberately excluded: Convex binds them separately and rejects a changed
 * body under this same id before any provider request.
 */
export const cloudModelRequestId = async (turnId: string): Promise<string> => {
  const normalizedTurnId = turnId.trim();
  if (!normalizedTurnId) {
    throw new Error("Cloud model request requires a turn id.");
  }
  return `cloud-model:${await sha256Hex(normalizedTurnId)}`;
};
