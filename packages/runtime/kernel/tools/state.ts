/**
 * State tools: spawn_agent / pause_agent / send_input / agent_status handlers.
 */

import type {
  ToolContext,
  ToolResult,
  AgentRecord,
  AgentToolApi,
} from "./types.js";
import {
  deriveRuntimeThreadLiveState,
  formatRuntimeThreadAge,
  runtimeThreadLastActiveAt,
  type RuntimeThreadRecord,
} from "../runtime-threads.js";
import { AGENT_PAUSE_CANCEL_REASON } from "../agents/local-agent-manager.js";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { parseSpawnDestination } from "./defs/agent-orchestration-def.js";
import { STELLA_DEFAULT_MODEL } from "@stella/contracts/stella-api";
import {
  agentThreadLookupController,
  agentThreadLookupLocation,
  agentThreadLookupProgress,
  agentThreadLookupReport,
  agentThreadLookupStartedByViewer,
  describeAgentThreadLookup,
  isAgentThreadLookupActive,
} from "@stella/contracts/backend/agent-thread-lookup";
import { DEVICE_AGENT_QUEUED_NOTE } from "@stella/contracts/backend/agent-threads";
import type {
  AgentModelConfigSnapshot,
  CloudExecutionSelection,
  AgentRuntimeEngine,
  SpawnEngineSelection,
  SpawnReasoningEffort,
} from "@stella/contracts/agent-engine";
import { isRegisteredModelReference } from "../../ai/models.js";
import {
  isOpenEndedModelReference,
  isRegisteredBareStellaModelReference,
} from "../model-routing-matching.js";

export type StateContext = {
  stateRoot: string;
  tasks: Map<string, AgentRecord>;
  agentApi?: AgentToolApi;
  /**
   * Validates a plain model-reference string for spawn_agent. Throws with the
   * standard route-failure message when the model cannot be resolved.
   */
  validateSpawnModel?: (modelName: string) => void;
  /** Catalog-aware validation used for the final spawn decision. */
  validateSpawnModelWithMetadata?: (
    modelName: string,
    reasoningEffort?: SpawnReasoningEffort,
  ) => Promise<void>;
  resolveCloudExecutionSelection?: (request: {
    model?: string;
    spawnEngine?: SpawnEngineSelection;
    reasoningEffort?: SpawnReasoningEffort;
  }) => Promise<CloudExecutionSelection>;
  /** Resolve and freeze a spawn's effective engine/model configuration. */
  captureSpawnModelConfig?: (args: {
    agentType: string;
    spawnEngine: SpawnEngineSelection;
    /** Omitted/default model selection samples the configured General engine. */
    useConfiguredEngine?: boolean;
    model?: string;
    spawnReasoningEffort?: SpawnReasoningEffort;
  }) => Promise<AgentModelConfigSnapshot | undefined>;
};

const toOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};


/**
 * `send_input` no longer asks the caller for a description, but the cloud
 * continuation mutation still requires a non-empty one and this device holds no
 * mirror of the cloud thread's current title. Local threads keep their spawn
 * name; only the cloud path needs a label, so derive it from the follow-up.
 */
const cloudContinuationLabel = (message: string): string => {
  const firstLine = message
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^task\s*:\s*/i, "");
  if (!firstLine) {
    return "Follow-up";
  }
  return firstLine.length > 80
    ? `${firstLine.slice(0, 77).trimEnd()}...`
    : firstLine;
};

const logWorkingIndicatorTrace = (
  label: string,
  payload: Record<string, unknown>,
): void => {
  process.stderr.write(`${JSON.stringify({ label, ...payload })}\n`);
};

/** Engine ids accepted in spawn_agent's `model` parameter. */
const SPAWN_ENGINE_IDS: Record<
  string,
  Exclude<AgentRuntimeEngine, "default">
> = {
  codex: "codex_cli",
  "claude-code": "claude_code_local",
};

export type SpawnModelSelection =
  | { kind: "default"; reasoningEffort?: SpawnReasoningEffort }
  | { kind: "model"; model: string; reasoningEffort?: SpawnReasoningEffort }
  | {
      kind: "engine";
      engine: SpawnEngineSelection;
      reasoningEffort?: SpawnReasoningEffort;
    };

const SPAWN_REASONING_EFFORTS = new Set<SpawnReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
]);

