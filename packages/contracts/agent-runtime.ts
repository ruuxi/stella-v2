export const AGENT_IDS = {
  ORCHESTRATOR: "orchestrator",
  FASHION: "fashion",
  GENERAL: "general",
  SOCIAL_SESSION: "social_session",
  OFFLINE_RESPONDER: "offline_responder",
  EXPLORE: "explore",
} as const;

export type AgentId = (typeof AGENT_IDS)[keyof typeof AGENT_IDS];
export type AgentIdLike = AgentId | (string & {});

type AgentPromptRole = "orchestrator" | "subagent";
type LocalCliWorkingDirectory = "home" | "frontend";
type AgentModelSettings = {
  description?: string;
  order: number;
};

/**
 * Declarative runtime behaviors for each agent. Unset flags default to false,
 * and steering defaults to "one-at-a-time".
 */
export type AgentCapabilities = {
  /** Steering queue mode for this agent's runs. Defaults to "one-at-a-time". */
  steeringMode?: "all" | "one-at-a-time";
  /** Follow-up queue mode for this agent's runs. Defaults to "one-at-a-time". */
  followUpMode?: "all" | "one-at-a-time";
  /**
   * Load the user's selected personality preset into the agent context so it
   * is injected as a hidden `~/.stella/PERSONALITY.md` startup doc on the
   * first turn (then replayed from history), mirroring core memory.
   */
  injectsPersonality?: boolean;
  /**
   * Load the user's core memory into the agent context so it is injected as a
   * hidden `~/.stella/core-memory.md` startup doc on the first turn.
   */
  injectsCoreMemory?: boolean;
  /** Push-inject the durable user profile as a hidden startup document. */
  injectsUserProfile?: boolean;
  /** Inject runtime reminder hidden messages. */
  injectsRuntimeReminders?: boolean;
  /** Inject the skill catalog block into the dynamic context. */
  injectsSkillCatalog?: boolean;
  /** Record a durable thread summary on successful run completion. */
  recordsThreadSummary?: boolean;
};

type AgentDefinition = {
  id: AgentId;
  name: string;
  description: string;
  activityLabel: string | null;
  bundledCore: boolean;
  runsAsSubagent: boolean;
  /** When false, omitted from the orchestrator-visible agent roster (internal flows only). */
  includeInAgentRoster?: boolean;
  usesLocalCliRuntime: boolean;
  promptRole: AgentPromptRole;
  localCliWorkingDirectory: LocalCliWorkingDirectory | null;
  modelSettings: AgentModelSettings | null;
  /** Optional capability bundle. Defaults to no capabilities. */
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
      injectsUserProfile: true,
      injectsRuntimeReminders: true,
      injectsSkillCatalog: true,
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
    id: AGENT_IDS.SOCIAL_SESSION,
    name: "Social Session",
    description:
      "Works inside a shared Stella Together folder with a path-scoped file tool surface.",
    activityLabel: "Collaborating",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Works inside shared Stella Together folders",
      order: 10,
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

/**
 * Agent types that existed in earlier versions and no longer do, mapped to
 * what a persisted row of that type should read as now.
 *
 * Applied when loading `runtime_agents` rows, so a thread written by an older
 * install degrades into an ordinary thread rather than an unknown type: it
 * keeps its history, still appears in Activity (the feed admits only known
 * types), renders its subagents as a normal parent/child hierarchy, and runs
 * with a real toolset if the user resumes it. The stored value is left alone —
 * this is a read-time reinterpretation, not a migration that rewrites rows.
 */
const RETIRED_AGENT_TYPE_REPLACEMENTS: Readonly<Record<string, AgentId>> =
  Object.freeze({
    // Removed with the Manager agent; its threads were ordinary coordination
    // threads whose children are plain General subagents.
    manager: AGENT_IDS.GENERAL,
    // Removed with the scheduling rework: the orchestrator owns direct
    // schedule tools now, so the plain-language schedule specialist is gone.
    // Its threads were ordinary one-shot workers.
    schedule: AGENT_IDS.GENERAL,
    // Automatic memory consolidation is retired. Historical Dream rows remain
    // available as ordinary General history without exposing Dream as a
    // resumable built-in agent.
    dream: AGENT_IDS.GENERAL,
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

/** Resolve declarative capabilities for an agent. */
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

// All IPC stream event types. RUN_FINISHED is the single terminal event for
// a run; per-agent lifecycle is the AGENT_* family below.
export const AGENT_STREAM_EVENT_TYPES = {
  RUN_STARTED: "run-started",
  RUN_FINISHED: "run-finished",
  STATUS: "status",
  AGENT_REASONING: "agent-reasoning",
  TOOL_START: "tool-start",
  TOOL_END: "tool-end",
  PROVIDER_LIFECYCLE: "provider-lifecycle",
  AGENT_STARTED: "agent-started",
  AGENT_PROGRESS: "agent-progress",
  AGENT_COMPLETED: "agent-completed",
  AGENT_FAILED: "agent-failed",
  AGENT_CANCELED: "agent-canceled",
  /**
   * The one and only carrier of assistant text. Emitted once per completed
   * assistant message segment (a run may produce several — preamble →
   * post-tool answer), after the row is persisted, carrying that row's
   * eventId and the segment's full canonical text.
   */
  ASSISTANT_MESSAGE: "assistant-message",
} as const;

export type AgentStreamEventType =
  (typeof AGENT_STREAM_EVENT_TYPES)[keyof typeof AGENT_STREAM_EVENT_TYPES];

/**
 * Worker run-event recorder seqs are a per-run counter (1, 2, 3…). Hidden-run
 * mirrors and similar paths stamp `Date.now()`-scale synthetics, and a few
 * terminals use `Number.MAX_SAFE_INTEGER`. Anything at or above this ceiling
 * is not a recorder cursor and must not be fed to `resumeAfter`.
 */
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

// Per-agent lifecycle (subset of AGENT_STREAM_EVENT_TYPES). Tracks one
// subagent task from spawn to terminal state.
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

// Single status enum used by every layer that tracks a task's lifecycle
// state: TaskItem (UI), ConversationTaskSnapshot (IPC resume), and the
// runtime LocalAgentManager.
export type TaskLifecycleStatus =
  | "running"
  | "completed"
  | "error"
  | "canceled";

/**
 * Redacted task-scoped tool state used by the Activity summary engine.
 * Raw tool arguments must never be placed here: this shape crosses IPC and
 * is persisted in local chat lifecycle rows.
 */
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

// Outcome of a single run (RUN_FINISHED). Mirrors the terminal subset of
// TaskLifecycleStatus.
export const AGENT_RUN_FINISH_OUTCOMES = {
  COMPLETED: "completed",
  ERROR: "error",
  CANCELED: "canceled",
} as const satisfies Record<string, TerminalTaskLifecycleStatus>;

export type AgentRunFinishOutcome = TerminalTaskLifecycleStatus;

// Internal runtime store event types (separate vocabulary because these
// are persisted to RuntimeStore and the schema is independent from IPC).
export const RUNTIME_RUN_EVENT_TYPES = {
  RUN_START: "run_start",
  /**
   * No longer written: the recorder stopped persisting a row per text delta
   * when assistant text became whole-message. Declared so rows already in
   * users' local stores keep a name.
   */
  STREAM: "stream",
  TOOL_START: "tool_start",
  TOOL_END: "tool_end",
  RUN_END: "run_end",
  ERROR: "error",
} as const;

export const TOOL_IDS = {
  NO_RESPONSE: "NoResponse",
  READ: "Read",
} as const;
