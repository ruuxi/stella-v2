export const SPAWN_AGENT_MODEL_DESCRIPTION =
  "Optional model/engine override. Omit `model` to use the currently configured model and engine. Explicit selectors: `stella/default` for Stella; `openrouter/<provider>/<model>` for a provider model; `codex` for Codex with its configured model or `codex/gpt-6-sol` for GPT-6 Sol; `claude-code` for Claude Code with its configured model, `claude-code/fable` for Fable, or `claude-code/opus` for Opus. The listed Stella, Codex, and Claude Code selectors accept `:low`, `:medium`, `:high`, or `:xhigh` to override reasoning; omit the suffix to use the configured default.";

export const SPAWN_AGENT_TOOL_DESCRIPTOR = {
  name: "spawn_agent",
  description:
    "Start a background agent for work that needs its own owner. Continue related work with an existing agent through send_input, even when it is busy. Agents can delegate independent parts to subagents. The immediate result means work has started; completion arrives in [Agent completed].",
  parameters: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description:
          "A short name for the project or area of work. It becomes the thread's name; put distinguishing words first.",
      },
      prompt: {
        type: "string",
        description:
          "The request and any necessary context the agent does not have. Keep simple requests short; preserve explicit constraints and leave the approach to the agent.",
      },
      model: {
        type: "string",
        description: SPAWN_AGENT_MODEL_DESCRIPTION,
      },
    },
    required: ["description", "prompt"],
  },
} as const;

export const SEND_INPUT_TOOL_DESCRIPTOR = {
  name: "send_input",
  description:
    "Send new or changed instructions to an existing agent, including while it is busy. Preserves the thread's context. A successful result means the input was accepted, not that the work finished; completion arrives in [Agent completed].",
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
} as const;

export const PAUSE_AGENT_TOOL_DESCRIPTOR = {
  name: "pause_agent",
  description:
    "Pause a running agent by thread_id. Resume the same thread later with send_input.",
  parameters: {
    type: "object",
    properties: {
      thread_id: {
        type: "string",
        description: "Durable thread id of the agent to pause.",
      },
      reason: {
        type: "string",
        description: "Optional explanation for why the agent is being paused.",
      },
    },
    required: ["thread_id"],
  },
} as const;

export const AGENT_STATUS_TOOL_DESCRIPTOR = {
  name: "agent_status",
  description:
    "Read an agent's status, recent assistant messages, latest tool call, and timestamps. Active means executing a turn; paused means idle and resumable. Does not interrupt or send input to the agent.",
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
} as const;

export const AGENT_ORCHESTRATION_TOOL_DESCRIPTORS = [
  SPAWN_AGENT_TOOL_DESCRIPTOR,
  SEND_INPUT_TOOL_DESCRIPTOR,
  PAUSE_AGENT_TOOL_DESCRIPTOR,
  AGENT_STATUS_TOOL_DESCRIPTOR,
] as const;

export const AGENT_ORCHESTRATION_TOOL_NAMES: readonly string[] = [
  "spawn_agent",
  "send_input",
  "pause_agent",
  "agent_status",
];

/**
 * Replay policies (`ToolReplayPolicy` in ../types.ts) shared by every host.
 * `spawn_agent` is per host: the cloud derives the child's thread and turn
 * ids from the tool call id (keyed), the desktop's local spawn mints a random
 * thread key (unsafe), so each host declares its own.
 */
/** A status snapshot; no effect. */
export const AGENT_STATUS_TOOL_REPLAY = "safe" as const;
/** Pausing an agent that is already paused or finished is a no-op. */
export const PAUSE_AGENT_TOOL_REPLAY = "safe" as const;
/**
 * A steer is keyed by an id derived from the tool call, but the child deletes
 * the mailbox row once it consumes it, so a rerun after consumption delivers
 * the instruction twice.
 */
export const SEND_INPUT_TOOL_REPLAY = "unsafe" as const;