const splitSpawnReasoningSuffix = (
  raw: string,
): { model: string; suffix: string } | undefined => {
  const colon = raw.lastIndexOf(":");
  if (colon === -1) return undefined;
  const model = raw.slice(0, colon).trim();
  const suffix = raw
    .slice(colon + 1)
    .trim()
    .toLowerCase();
  return { model, suffix };
};

const invalidSpawnReasoningSuffix = (suffix: string): Error =>
  new Error(
    `Invalid spawn_agent model reasoning suffix ":${suffix}". Expected one of :low, :medium, :high, or :xhigh; open-ended gateway references keep colons verbatim.`,
  );

/**
 * Parses spawn_agent's optional `model` parameter:
 *
 *   - omitted / `default`            → the user's configured setup, untouched
 *   - `stella`                        → Stella's in-process engine
 *   - `codex` / `claude-code`        → that engine with its configured model
 *   - `codex/<m>` / `claude-code/<m>`→ that engine with `<m>` pinned
 *   - anything else                  → plain model reference, resolved through
 *                                      the normal model-routing path
 *
 * Closed known forms may end in `:low`, `:medium`, `:high`, or `:xhigh`.
 * Open-ended provider model identifiers preserve colons verbatim.
 */
export const parseSpawnAgentModel = (
  value: unknown,
  canResolveModel: (modelName: string) => boolean = () => false,
): SpawnModelSelection => {
  const raw = toOptionalString(value);
  if (!raw) return { kind: "default" };
  // Registered full model references win over suffix interpretation.
  // This preserves legitimate ids such as `...:thinking`, `...:free`, and
  // even a future registered model whose id literally ends in `:high`.
  const fullReferenceIsModel =
    isRegisteredModelReference(raw) || isOpenEndedModelReference(raw);
  const suffixParts = splitSpawnReasoningSuffix(raw);
  let modelReference = raw;
  let reasoningEffort: SpawnReasoningEffort | undefined;
  if (!fullReferenceIsModel && suffixParts) {
    const suffixIsEffort = SPAWN_REASONING_EFFORTS.has(
      suffixParts.suffix as SpawnReasoningEffort,
    );
    const slash = suffixParts.model.indexOf("/");
    const head = (
      slash === -1 ? suffixParts.model : suffixParts.model.slice(0, slash)
    ).toLowerCase();
    const baseIsKnownForm =
      suffixParts.model === "default" ||
      suffixParts.model === STELLA_DEFAULT_MODEL ||
      suffixParts.model.toLowerCase() === "stella" ||
      Boolean(SPAWN_ENGINE_IDS[head]) ||
      isRegisteredModelReference(suffixParts.model) ||
      isRegisteredBareStellaModelReference(suffixParts.model) ||
      canResolveModel(suffixParts.model);
    if (baseIsKnownForm && !suffixIsEffort) {
      throw invalidSpawnReasoningSuffix(suffixParts.suffix);
    }
    if (baseIsKnownForm && suffixIsEffort) {
      modelReference = suffixParts.model;
      reasoningEffort = suffixParts.suffix as SpawnReasoningEffort;
    }
  }
  if (modelReference === "default") {
    return { kind: "default", ...(reasoningEffort ? { reasoningEffort } : {}) };
  }
  if (modelReference.toLowerCase() === "stella") {
    return {
      kind: "engine",
      engine: { engine: "default" },
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }
  const slash = modelReference.indexOf("/");
  // Engine ids are matched case-insensitively so `Codex/gpt-x` selects the
  // engine instead of falling through to a confusing route error.
  const head = (
    slash === -1 ? modelReference : modelReference.slice(0, slash)
  ).toLowerCase();
  const engine = SPAWN_ENGINE_IDS[head];
  if (engine) {
    const model =
      slash === -1 ? undefined : modelReference.slice(slash + 1).trim();
    return {
      kind: "engine",
      engine: { engine, ...(model ? { model } : {}) },
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }
  return {
    kind: "model",
    model: modelReference,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
};

const buildOtherThreadsResult = (
  threads: Array<
    Pick<
      RuntimeThreadRecord,
      | "threadId"
      | "description"
      | "lastUsedAt"
      | "agentStatus"
      | "agentUpdatedAt"
    >
  >,
  currentThreadId: string,
) =>
  threads
    .filter((thread) => thread.threadId !== currentThreadId)
    .map((thread) => ({
      thread_id: thread.threadId,
      // Live execution state from the same runtime signal as the "# Other
      // Threads" roster: "active" = executing a turn now, "paused" = idle
      // but resumable via send_input.
      status: deriveRuntimeThreadLiveState(thread),
      last_active: formatRuntimeThreadAge(runtimeThreadLastActiveAt(thread)),
      ...(thread.description ? { description: thread.description } : {}),
    }));

export const createStateContext = (
  stateRoot: string,
  agentApi?: AgentToolApi,
  validateSpawnModel?: (modelName: string) => void,
  validateSpawnModelWithMetadata?: StateContext["validateSpawnModelWithMetadata"],
  resolveCloudExecutionSelection?: StateContext["resolveCloudExecutionSelection"],
  captureSpawnModelConfig?: StateContext["captureSpawnModelConfig"],
): StateContext => ({
  stateRoot,
  tasks: new Map(),
  agentApi,
  validateSpawnModel,
  validateSpawnModelWithMetadata,
  resolveCloudExecutionSelection,
  captureSpawnModelConfig,
});

const lookupConversationThread = async (
  ctx: StateContext,
  threadId: string,
  conversationId: string | undefined,
) => {
  if (!ctx.agentApi?.lookupConversationAgentThread || !conversationId) return null;
  return await ctx.agentApi
    .lookupConversationAgentThread(threadId, conversationId)
    .catch(() => null);
};

const unreachableThreadError = async (
  ctx: StateContext,
  threadId: string,
  conversationId: string | undefined,
  action: "send_input" | "pause_agent",
): Promise<string | null> => {
  const found = await lookupConversationThread(ctx, threadId, conversationId);
  if (!found) return null;
  const viewer = { host: "desktop" as const, deviceId: found.thisDeviceId };
  if (agentThreadLookupStartedByViewer(found.thread, viewer)) return null;
  return `${describeAgentThreadLookup(found.thread, viewer)} ${action} from this computer cannot reach it, so nothing was ${action === "send_input" ? "sent" : "paused"}.`;
};

export const handleSendInput = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const threadId =
    toOptionalString(args.thread_id) ?? toOptionalString(context.agentId);
  if (!ctx.agentApi?.sendAgentMessage) {
    return { error: "Agent input is not configured on this device." };
  }
  if (!threadId) {
    return { error: "thread_id is required" };
  }
  const message = toOptionalString(args.message);
  if (!message) {
    return { error: "message is required" };
  }
  const delivered = await ctx.agentApi.sendAgentMessage(
    threadId,
    message,
    "orchestrator",
    {
      ...(context.rootRunId ? { rootRunId: context.rootRunId } : {}),
      ...(context.agentType === AGENT_IDS.ORCHESTRATOR &&
      context.modelConfigSnapshot
        ? { modelConfigSnapshot: context.modelConfigSnapshot }
        : {}),
      deliveryKind: "external-input",
    },
  );
  if (!delivered.delivered) {
    if (ctx.agentApi.cloudContinue) {
      const continued = await ctx.agentApi.cloudContinue({
        threadId,
        description: cloudContinuationLabel(message),
        message,
        conversationId: context.conversationId,
        requestId: context.requestId,
        ...(context.ownerGeneration
          ? { ownerGeneration: context.ownerGeneration }
          : {}),
      });
      if (continued.delivered) {
        return {
          result: {
            thread_id: threadId,
            status: "updated",
            delivered: true,
            ...(continued.control
              ? {
                  attempt_generation: continued.control.attemptGeneration,
                  thread_updated_at: continued.control.threadUpdatedAt,
                  thread_status: continued.control.status,
                }
              : {}),
            note: continued.steered
              ? "Delivered to the running agent; it uses the message before its next step. Its report will return to this conversation, including after a desktop restart."
              : "The thread is running again. Its report will return to this conversation, including after a desktop restart.",
          },
        };
      }
      return {
        error:
          (await unreachableThreadError(
            ctx,
            threadId,
            context.conversationId,
            "send_input",
          )) ??
          continued.reason ??
          `Thread not found: ${threadId}`,
      };
    }
    return {
      error:
        (await unreachableThreadError(
          ctx,
          threadId,
          context.conversationId,
          "send_input",
        )) ??
        delivered.reason ??
        `Thread not found: ${threadId}`,
    };
  }
  return {
    result: {
      status: "delivered_agent_still_working",
      thread_id: threadId,
      note: "Delivered. This does NOT mean the task is done — the agent is still working. Wait for the [Agent completed] event; do not immediately re-check status.",
      delivered: true,
    },
  };
};

/** Codex engine id whose transcripts carry reasoning summaries, not text. */
const CODEX_ENGINE_ID = "codex_cli";
const AGENT_STATUS_MESSAGE_LIMIT = 4;
const AGENT_STATUS_TEXT_CHARS = 2_000;
const AGENT_STATUS_ARGS_CHARS = 4_000;

const boundAgentStatusText = (value: unknown, maxChars: number): string => {
  const text = String(value ?? "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}... [truncated]`;
};

type AgentStatusContentBlock = Record<string, unknown> & { type?: string };

const joinAssistantBlocks = (
  blocks: AgentStatusContentBlock[],
  type: string,
  field: string,
): string =>
  blocks
    .flatMap((block) => {
      const value = block?.[field];
      return block?.type === type && typeof value === "string" && value.trim()
        ? [value.trim()]
        : [];
    })
    .join("\n\n")
    .trim();

const conversationThreadStatus = (
  found: NonNullable<Awaited<ReturnType<typeof lookupConversationThread>>>,
): ToolResult => {
  const { thread } = found;
  const viewer = { host: "desktop" as const, deviceId: found.thisDeviceId };
  const active = isAgentThreadLookupActive(thread);
  const report = active ? undefined : agentThreadLookupReport(thread);
  const progress = agentThreadLookupProgress(thread);
  return {
    result: {
      thread_id: thread.threadId,
      status: active ? "active" : "paused",
      status_detail: thread.status,
      description: thread.description,
      placement: thread.executorDeviceId ? "device" : thread.placement,
      ...(thread.executorDeviceId ? { device_id: thread.executorDeviceId } : {}),
      ...(thread.originDeviceId
        ? { started_from_device_id: thread.originDeviceId }
        : {}),
      attempt_generation: thread.attemptGeneration,
      last_active_at: new Date(thread.updatedAt).toISOString(),
      ...(thread.activity && active
        ? {
            last_activity_at: new Date(
              thread.activity.lastActivityAt,
            ).toISOString(),
            ...(thread.activity.label
              ? { current_operation: thread.activity.label }
              : {}),
            ...(thread.activity.activeToolCount !== undefined
              ? { active_tool_count: thread.activity.activeToolCount }
              : {}),
          }
        : {}),
      ...(report !== undefined ? { result: report } : {}),
      ...(!active && thread.errorMessage ? { error: thread.errorMessage } : {}),
      current_time: new Date().toISOString(),
      controllable_here: agentThreadLookupStartedByViewer(thread, viewer),
      note: `Read-only snapshot from Stella's cloud; the agent was NOT interrupted or messaged. It runs ${agentThreadLookupLocation(thread)}, not in this computer's runtime.${progress ? ` ${progress}` : ""} ${agentThreadLookupController(thread, viewer)}`,
    },
  };
};

/**
 * Read-only `agent_status` handler. Projects a durable-thread snapshot into
 * the live status, the last few assistant messages (reasoning summaries for
 * Codex-engine threads), and the most recent tool CALL — never a tool result,
 * and never any delivery into the target thread.
 */
export const handleAgentStatus = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context?: Pick<ToolContext, "conversationId">,
): Promise<ToolResult> => {
  const threadId = toOptionalString(args.thread_id);
  if (!threadId) {
    return { error: "thread_id is required" };
  }
  const snapshot = ctx.agentApi?.readAgentThreadStatus
    ? await ctx.agentApi.readAgentThreadStatus(threadId)
    : null;
  if (!snapshot) {
    const found = await lookupConversationThread(
      ctx,
      threadId,
      context?.conversationId,
    );
    if (found) return conversationThreadStatus(found);
    if (!ctx.agentApi?.readAgentThreadStatus) {
      return { error: "Agent status is not available on this device." };
    }
    return { error: `Thread not found: ${threadId}` };
  }
  // ChatGPT/Codex surfaces reasoning summaries as its visible narration;
  // other engines author plain text blocks. Chronological walk keeps "latest
  // tool call" honest even if the store returns rows out of order.
  const isCodex = snapshot.engine === CODEX_ENGINE_ID;
  const ordered = [...snapshot.messages].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  const assistantMessages: Array<{ timestamp: string; content: string }> = [];
  let latestToolCall:
    | { timestamp: string; tool_name: string; arguments: unknown }
    | undefined;
  for (const message of ordered) {
    const payload = message.payload as
      | { role?: string; content?: AgentStatusContentBlock[] }
      | undefined;
    if (payload?.role !== "assistant" || !Array.isArray(payload.content)) {
      continue;
    }
    const text = joinAssistantBlocks(payload.content, "text", "text");
    const reasoning = joinAssistantBlocks(
      payload.content,
      "thinking",
      "thinking",
    );
    const content = isCodex ? reasoning || text : text;
    if (content) {
      assistantMessages.push({
        timestamp: new Date(message.timestamp).toISOString(),
        content: boundAgentStatusText(content, AGENT_STATUS_TEXT_CHARS),
      });
    }
    for (const block of payload.content) {
      if (block?.type !== "toolCall") continue;
      let toolArguments: unknown = block.arguments ?? {};
      try {
        const serialized = JSON.stringify(toolArguments) ?? "";
        if (serialized.length > AGENT_STATUS_ARGS_CHARS) {
          toolArguments = boundAgentStatusText(
            serialized,
            AGENT_STATUS_ARGS_CHARS,
          );
        }
      } catch {
        toolArguments = "[Unserializable tool arguments]";
      }
      latestToolCall = {
        timestamp: new Date(message.timestamp).toISOString(),
        tool_name: String(block.name ?? ""),
        arguments: toolArguments,
      };
    }
  }
  const now = Date.now();
  return {
    result: {
      thread_id: threadId,
      // Same live signal as the "# Other Threads" roster.
      status: snapshot.status,
      ...(snapshot.statusLabel && snapshot.statusLabel !== snapshot.status
        ? { status_detail: snapshot.statusLabel }
        : {}),
      ...(snapshot.description ? { description: snapshot.description } : {}),
      ...(typeof snapshot.lastActiveAt === "number"
        ? { last_active_at: new Date(snapshot.lastActiveAt).toISOString() }
        : {}),
      recent_assistant_messages: assistantMessages.slice(
        -AGENT_STATUS_MESSAGE_LIMIT,
      ),
      ...(latestToolCall ? { latest_tool_call: latestToolCall } : {}),
      current_time: new Date(now).toISOString(),
      note: "Read-only snapshot; the agent was NOT interrupted or messaged. To steer or ask it something, use send_input.",
    },
  };
};

export const handleSpawnAgent = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const action = toOptionalString(args.action)?.toLowerCase();
  const explicitThreadId = toOptionalString(args.thread_id);

  if ((action === "cancel" || action === "stop") && explicitThreadId) {
    // Pin the cancel reason to a sentinel so the runner can recognize
    // orchestrator-initiated pause_agent and skip the hidden `[Task canceled]`
    // follow-up turn — that follow-up was clobbering the user-facing reply
    // because it produced an empty assistant message that overwrote the
    // orchestrator's actual response to the pause request.
    if (ctx.agentApi) {
      const canceled = await ctx.agentApi.cancelAgent(
        explicitThreadId,
        AGENT_PAUSE_CANCEL_REASON,
      );
      if (!canceled.canceled) {
        if (
          context.agentType === AGENT_IDS.ORCHESTRATOR &&
          ctx.agentApi.cloudCancel
        ) {
          const cloudCanceled = await ctx.agentApi.cloudCancel({
            threadId: explicitThreadId,
            conversationId: context.conversationId,
            requestId: context.requestId,
            ...(context.ownerGeneration
              ? { ownerGeneration: context.ownerGeneration }
              : {}),
          });
          if (cloudCanceled.canceled) {
            return {
              result: {
                thread_id: explicitThreadId,
                status: "canceled",
                canceled: true,
                placement: "cloud",
                ...(cloudCanceled.control
                  ? {
                      attempt_generation:
                        cloudCanceled.control.attemptGeneration,
                      thread_updated_at: cloudCanceled.control.threadUpdatedAt,
                      thread_status: cloudCanceled.control.status,
                    }
                  : {}),
              },
            };
          }
          return {
            error:
              (await unreachableThreadError(
                ctx,
                explicitThreadId,
                context.conversationId,
                "pause_agent",
              )) ??
              cloudCanceled.reason ??
              `Thread not found: ${explicitThreadId}`,
          };
        }
        return {
          error:
            (await unreachableThreadError(
              ctx,
              explicitThreadId,
              context.conversationId,
              "pause_agent",
            )) ?? `Thread not found: ${explicitThreadId}`,
        };
      }
      return {
        result: {
          thread_id: explicitThreadId,
          status: "canceled",
          canceled: true,
        },
      };
    }
    const localRecord = ctx.tasks.get(explicitThreadId);
    if (!localRecord) return { error: `Thread not found: ${explicitThreadId}` };
    localRecord.status = "error";
    localRecord.error = AGENT_PAUSE_CANCEL_REASON;
    localRecord.completedAt = Date.now();
    return {
      result: {
        thread_id: explicitThreadId,
        status: "canceled",
        canceled: true,
      },
    };
  }

  const agentType = AGENT_IDS.GENERAL;
  // The root orchestrator has no thread identity of its own, so this resolves
  // to undefined there and the spawn is top-level. A General parent always has
  // one, which is what makes its children route back to it instead of root.
  const parentAgentId = toOptionalString(context.agentId);
  const storageMode = context.storageMode ?? "local";
  const parentAgentDepth = Math.max(0, context.agentDepth ?? 0);
  const nextAgentDepth = parentAgentDepth + 1;
  const maxAgentDepth = context.maxAgentDepth;

  if (
    context.agentType !== AGENT_IDS.ORCHESTRATOR &&
    context.agentType !== AGENT_IDS.GENERAL
  ) {
    return {
      error: "Only the orchestrator or a General agent can create tasks.",
    };
  }

  // agent_type was removed with the custom-agent-types story; error loudly
  // instead of silently ignoring a stale argument.
  if (toOptionalString(args.agent_type)) {
    return {
      error:
        "agent_type has been removed from spawn_agent. Every spawn runs the general agent; use the optional `model` parameter to pick a model or engine instead.",
    };
  }
  if (Object.prototype.hasOwnProperty.call(args, "group")) {
    return {
      error:
        "group has been removed from spawn_agent. Spawn a General agent and let it run its own subagents to coordinate related multi-agent work.",
    };
  }

  // Blank, or this computer's own id, runs here. "cloud" or another
  // device's id leaves this computer through the owner's agent-thread
  // ledger instead of LocalAgentManager. Without a dispatch capability there
  // is nowhere honest to put the work — refuse rather than silently run it in
  // the wrong place.
  const destination = parseSpawnDestination(args.destination);
  const targetDeviceId =
    destination.kind === "device" && destination.deviceId !== context.deviceId
      ? destination.deviceId
      : undefined;
  const cloudPlacement = destination.kind === "cloud" || targetDeviceId !== undefined;
  if (cloudPlacement && context.conversationId.startsWith("local_")) {
    return {
      error: "This chat is stored only on this computer, so its agents run here too. Leave destination empty.",
    };
  }
  if (cloudPlacement && !ctx.agentApi?.cloudDispatch) {
    return {
      error: `This runtime has no cloud connection, so it can only run agents on this computer. Leave destination empty.`,
    };
  }
  // Another device checks the model against its own routes and falls back
  // to its own default, so this computer forwards it unchecked.
  let modelSelection: SpawnModelSelection = { kind: "default" };
  try {
    if (!targetDeviceId) modelSelection = parseSpawnAgentModel(args.model, (modelName) => {
      if (!ctx.validateSpawnModel) return false;
      try {
        ctx.validateSpawnModel(modelName);
        return true;
      } catch {
        return false;
      }
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (modelSelection.kind === "model") {
    // Fail the spawn loudly on an unroutable model — never silently fall
    // back to the configured default. A host without a validator can't
    // honor the override, which is also a loud failure, not a fallback.
    if (!ctx.validateSpawnModel && !ctx.validateSpawnModelWithMetadata) {
      return {
        error: `Cannot honor model "${modelSelection.model}": model routing is not available in this runtime. Omit the model parameter to use the configured default.`,
      };
    }
    try {
      if (ctx.validateSpawnModelWithMetadata) {
        await ctx.validateSpawnModelWithMetadata(
          modelSelection.model,
          modelSelection.reasoningEffort,
        );
      } else {
        ctx.validateSpawnModel?.(modelSelection.model);
      }
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  if (typeof maxAgentDepth === "number" && nextAgentDepth > maxAgentDepth) {
    return {
      error: `Task depth limit reached (${maxAgentDepth}). Complete work in the current task instead of creating another subtask.`,
    };
  }

  const prompt = toOptionalString(args.prompt);
  if (!prompt) {
    return { error: "prompt is required" };
  }
  const rawDescription = toOptionalString(args.description);
  if (!rawDescription) {
    return { error: "description is required" };
  }
  // `spawn_agent` asks for a short domain name, so the caller's text is the
  // thread name verbatim. No prompt-derived rewrite behind its back.
  const description = rawDescription;
  if (cloudPlacement) {
    // Re-read the capability rather than falling through: a cloud placement
    // that reached the local branch would run off-device work on the user's
    // machine, which is the one outcome worse than refusing.
    const cloudDispatch = ctx.agentApi?.cloudDispatch;
    if (!cloudDispatch) {
      return {
        error: `This runtime has no cloud connection, so it can only run agents on this computer. Leave destination empty.`,
      };
    }
    const resolveExecution = ctx.resolveCloudExecutionSelection;
    if (!resolveExecution && !targetDeviceId) {
      return {
        error: `A cloud placement cannot resolve this agent's cloud model selection in the current runtime.`,
      };
    }
    let execution: CloudExecutionSelection | undefined;
    try {
      if (resolveExecution && !targetDeviceId) execution = await resolveExecution({
        ...(modelSelection.kind === "model"
          ? {
              model: modelSelection.model,
              spawnEngine: { engine: "default" } as const,
            }
          : {}),
        ...(modelSelection.kind === "engine"
          ? { spawnEngine: modelSelection.engine }
          : {}),
        ...(modelSelection.reasoningEffort
          ? { reasoningEffort: modelSelection.reasoningEffort }
          : {}),
      });
    } catch (error) {
      return { error: (error as Error).message };
    }
    let dispatched: Awaited<ReturnType<typeof cloudDispatch>>;
    try {
      dispatched = await cloudDispatch({
        conversationId: context.conversationId,
        requestId: context.requestId,
        ...(context.ownerGeneration
          ? { ownerGeneration: context.ownerGeneration }
          : {}),
        description,
        prompt,
        ...(execution ? { execution } : {}),
        ...(targetDeviceId ? { targetDeviceId } : {}),
        ...(targetDeviceId && toOptionalString(args.model)
          ? { requestedModel: toOptionalString(args.model)! }
          : {}),
      });
    } catch (error) {
      return { error: (error as Error).message };
    }
    const queuedForDevice = dispatched.waitingForDevice === true;
    return {
      result: {
        thread_id: dispatched.threadId,
        created: true,
        running_in_background: true,
        ...(targetDeviceId
          ? { placement: "device", device_id: targetDeviceId }
          : { placement: "cloud" }),
        cloud_conversation_id: dispatched.conversationId,
        attempt_generation: dispatched.attemptGeneration,
        thread_updated_at: dispatched.threadUpdatedAt,
        thread_status: queuedForDevice ? "queued" : dispatched.status,
        note: queuedForDevice
          ? `Queued for device ${targetDeviceId}. ${DEVICE_AGENT_QUEUED_NOTE} Either way its completion will return to this conversation, including after a desktop restart. Use send_input to continue this thread once it finishes, or pause_agent to stop it.`
          : `${targetDeviceId ? `Running on device ${targetDeviceId}.` : "Running in Stella's cloud."} Its completion will return to this conversation, including after a desktop restart. Use send_input to continue this thread once it finishes, or pause_agent to stop it.`,
      },
    };
  }
  if (ctx.agentApi) {
    logWorkingIndicatorTrace("[stella:working-indicator:spawn_agent]", {
      conversationId: context.conversationId,
      rawDescription,
      description,
      promptPreview: prompt.slice(0, 160),
      rootRunId: context.rootRunId,
    });
    let capturedModelConfig: AgentModelConfigSnapshot | undefined;
    if (
      ctx.captureSpawnModelConfig &&
      (modelSelection.kind !== "default" ||
        context.agentType === AGENT_IDS.ORCHESTRATOR)
    ) {
      try {
        capturedModelConfig = await ctx.captureSpawnModelConfig({
          agentType,
          spawnEngine:
            modelSelection.kind === "model"
              ? { engine: "default" }
              : modelSelection.kind === "engine"
                ? modelSelection.engine
                : { engine: "default" },
          ...(modelSelection.kind === "default"
            ? { useConfiguredEngine: true }
            : {}),
          ...(modelSelection.kind === "model"
            ? { model: modelSelection.model }
            : {}),
          ...(modelSelection.reasoningEffort
            ? { spawnReasoningEffort: modelSelection.reasoningEffort }
            : {}),
        });
      } catch (error) {
        return { error: (error as Error).message };
      }
    }
    let created: Awaited<ReturnType<AgentToolApi["createAgent"]>>;
    try {
      created = await ctx.agentApi.createAgent({
        conversationId: context.conversationId,
        description,
        prompt,
        agentType,
        ...(modelSelection.kind === "model"
          ? { model: modelSelection.model }
          : {}),
        ...(modelSelection.kind === "model"
          ? { spawnEngine: { engine: "default" } as const }
          : {}),
        ...(modelSelection.kind === "engine"
          ? { spawnEngine: modelSelection.engine }
          : {}),
        ...(modelSelection.reasoningEffort
          ? { spawnReasoningEffort: modelSelection.reasoningEffort }
          : {}),
        ...(capturedModelConfig
          ? { modelConfigSnapshot: capturedModelConfig }
          : modelSelection.kind === "default" && context.modelConfigSnapshot
            ? { modelConfigSnapshot: context.modelConfigSnapshot }
            : {}),
        rootRunId: context.rootRunId,
        agentDepth: nextAgentDepth,
        ...(typeof maxAgentDepth === "number" ? { maxAgentDepth } : {}),
        parentAgentId,
        storageMode,
        ...(context.ownerGeneration
          ? { ownerGeneration: context.ownerGeneration }
          : {}),
      });
    } catch (error) {
      // Group member caps and thread-resolution failures surface as tool
      // errors the model can act on, not as runner-level crashes.
      return { error: (error as Error).message };
    }
    const otherThreads =
      context.agentType === AGENT_IDS.ORCHESTRATOR && created.activeThreads
        ? buildOtherThreadsResult(created.activeThreads, created.threadId)
        : [];
    return {
      result: {
        status: "spawned_running_in_background",
        thread_id: created.threadId,
        note: "The agent is now working in the background and has NOT finished. Do not describe the task as if it never started, and do not call send_input to check on it — wait for the [Agent completed] event. In this turn, reply to the user with at most one short line, or say nothing.",
        // Back-compat booleans (kept after status/note so they can't read as "done").
        created: true,
        running_in_background: true,
        follow_up_on_completion: true,
        ...(otherThreads.length > 0 ? { other_threads: otherThreads } : {}),
      },
    };
  }

  // Fallback local in-memory task behavior (used only when no task manager is wired).
  const id = String(ctx.tasks.size + 1);
  const record: AgentRecord = {
    id,
    description,
    status: "running",
    startedAt: Date.now(),
    completedAt: null,
  };
  ctx.tasks.set(id, record);
  const activeThreads = [...ctx.tasks.values()].slice(-16).map((task) => ({
    threadId: task.id,
    description: task.description,
    lastUsedAt: task.completedAt ?? task.startedAt,
    agentStatus: task.status,
  }));
  const otherThreads =
    context.agentType === AGENT_IDS.ORCHESTRATOR
      ? buildOtherThreadsResult(activeThreads, id)
      : [];
  return {
    result: {
      status: "spawned_running_in_background",
      thread_id: id,
      note: "The agent is now working in the background and has NOT finished. Do not describe the task as if it never started, and do not call send_input to check on it — wait for the [Agent completed] event. In this turn, reply to the user with at most one short line, or say nothing.",
      // Back-compat booleans (kept after status/note so they can't read as "done").
      created: true,
      running_in_background: true,
      follow_up_on_completion: true,
      ...(otherThreads.length > 0 ? { other_threads: otherThreads } : {}),
    },
  };
};
