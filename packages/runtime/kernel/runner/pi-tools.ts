/**
 * The desktop's Stella tools for the pi-durable harness (`@stella/agent`'s
 * `StellaToolHost`). An agent type is offered what its frontmatter allows and
 * the demoted tools it may reach, except the tools the harness has itself:
 * the agent tools and an agent's file and shell tools. A call runs the agent
 * loops' pipeline (`executeModelToolCall`), so hooks, validation, truncation,
 * spill and images behave as they do there.
 *
 * `code` is the persistent REPL the browser and computer-use skills drive:
 * its `tools.<name>` reach exactly these tools (demoted ones only through it),
 * and its kernel lives as long as the conversation's orchestrator, or the
 * agent, that calls it.
 */
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  collectVisibleDemotedTools,
  executeModelToolCall,
} from "../agent-runtime/tool-adapters.js";
import type { AgentToolResult } from "../agent-core/types.js";
import { buildDemotedCodeSuffix } from "../tools/code-catalog.js";
import { CODE_TOOL_NAME, toolRequiresExplicitApproval } from "../tools/code-tool.js";
import type { ToolMetadata } from "../tools/types.js";
import { resolveAgent, resolveAgentModelRoute } from "./context.js";
import type { RunnerContext } from "./types.js";

/** Tools the harness has itself, under these names or older ones (`STELLA_HARNESS_TOOL_NAMES` in `@stella/agent`). */
const HARNESS_TOOL_NAMES = new Set([
  "spawn_agent",
  "send_message",
  "pause_agent",
  "agent_status",
  "Bash",
  "exec_command",
  "write_stdin",
  "apply_patch",
  "Write",
  "Edit",
  "Grep",
  "multi_tool_use_parallel",
  "NoResponse",
  "node_repl",
  // Moving the chat is the old runtime's; pi places agents per conversation.
  "switch_destination",
]);

export type PiToolAgentType = "orchestrator" | "general";

export type PiToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  replay?: "safe" | "keyed" | "unsafe";
  codeOnly?: { searchTerms?: readonly string[] };
};

export type PiToolCall = {
  agentType: PiToolAgentType;
  name: string;
  callId: string;
  args: Record<string, unknown>;
  conversationId: string;
  /** The calling agent's thread id; the orchestrator has none. */
  agentId?: string;
  signal?: AbortSignal;
};

export type RunnerPiTools = {
  specs: (agentType: PiToolAgentType) => PiToolSpec[];
  run: (call: PiToolCall) => Promise<AgentToolResult<unknown>>;
};

const offeredTools = (
  context: RunnerContext,
  agentType: PiToolAgentType,
): ToolMetadata[] => {
  const allowed = new Set(resolveAgent(context, agentType)?.toolsAllowlist ?? []);
  const catalog = context.toolHost.getToolCatalog(agentType);
  const demoted = new Set(
    collectVisibleDemotedTools(catalog, undefined).map((tool) => tool.name),
  );
  return catalog.filter(
    (tool) =>
      !HARNESS_TOOL_NAMES.has(tool.name) &&
      // An agent reads files through the harness, wherever it runs.
      !(agentType === "general" && tool.name === "Read") &&
      (demoted.has(tool.name) || (!tool.demoted && allowed.has(tool.name))),
  );
};

/** One run id per orchestrator conversation or agent: `code` keeps its kernel across calls by it. */
const runIdFor = (owner: string) => `pi-${owner.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** Demoted tools reachable inside code: those without a top-level approval flow. */
const codeReachableDemoted = (offered: readonly ToolMetadata[]) =>
  offered.filter((tool) => tool.demoted && !toolRequiresExplicitApproval(tool.approval));

export const createRunnerPiTools = (context: RunnerContext): RunnerPiTools => ({
  specs: (agentType) => {
    const offered = offeredTools(context, agentType);
    return offered.map((tool) => ({
      name: tool.name,
      description:
        tool.name === CODE_TOOL_NAME
          ? `${tool.description}${buildDemotedCodeSuffix(codeReachableDemoted(offered))}`
          : tool.description,
      parameters: tool.parameters,
      ...(tool.replay ? { replay: tool.replay } : {}),
      ...(tool.demoted && !toolRequiresExplicitApproval(tool.approval)
        ? {
            codeOnly: {
              ...(tool.demoted.searchTerms ? { searchTerms: tool.demoted.searchTerms } : {}),
            },
          }
        : {}),
    }));
  },
  run: async (call) => {
    const offered = offeredTools(context, call.agentType);
    if (!offered.some((tool) => tool.name === call.name)) {
      return {
        content: [{ type: "text", text: `${call.name} is not available here.` }],
        details: undefined,
        isError: true,
      } as AgentToolResult<unknown>;
    }
    const agentType =
      call.agentType === "orchestrator" ? AGENT_IDS.ORCHESTRATOR : AGENT_IDS.GENERAL;
    const model = await resolveAgentModelRoute(context, agentType)
      .then(({ resolvedLlm }) => resolvedLlm.model)
      .catch(() => undefined);
    return await executeModelToolCall(
      {
        executionHost: "device",
        runId: runIdFor(call.agentId ?? call.conversationId),
        conversationId: call.conversationId,
        storageMode: "local",
        agentType,
        ...(call.agentId ? { agentId: call.agentId } : {}),
        deviceId: context.deviceId,
        stellaAppDir: context.stellaAppDir,
        stellaDataDir: context.stellaDataDir,
        store: context.runtimeStore,
        toolExecutor: async (toolName, toolArgs, toolContext, signal, onUpdate) =>
          await context.toolHost.executeTool(toolName, toolArgs, toolContext, signal, onUpdate),
        hookEmitter: context.hookEmitter,
        allowedToolNames: offered.map((tool) => tool.name),
        ...(model
          ? { imageCapTarget: { provider: model.provider, api: model.api, modelId: model.id } }
          : {}),
      },
      {
        toolName: call.name,
        toolCallId: call.callId,
        params: call.args,
        ...(call.signal ? { signal: call.signal } : {}),
      },
    );
  },
});
