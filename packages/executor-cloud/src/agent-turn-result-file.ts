/**
 * Root-only handoff between the trusted cloud executor and Builder.
 *
 * `/workspace` itself is root-owned and is not one of the checkpointed tool
 * roots (`/workspace/drive`, `/workspace/stella`, `/workspace/projects/...`).
 * Model-controlled UID 42424 therefore cannot create or replace this file.
 */
export const CLOUD_AGENT_TURN_RESULT_PATH =
  "/workspace/.stella-agent-turn-result.json";
