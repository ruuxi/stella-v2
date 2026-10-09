import {
  shutdownExternalEngineIntegrations,
  runExternalOrchestratorTurn,
  runExternalSubagentTurn,
} from "./agent-runtime/external-engines.js";
import type { SubagentRunResult } from "./agent-runtime/types.js";

export type {
  RuntimeExecutionSessionHandle,
  RuntimeReasoningEvent,
  RuntimeRunStartedEvent,
  RuntimeStreamEvent,
  RuntimeToolStartEvent,
  RuntimeToolEndEvent,
  RuntimeErrorEvent,
  RuntimeStatusEvent,
  RuntimeProviderLifecycleEvent,
  RuntimeEndEvent,
  RuntimeAssistantMessageEvent,
  RuntimeUserMessageEvent,
  RuntimeRunCallbacks,
} from "./agent-runtime/types.js";

import type {
  OrchestratorRunOptions,
  SubagentRunOptions,
} from "./agent-runtime/types.js";

/**
 * The runner's turns run on Claude Code only: Stella's own engine runs on
 * pi-durable (`@stella/agent`), which never reaches the runner. A turn that
 * would need another engine (a thread whose saved route is not Claude Code,
 * after the user moved off it) fails here instead of running anywhere else.
 */
const notClaudeCodeError = (): Error =>
  new Error(
    "This turn needs Claude Code: this computer runs agents on Claude Code, and Stella's own chat on pi.",
  );

export async function runOrchestratorTurn(
  opts: OrchestratorRunOptions,
): Promise<string> {
  const result = await runExternalOrchestratorTurn(opts);
  if (result === null) throw notClaudeCodeError();
  return result;
}

export async function runSubagentTask(
  opts: SubagentRunOptions,
): Promise<SubagentRunResult> {
  const result = await runExternalSubagentTurn(opts);
  if (result === null) throw notClaudeCodeError();
  return result;
}

export const shutdownSubagentRuntimes = (): void => {
  shutdownExternalEngineIntegrations();
};
