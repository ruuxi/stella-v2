export const AGENT_IDS = {
  ORCHESTRATOR: "orchestrator",
  FASHION: "fashion",
  GENERAL: "general",
  OFFLINE_RESPONDER: "offline_responder",
  EXPLORE: "explore",
  DREAM: "dream",
} as const;

export type AgentId = (typeof AGENT_IDS)[keyof typeof AGENT_IDS];
export type AgentIdLike = AgentId | (string & {});

type AgentPromptRole = "orchestrator" | "subagent";
type LocalCliWorkingDirectory = "home" | "frontend";
type AgentModelSettings = {
  description?: string;
  order: number;
};

export type AgentCapabilities = {

  steeringMode?: "all" | "one-at-a-time";

  followUpMode?: "all" | "one-at-a-time";

  injectsPersonality?: boolean;

  injectsCoreMemory?: boolean;

  injectsResidentMemory?: boolean;

  injectsDynamicMemory?: boolean;

  injectsRuntimeReminders?: boolean;

  injectsSkillCatalog?: boolean;

  recordsThreadSummary?: boolean;

  triggersDreamScheduler?: boolean;

  triggersMemoryReview?: boolean;
};

type AgentDefinition = {
  id: AgentId;
  name: string;
  description: string;
  activityLabel: string | null;
  bundledCore: boolean;
  runsAsSubagent: boolean;

  includeInAgentRoster?: boolean;
  usesLocalCliRuntime: boolean;
  promptRole: AgentPromptRole;
  localCliWorkingDirectory: LocalCliWorkingDirectory | null;
  modelSettings: AgentModelSettings | null;

  capabilities?: AgentCapabilities;
};

const BUILTIN_AGENT_DEFINITIONS = [
  {
    id: AGENT_IDS.ORCHESTRATOR,
    name: "Orchestrator",
    description:
      "Coordinates work across agents, talks to the user, manages memory and scheduling.",
    activityLabel: "Coordinating",
    bundledCore: true,
    runsAsSubagent: false,
    usesLocalCliRuntime: true,
    promptRole: "orchestrator",
    localCliWorkingDirectory: "frontend",
    modelSettings: {
      description: "Top-level agent that delegates tasks",
      order: 0,
    },
    capabilities: {
      steeringMode: "all",
      followUpMode: "all",
      injectsPersonality: true,
      injectsCoreMemory: true,
      injectsResidentMemory: true,
      injectsDynamicMemory: true,
      injectsRuntimeReminders: true,
      injectsSkillCatalog: true,
      triggersDreamScheduler: true,
      triggersMemoryReview: true,
    },
  },
  {
    id: AGENT_IDS.FASHION,
    name: "Fashion",
    description:
      "Builds outfit batches for the Fashion tab: searches the global Shopify catalog, picks cohesive pieces across slots, and renders the user wearing each look on a clean white studio background by combining their body photo with product images.",
    activityLabel: "Styling",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Builds outfit looks and fashion outputs",
      order: 8,
    },
  },
  {
    id: AGENT_IDS.GENERAL,
    name: "General",
    description:
      "Executes delegated work with a fixed base tool pack, Stella's life environment, and bundled native CLIs.",
    activityLabel: "Working",
    bundledCore: true,
    runsAsSubagent: true,
    usesLocalCliRuntime: true,
    promptRole: "subagent",
    localCliWorkingDirectory: "frontend",
    modelSettings: {
      description:
        "Single execution agent that works from files, manuals, and tools",
      order: 1,
    },
    capabilities: {
      injectsSkillCatalog: true,

      recordsThreadSummary: true,
    },
  },
  {
    id: AGENT_IDS.OFFLINE_RESPONDER,
    name: "Offline Responder",
    description: "Handles offline fallback responses.",
    activityLabel: "Responding",
    bundledCore: false,
    runsAsSubagent: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Responds when Stella is offline",
      order: 9,
    },
  },
  {
    id: AGENT_IDS.EXPLORE,
    name: "Explore",
    description:
      "Stateless one-shot helper. Reads ~/.stella/ to surface relevant paths for an upcoming General task.",
    activityLabel: "Exploring",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Finds relevant context before a task starts",
      order: 3,
    },
  },
  {
    id: AGENT_IDS.DREAM,
    name: "Dream",
    description:
      "Background memory consolidator. Reads the Dream inbox and surgically updates ~/.stella/memories/ markdown files.",
    activityLabel: "Dreaming",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Consolidates memory in the background",
      order: 5,
    },
  },
] as const satisfies readonly AgentDefinition[];

