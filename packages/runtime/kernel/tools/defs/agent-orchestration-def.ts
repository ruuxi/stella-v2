export const SPAWN_AGENT_MODEL_DESCRIPTION =
  "Optional model/engine override. Omit `model` to use the currently configured model and engine. Explicit selectors: `stella/default` for Stella; `openrouter/<provider>/<model>` for a provider model; `codex` for Codex with its configured model or `codex/gpt-5.6-sol` for GPT-5.6 SOL; `claude-code` for Claude Code with its configured model, `claude-code/fable` for Fable, or `claude-code/opus` for Opus. The listed Stella, Codex, and Claude Code selectors accept `:low`, `:medium`, `:high`, or `:xhigh` to override reasoning; omit the suffix to use the configured default.";

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
      workspace: {
        type: "string",
        enum: ["shared", "new", "fork"],
        description:
          "Workspace isolation for this cloud agent. shared edits the owner's world directly, fork starts from the current world, and new starts empty. Defaults to shared. new and fork are cloud-only.",
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

export const MERGE_WORKSPACE_TOOL_DESCRIPTOR = {
  name: "merge_workspace",
  description:
    "Merge an isolated cloud agent workspace into the shared world. Nothing merges automatically. Conflicts are reported and the isolated workspace wins each conflict.",
  parameters: {
    type: "object",
    properties: {
      thread_id: {
        type: "string",
        description: "Thread id whose isolated workspace should be merged.",
      },
      into: {
        type: "string",
        enum: ["shared"],
        description: "Merge destination. Only shared is currently supported.",
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
  MERGE_WORKSPACE_TOOL_DESCRIPTOR,
] as const;

export const AGENT_ORCHESTRATION_TOOL_NAMES: readonly string[] = [
  "spawn_agent",
  "send_input",
  "pause_agent",
  "agent_status",
  "merge_workspace",
];
