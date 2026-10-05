/**
 * Wire contract for a cloud orchestrator chat turn run by the real Claude Code
 * CLI. When a conversation's execution engine is `anthropic`, the
 * OrchestratorSession Durable Object does not run Stella's Agent loop: it
 * dispatches the turn to a BuildSession as an agent turn with
 * `agentRole: "orchestrator"`, and the container executor runs `claude` with
 * the DO's own system prompt and tools.
 *
 *   DO --dispatch--> BuildSession --turn-input.json--> executor --> claude
 *   claude --MCP--> executor --broker--> BuildSession --internal--> DO
 *
 * The DO stays the single source of tools: the executor only advertises the
 * catalog it was handed and forwards every call back. Identity:
 *   - threadId is `orchestratorCliThreadId(conversationId)`;
 *   - turnId is the DO's chat turn id (the dispatch passes it as `turnId`);
 *   - attemptGeneration is the BuildSession attempt for that turn.
 */

/** Which loop a container CLI turn runs. */
export type CloudCliTurnRole = "agent" | "orchestrator";

/** BuildSession thread that runs one conversation's orchestrator CLI turns. */
export const orchestratorCliThreadId = (conversationId: string): string =>
  `orch:${conversationId}`;

/**
 * One orchestrator tool as the DO's `createTools()` defines it. `parameters`
 * is the tool's JSON Schema object, the same field the runtime's
 * `ToolMetadata` and `AgentTool` carry, so the executor can hand the entry to
 * the Claude Code MCP host unchanged.
 */
export type CloudOrchestratorToolDescriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** What the DO sends for its CLI turn, and what turn-input.json carries. */
export type CloudOrchestratorCliTurnSpec = {
  /** The DO's full orchestrator system prompt for this turn. */
  systemPrompt: string;
  toolCatalog: CloudOrchestratorToolDescriptor[];
};

/**
 * Role fields of turn-input.json. Every turn input carries `role`; only an
 * orchestrator turn carries a system prompt and tool catalog, and an agent
 * turn keeps building its own.
 */
export type CloudCliTurnRoleInput =
  | { role: "agent"; systemPrompt?: never; toolCatalog?: never }
  | ({ role: "orchestrator" } & CloudOrchestratorCliTurnSpec);

export const CLOUD_ORCHESTRATOR_SYSTEM_PROMPT_MAX_CHARS = 512 * 1024;
export const CLOUD_ORCHESTRATOR_TOOL_CATALOG_MAX_TOOLS = 128;
/** Serialized size of the whole catalog, descriptions and schemas included. */
export const CLOUD_ORCHESTRATOR_TOOL_CATALOG_MAX_BYTES = 512 * 1024;
/** MCP and Anthropic tool-name alphabet; the CLI prefixes `mcp__stella__`. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Shared validator for the spec, used by the BuildSession on dispatch and by
 * the executor on turn-input.json. Null on anything malformed or oversized.
 */
export const parseCloudOrchestratorCliTurnSpec = (
  value: unknown,
): CloudOrchestratorCliTurnSpec | null => {
  if (!isRecord(value)) return null;
  const { systemPrompt, toolCatalog } = value;
  if (
    typeof systemPrompt !== "string" ||
    !systemPrompt.trim() ||
    systemPrompt.length > CLOUD_ORCHESTRATOR_SYSTEM_PROMPT_MAX_CHARS ||
    !Array.isArray(toolCatalog) ||
    toolCatalog.length > CLOUD_ORCHESTRATOR_TOOL_CATALOG_MAX_TOOLS
  ) {
    return null;
  }
  const names = new Set<string>();
  const catalog: CloudOrchestratorToolDescriptor[] = [];
  for (const entry of toolCatalog) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !TOOL_NAME_PATTERN.test(entry.name) ||
      names.has(entry.name) ||
      typeof entry.description !== "string" ||
      !isRecord(entry.parameters)
    ) {
      return null;
    }
    names.add(entry.name);
    catalog.push({
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
    });
  }
  if (
    new TextEncoder().encode(JSON.stringify(catalog)).byteLength >
    CLOUD_ORCHESTRATOR_TOOL_CATALOG_MAX_BYTES
  ) {
    return null;
  }
  return { systemPrompt, toolCatalog: catalog };
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Executor -> BuildSession turn-broker targets (bodies below). */
export const CLOUD_ORCHESTRATOR_BROKER_PATHS = {
  tool: "/api/cloud/orchestrator-tool",
  events: "/api/cloud/orchestrator-events",
} as const;

/**
 * BuildSession -> OrchestratorSession DO routes. Internal Durable Object
 * fetches only; never reachable from the public router.
 */
export const CLOUD_CLI_TURN_DO_PATHS = {
  tool: "/internal/cli-turn/tool",
  events: "/internal/cli-turn/events",
  terminal: "/internal/cli-turn/terminal",
} as const;

/** Broker body limits (the broker's per-target `maxBodyBytes`). */
export const CLOUD_ORCHESTRATOR_TOOL_REQUEST_MAX_BYTES = 1024 * 1024;
export const CLOUD_ORCHESTRATOR_EVENTS_REQUEST_MAX_BYTES = 1024 * 1024;

