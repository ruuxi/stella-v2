import { TOOL_IDS } from "@stella/contracts/agent-runtime";
import { localNoResponse } from "./local-tool-overrides.js";

export type LocalToolDeps = {
  conversationId: string;
  signal?: AbortSignal;
};

type DispatchResult = { handled: true; text: string } | { handled: false };

/** Dispatch tools that execute locally without a backend round-trip. */
export async function dispatchLocalTool(
  toolName: string,
  _args: Record<string, unknown>,
  _deps: LocalToolDeps,
): Promise<DispatchResult> {
  if (toolName === TOOL_IDS.NO_RESPONSE) {
    return { handled: true, text: await localNoResponse() };
  }
  return { handled: false };
}
