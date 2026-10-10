export const SPAWN_AGENT_MODEL_DESCRIPTION =
  "Optional model/engine override. Omit `model` to use the currently configured model and engine. Explicit selectors: `stella/default` for Stella; `openrouter/<provider>/<model>` for a provider model; `codex` for Codex with its configured model or `codex/gpt-6.1-sol` for GPT-6.1 Sol; `claude-code` for Claude Code with its configured model, `claude-code/fable` for Fable, or `claude-code/opus` for Opus. The listed Stella, Codex, and Claude Code selectors accept `:low`, `:medium`, `:high`, or `:xhigh` to override reasoning; omit the suffix to use the configured default.";

/** Where a `spawn_agent` call asked its agent to run. */
export type SpawnDestination =
  | { kind: "here" }
  | { kind: "cloud" }
  | { kind: "device"; deviceId: string };

/** Blank means where the caller runs; any other value names a device. */
export const parseSpawnDestination = (value: unknown): SpawnDestination => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return { kind: "here" };
  if (text.toLowerCase() === "cloud") return { kind: "cloud" };
  return { kind: "device", deviceId: text };
};

export const SPAWN_AGENT_TOOL_DESCRIPTOR = {
  name: "spawn_agent",
  description:
    "Start a background agent for work that needs its own owner. Continue related work with an existing agent through send_message, even when it is busy. Agents can delegate independent parts to subagents. The immediate result means work has started; completion arrives in [Agent completed].",
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
      destination: {
        type: "string",
        description:
          'Where the agent runs: "cloud", or a device_id from the connected devices list. Omit to run it where you are.',
      },
      directory: {
        type: "string",
        description:
          "Absolute path of the directory the agent starts in, such as the project the work is about (so not with destination). Its AGENTS.md, when there is one, is added to the agent's context. The agent can still work anywhere. Omit it to start the agent in a fresh folder of its own.",
      },
    },
    required: ["description", "prompt"],
  },
} as const;

export const SEND_MESSAGE_TOOL_DESCRIPTOR = {
  name: "send_message",
  description:
    'Message an agent or Stella session by thread_id, including while it is busy; it reads the message before its next step. To an agent you started, the message is an instruction: steer it, correct it, or resume it on the same thread after it finished or was paused. To anyone else (Stella, the agent that started you, teammates, other sessions) it arrives as a note from you, which they weigh against their own work and can answer with send_message. "stella" reaches the Stella you work for. A successful result means the message was delivered, not that any work finished; completion still arrives in [Agent completed]. agent_status without a thread_id lists who you can reach.',
  parameters: {
    type: "object",
    properties: {
      thread_id: {
        type: "string",
        description:
          'Who to message: a thread_id from agent_status, or "stella".',
      },
      message: {
        type: "string",
        description:
          "The message. To your own agent, send only what is new or changed.",
      },
    },
    required: ["thread_id", "message"],
  },
} as const;

export const PAUSE_AGENT_TOOL_DESCRIPTOR = {
  name: "pause_agent",
  description:
    "Pause a running agent by thread_id. Resume the same thread later with send_message.",
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
    "Without thread_id: list who you can reach — subagents you started, your teammates (Stella and the other agents in this conversation), other Stella sessions on this computer, and the user's cloud sessions — with each one's thread_id, what it is working on, where it runs, and its status. With thread_id: that agent's status, recent assistant messages, latest tool call, and timestamps. Read-only: it never interrupts or messages anyone.",
  parameters: {
    type: "object",
    properties: {
      thread_id: {
        type: "string",
        description:
          "The agent to inspect. Omit it to list everyone you can reach.",
      },
    },
  },
} as const;

export const AGENT_ORCHESTRATION_TOOL_DESCRIPTORS = [
  SPAWN_AGENT_TOOL_DESCRIPTOR,
  SEND_MESSAGE_TOOL_DESCRIPTOR,
  PAUSE_AGENT_TOOL_DESCRIPTOR,
  AGENT_STATUS_TOOL_DESCRIPTOR,
] as const;

export const AGENT_ORCHESTRATION_TOOL_NAMES: readonly string[] = [
  "spawn_agent",
  "send_message",
  "pause_agent",
  "agent_status",
];

/**
 * The orchestration tools an agent at the depth limit loses. It keeps
 * agent_status and send_message, so it can still see and message others.
 */
export const AGENT_CONTROL_TOOL_NAMES: readonly string[] = [
  "spawn_agent",
  "pause_agent",
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
 * A steer is keyed by an id derived from the tool call, but the receiver
 * deletes the mailbox row once it consumes it, so a rerun after consumption
 * delivers the message twice.
 */
export const SEND_MESSAGE_TOOL_REPLAY = "unsafe" as const;
