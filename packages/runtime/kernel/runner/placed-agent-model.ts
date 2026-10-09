/**
 * The model an agent placed on this device runs on: the requester's
 * `spawn_agent` model selector (`engine`, `engine/model` or a model id),
 * checked exactly as a local spawn checks it. A selector this device cannot
 * run throws, so the agent fails with the reason and the requester can tell
 * the user; it never silently runs on something else.
 */

import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  localSpawnSelectionError,
  parseSpawnAgentModel,
} from "../tools/state.js";
import type { AgentToolRequest, SpawnModelSupport } from "../tools/types.js";

export const resolvePlacedAgentModel = async (
  support: SpawnModelSupport,
  requested: string | undefined,
): Promise<
  Pick<
    AgentToolRequest,
    "model" | "spawnEngine" | "spawnReasoningEffort" | "modelConfigSnapshot"
  >
> => {
  const raw = requested?.trim();
  if (!raw) return {};
  const selection = parseSpawnAgentModel(raw, (modelName) => {
    try {
      support.validateSpawnModel(modelName);
      return true;
    } catch {
      return false;
    }
  });
  const selectionError = localSpawnSelectionError(selection);
  if (selectionError) throw new Error(selectionError);
  if (selection.kind === "model") {
    await support.validateSpawnModelWithMetadata(
      selection.model,
      selection.reasoningEffort,
    );
  }
  const spawnEngine =
    selection.kind === "engine" ? selection.engine : ({ engine: "default" } as const);
  const snapshot = await support.captureSpawnModelConfig({
    agentType: AGENT_IDS.GENERAL,
    spawnEngine,
    ...(selection.kind === "default" ? { useConfiguredEngine: true } : {}),
    ...(selection.kind === "model" ? { model: selection.model } : {}),
    ...(selection.reasoningEffort
      ? { spawnReasoningEffort: selection.reasoningEffort }
      : {}),
  });
  return {
    ...(selection.kind === "model" ? { model: selection.model } : {}),
    ...(selection.kind !== "default" ? { spawnEngine } : {}),
    ...(selection.reasoningEffort
      ? { spawnReasoningEffort: selection.reasoningEffort }
      : {}),
    ...(snapshot ? { modelConfigSnapshot: snapshot } : {}),
  };
};
