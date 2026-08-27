export type AgentCheckpointResult = {
  checkpointPolicy?: "preserve_prior";
};

/**
 * Pre-agent authority failures must not replace the checkpoint they inspected.
 * On a first turn, the same rule prevents an empty failed sandbox becoming a
 * durable "restored" workspace that can never retry fresh-drive hydration.
 */
export const shouldCreateAgentCheckpoint = (
  result: AgentCheckpointResult,
): boolean => result.checkpointPolicy !== "preserve_prior";