type BuiltInAgentDefinition = (typeof BUILTIN_AGENT_DEFINITIONS)[number];
type LocalCliAgentId = Extract<
  BuiltInAgentDefinition,
  { usesLocalCliRuntime: true }
>["id"];
type BundledCoreAgentId = Extract<
  BuiltInAgentDefinition,
  { bundledCore: true }
>["id"];

export const BUILTIN_AGENT_DEFINITION_BY_ID = Object.freeze(
  Object.fromEntries(
    BUILTIN_AGENT_DEFINITIONS.map((entry) => [entry.id, entry]),
  ) as Record<AgentId, BuiltInAgentDefinition>,
);

export const BUNDLED_CORE_AGENT_IDS = Object.freeze(
  BUILTIN_AGENT_DEFINITIONS.filter((entry) => entry.bundledCore).map(
    (entry) => entry.id,
  ) as BundledCoreAgentId[],
);

export const ORCHESTRATOR_RESERVED_BUILTIN_AGENT_IDS = Object.freeze(
  BUILTIN_AGENT_DEFINITIONS.filter(
    (entry) => entry.id !== AGENT_IDS.GENERAL,
  ).map((entry) => entry.id) as AgentId[],
);

const ORCHESTRATOR_RESERVED_BUILTIN_AGENT_ID_SET = new Set<string>(
  ORCHESTRATOR_RESERVED_BUILTIN_AGENT_IDS,
);

export const isOrchestratorReservedBuiltinAgentId = (
  agentId: string,
): boolean => ORCHESTRATOR_RESERVED_BUILTIN_AGENT_ID_SET.has(agentId);

const RETIRED_AGENT_TYPE_REPLACEMENTS: Readonly<Record<string, AgentId>> =
  Object.freeze({

    manager: AGENT_IDS.GENERAL,

    schedule: AGENT_IDS.GENERAL,
  });

export const normalizeRetiredAgentType = (agentType: string): string =>
  RETIRED_AGENT_TYPE_REPLACEMENTS[agentType] ?? agentType;

export const MODEL_SETTINGS_AGENTS = Object.freeze(
  BUILTIN_AGENT_DEFINITIONS.filter(
    (
      entry,
    ): entry is BuiltInAgentDefinition & {
      modelSettings: AgentModelSettings;
    } => entry.modelSettings !== null,
  )
    .sort((a, b) => a.modelSettings.order - b.modelSettings.order)
    .map((entry) => ({
      key: entry.id as AgentId,
      label: entry.name,
      desc: entry.modelSettings.description ?? entry.description,
    })),
);

const LOCAL_CLI_AGENT_ID_SET = new Set<string>(
  BUILTIN_AGENT_DEFINITIONS.filter((entry) => entry.usesLocalCliRuntime).map(
    (entry) => entry.id,
  ),
);

export const getAgentDefinition = (
  agentType: string,
): AgentDefinition | undefined =>
  BUILTIN_AGENT_DEFINITION_BY_ID[agentType as AgentId] as AgentDefinition;

export const getAgentActivityLabel = (agentType: string): string | null =>
  getAgentDefinition(agentType)?.activityLabel ?? null;

export const getLocalCliWorkingDirectory = (
  agentType: string,
): LocalCliWorkingDirectory | null =>
  getAgentDefinition(agentType)?.localCliWorkingDirectory ?? null;

export const isLocalCliAgentId = (
  agentType: string,
): agentType is LocalCliAgentId => LOCAL_CLI_AGENT_ID_SET.has(agentType);

export const isOrchestratorAgentType = (agentType: string): boolean =>
  getAgentDefinition(agentType)?.promptRole === "orchestrator";

export const getAgentCapabilities = (agentType: string): AgentCapabilities =>
  getAgentDefinition(agentType)?.capabilities ?? {};

export const agentHasCapability = (
  agentType: string,
  capability: keyof AgentCapabilities,
): boolean => {
  const value = getAgentCapabilities(agentType)[capability];
  return value !== undefined && value !== false;
};

export const getAgentSteeringMode = (
  agentType: string,
): "all" | "one-at-a-time" =>
  getAgentCapabilities(agentType).steeringMode ?? "one-at-a-time";

export const getAgentFollowUpMode = (
  agentType: string,
): "all" | "one-at-a-time" =>
  getAgentCapabilities(agentType).followUpMode ?? "one-at-a-time";

export const AGENT_STREAM_EVENT_TYPES = {
  RUN_STARTED: "run-started",
  RUN_FINISHED: "run-finished",
  STREAM: "stream",
  STATUS: "status",
  AGENT_REASONING: "agent-reasoning",
  TOOL_START: "tool-start",
  TOOL_END: "tool-end",
  AGENT_STARTED: "agent-started",
  AGENT_PROGRESS: "agent-progress",
  AGENT_COMPLETED: "agent-completed",
  AGENT_FAILED: "agent-failed",
  AGENT_CANCELED: "agent-canceled",

  ASSISTANT_MESSAGE: "assistant-message",
} as const;