/**
 * The exact turn a forwarded frame belongs to. The BuildSession fills it from
 * its own claimed broker identity and turn record, never from the executor's
 * body; the DO answers 409 when it no longer names the DO's active turn.
 */
export type CloudCliTurnIdentity = {
  conversationId: string;
  threadId: string;
  turnId: string;
  attemptGeneration: number;
};

// ---------------------------------------------------------------------------
// Tool calls: claude -> MCP host -> broker -> DO -> AgentTool.execute
// ---------------------------------------------------------------------------

/** Executor -> broker body for `CLOUD_ORCHESTRATOR_BROKER_PATHS.tool`. */
export type CloudOrchestratorToolCallRequest = {
  /**
   * The CLI's own `tool_use` id (resolved through the native tool-use
   * correlator), so the journaled assistant call and its result match.
   */
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
};

/** BuildSession -> DO body for `CLOUD_CLI_TURN_DO_PATHS.tool`. */
export type CloudCliTurnToolForward = CloudCliTurnIdentity &
  CloudOrchestratorToolCallRequest;

export type CloudOrchestratorToolContent =
  | { type: "text"; text: string }
  /** Base64 image bytes, as the runtime's `ImageContent`. */
  | { type: "image"; data: string; mimeType: string };

/**
 * The runtime's `AgentToolResult`, serialized. A tool that throws is still a
 * result: the DO journals and returns `{ content: [text error], isError:
 * true }`, exactly as Stella's Agent loop would.
 */
export type CloudOrchestratorToolResult = {
  content: CloudOrchestratorToolContent[];
  details?: unknown;
  isError?: boolean;
};

/**
 * Refusals where the DO ran nothing and journaled nothing. The executor
 * surfaces them to the CLI as an MCP tool error.
 *   - `turn_inactive`: the identity is not the DO's active CLI turn.
 *   - `unknown_tool`: the name is not in the catalog the DO handed out.
 *   - `conflict`: the toolCallId was already used with different args.
 */
export type CloudOrchestratorToolCallRefusal = {
  code: "turn_inactive" | "unknown_tool" | "conflict";
  message: string;
};

/**
 * DO -> BuildSession -> executor response body (HTTP 200 for both arms). A
 * replayed toolCallId with identical args returns the recorded result.
 */
export type CloudOrchestratorToolCallResponse =
  | { ok: true; result: CloudOrchestratorToolResult }
  | { ok: false; error: CloudOrchestratorToolCallRefusal };

// ---------------------------------------------------------------------------
// Event batches: claude stream-json -> executor -> broker -> DO journal/hub
// ---------------------------------------------------------------------------

/**
 * Usage in the runtime's `Usage` shape. The gateway meters spend; the cost
 * fields stay zero here.
 */
export type CloudCliUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

/**
 * One finalized CLI assistant message (a stream-json `assistant` event),
 * converted into the runtime's `AssistantMessage` shape so the DO journals it
 * as-is. `tool_use` blocks become `toolCall` content with the CLI's ids.
 */
export type CloudCliAssistantMessage = {
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; thinkingSignature?: string }
    | {
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }
  >;
  api: "claude-code";
  provider: "anthropic";
  model: string;
  responseId?: string;
  usage: CloudCliUsage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
};

export type CloudOrchestratorEvent =
  /** Streamed reply text since the previous batch (`--include-partial-messages`). */
  | { type: "text_delta"; text: string }
  /** The CLI's own status changes, e.g. while it compacts its session. */
  | { type: "status"; state: "running" | "compacting"; text: string }
  /**
   * Journal this message. A batch carrying a message with `toolCall` blocks
   * is acknowledged before the executor forwards any of those calls.
   */
  | { type: "assistant_message"; message: CloudCliAssistantMessage }
  /** Cumulative totals for this attempt so far; the latest one wins. */
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      llmCalls: number;
    };

/**
 * Executor -> broker body for `CLOUD_ORCHESTRATOR_BROKER_PATHS.events`, sent
 * about every 100 ms while events are pending. Batches are posted strictly in
 * order and each waits for the previous acknowledgement; the executor flushes
 * the last batch before it writes its turn result. There is no terminal
 * event: the stream ends with the terminal frame below.
 */
export type CloudOrchestratorEventBatch = {
  /** 1, 2, 3... per attempt. The DO applies `lastApplied + 1` and acks a replay. */
  batchSeq: number;
  events: CloudOrchestratorEvent[];
};

/** BuildSession -> DO body for `CLOUD_CLI_TURN_DO_PATHS.events`. */
export type CloudCliTurnEventsForward = CloudCliTurnIdentity &
  CloudOrchestratorEventBatch;

/**
 * BuildSession -> DO body for `CLOUD_CLI_TURN_DO_PATHS.terminal`, sent once
 * the attempt is terminal (executor result read, executor lost, or canceled)
 * instead of the agent wake in terminal-delivery. Retried until the DO acks;
 * the DO treats a repeat for an already-finished turn as a no-op.
 */
export type CloudCliTurnTerminal = CloudCliTurnIdentity & {
  outcome: "completed" | "failed" | "canceled";
  /**
   * The CLI's final reply text. Lets the DO repair the journal when the last
   * `assistant_message` batch never arrived.
   */
  finalText: string;
  /** User-safe failure text for `failed`. */
  error?: string;
  usage: { inputTokens: number; outputTokens: number; llmCalls: number };
};
