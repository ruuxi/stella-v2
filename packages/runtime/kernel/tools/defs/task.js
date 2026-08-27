import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { handleAgentStatus, handleSendInput, handleSpawnAgent, } from "../state.js";
const AGENT_SPAWNERS = [
    AGENT_IDS.ORCHESTRATOR,
    AGENT_IDS.GENERAL,
];

export const AGENT_ORCHESTRATION_TOOL_NAMES = [
    "spawn_agent",
    "send_input",
    "pause_agent",
    "agent_status",
];
export const SPAWN_AGENT_TOOL_NAME = "spawn_agent";

export const withoutSpawnAgentModelParam = (tool) => {
    if (tool.name !== SPAWN_AGENT_TOOL_NAME)
        return tool;
    const parameters = tool.parameters;
    const properties = parameters?.properties;
    if (!properties || !("model" in properties))
        return tool;
    const { model: _model, ...restProperties } = properties;
    return {
        ...tool,
        parameters: {
            ...parameters,
            properties: restProperties,
            ...(Array.isArray(parameters.required)
                ? { required: parameters.required.filter((name) => name !== "model") }
                : {}),
        },
    };
};
export const SPAWN_AGENT_MODEL_DESCRIPTION =
    "Optional model/engine override. Omit `model` to use the currently configured model and engine. Explicit selectors: `stella/default` for Stella; `openrouter/<provider>/<model>` for a provider model; `codex` for Codex with its configured model or `codex/gpt-5.6-sol` for GPT-5.6 SOL; `claude-code` for Claude Code with its configured model, `claude-code/fable` for Fable, or `claude-code/opus` for Opus. The listed Stella, Codex, and Claude Code selectors accept `:low`, `:medium`, `:high`, or `:xhigh` to override reasoning; omit the suffix to use the configured default.";
export const createAgentTools = (stateContext) => [
    {
        name: "spawn_agent",
        agentTypes: AGENT_SPAWNERS,
        description: "Spawn an agent for a specific, well-scoped background task. Give it all relevant context and instructions. For multi-part or decomposable work, tell that agent it may spawn its own subagents as appropriate, or direct it when parallel pieces warrant it. Most tasks stay with one agent. The immediate tool result means the agent has started, not finished; its completed result arrives in [Agent completed].",
        parameters: {
            type: "object",
            properties: {
                description: {
                    type: "string",
                    description: "A concise 2–3 word domain name. It becomes the thread's name — put distinguishing words first.",
                },
                prompt: {
                    type: "string",
                    description: "Detailed instructions for the sub-agent. This is the agent's only context.",
                },
                model: {
                    type: "string",
                    description: SPAWN_AGENT_MODEL_DESCRIPTION,
                },
            },
            required: ["description", "prompt"],
        },
        execute: async (args, context) => handleSpawnAgent(stateContext, args, context),
    },
    {
        name: "send_input",
        agentTypes: AGENT_SPAWNERS,
        description: "Steer, update, continue, or add work that benefits from an existing agent's context. A successful tool result means the agent has started or resumed working, not finished; its completed result arrives in [Agent completed].",
        parameters: {
            type: "object",
            properties: {
                thread_id: {
                    type: "string",
                    description: "Durable thread id to continue or revise.",
                },
                message: {
                    type: "string",
                    description: "Follow-up instruction to deliver to the agent.",
                },
            },
            required: ["thread_id", "message"],
        },
        execute: async (args, context) => handleSendInput(stateContext, args, context),
    },
    {
        name: "pause_agent",
        agentTypes: AGENT_SPAWNERS,
        description: "Pause a running sub-agent, or a whole group of related agents at once by passing a grp-… group id. The same thread can be resumed later by calling send_input with its thread_id.",
        parameters: {
            type: "object",
            properties: {
                thread_id: {
                    type: "string",
                    description: "Durable thread id to pause, or a grp-… group id to pause every agent in that group.",
                },
                reason: {
                    type: "string",
                    description: "Optional explanation for why the agent is being paused.",
                },
            },
            required: ["thread_id"],
        },
        execute: async (args, context) => handleSpawnAgent(stateContext, { ...args, action: "cancel" }, context),
    },
    {
        name: "agent_status",
        agentTypes: AGENT_SPAWNERS,
        description: "READ-ONLY status snapshot of a sub-agent thread: its live status (active = executing a turn right now, paused = idle but resumable), its last few assistant messages, and its most recent tool call, each timestamped alongside the current time. It NEVER interrupts, messages, or resumes the agent — use it to check on a running or paused thread; never use send_input just to ask for status.",
        parameters: {
            type: "object",
            properties: {
                thread_id: {
                    type: "string",
                    description: "Durable thread id of the agent to check.",
                },
            },
            required: ["thread_id"],
        },
        execute: async (args, context) => handleAgentStatus(stateContext, args, context),
    },
];