export type AgentStreamEventType =
  (typeof AGENT_STREAM_EVENT_TYPES)[keyof typeof AGENT_STREAM_EVENT_TYPES];

export const AGENT_RECORDER_SEQ_CEILING = 10_000_000_000;

export const isAgentRecorderSeq = (seq: unknown): seq is number =>
  typeof seq === "number" &&
  Number.isFinite(seq) &&
  seq > 0 &&
  seq < AGENT_RECORDER_SEQ_CEILING;

export const nextAgentRecorderSeqCursor = (
  previous: number,
  event: { seq?: number; sourceSeq?: number },
): number => {
  const candidate = isAgentRecorderSeq(event.sourceSeq)
    ? event.sourceSeq
    : isAgentRecorderSeq(event.seq)
      ? event.seq
      : previous;
  return candidate > previous ? candidate : previous;
};

export const TASK_LIFECYCLE_EVENT_TYPES = [
  AGENT_STREAM_EVENT_TYPES.AGENT_STARTED,
  AGENT_STREAM_EVENT_TYPES.AGENT_PROGRESS,
  AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED,
  AGENT_STREAM_EVENT_TYPES.AGENT_FAILED,
  AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED,
] as const;

export type TaskLifecycleEventType =
  (typeof TASK_LIFECYCLE_EVENT_TYPES)[number];

export const TASK_LIFECYCLE_TERMINAL_TYPES = [
  AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED,
  AGENT_STREAM_EVENT_TYPES.AGENT_FAILED,
  AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED,
] as const;

export type TaskLifecycleTerminalType =
  (typeof TASK_LIFECYCLE_TERMINAL_TYPES)[number];

const TASK_LIFECYCLE_TYPE_SET: ReadonlySet<string> = new Set(
  TASK_LIFECYCLE_EVENT_TYPES,
);
const TASK_LIFECYCLE_TERMINAL_SET: ReadonlySet<string> = new Set(
  TASK_LIFECYCLE_TERMINAL_TYPES,
);

export const isTaskLifecycleEventType = (
  type: string,
): type is TaskLifecycleEventType => TASK_LIFECYCLE_TYPE_SET.has(type);

export const isTaskLifecycleTerminalType = (
  type: string,
): type is TaskLifecycleTerminalType => TASK_LIFECYCLE_TERMINAL_SET.has(type);

export type TaskLifecycleStatus =
  | "running"
  | "completed"
  | "error"
  | "canceled";

export type TaskToolActivity = {
  toolCallId: string;
  toolName: string;
  label: string;
  argsHint?: string;
  state: "started" | "completed";
  exitCode?: number | null;
};

export type TerminalTaskLifecycleStatus = Exclude<
  TaskLifecycleStatus,
  "running"
>;

export type TaskLifecycleFeedEventType =
  | typeof AGENT_STREAM_EVENT_TYPES.AGENT_REASONING
  | TaskLifecycleEventType;

export const isTerminalTaskLifecycleStatus = (
  status: TaskLifecycleStatus | undefined,
): status is TerminalTaskLifecycleStatus =>
  status === "completed" || status === "error" || status === "canceled";

export const shouldIgnoreTerminalTaskFeedEvent = (args: {
  currentStatus?: TaskLifecycleStatus;
  eventType: TaskLifecycleFeedEventType;
}): boolean => {
  if (!isTerminalTaskLifecycleStatus(args.currentStatus)) {
    return false;
  }
  return (
    args.eventType !== AGENT_STREAM_EVENT_TYPES.AGENT_STARTED &&
    !isTaskLifecycleTerminalType(args.eventType)
  );
};

export const AGENT_RUN_FINISH_OUTCOMES = {
  COMPLETED: "completed",
  ERROR: "error",
  CANCELED: "canceled",
} as const satisfies Record<string, TerminalTaskLifecycleStatus>;

export type AgentRunFinishOutcome = TerminalTaskLifecycleStatus;

export const RUNTIME_RUN_EVENT_TYPES = {
  RUN_START: "run_start",
  STREAM: "stream",
  TOOL_START: "tool_start",
  TOOL_END: "tool_end",
  RUN_END: "run_end",
  ERROR: "error",
} as const;

export const TOOL_IDS = {
  NO_RESPONSE: "NoResponse",
  DREAM: "Dream",
  READ: "Read",
  STR_REPLACE: "StrReplace",
} as const;
