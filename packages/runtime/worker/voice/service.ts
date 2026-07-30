import { createHash } from "node:crypto";
import {
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
  type AgentStreamEventType,
} from "@stella/contracts/agent-runtime";
import type {
  RuntimeAgentEventPayload,
  RuntimePromptMessage,
  RuntimeVoiceAgentEventPayload,
  RuntimeVoiceChatPayload,
  RuntimeVoiceOrchestratorConfig,
  RuntimeVoiceOrchestratorConfigRequest,
  RuntimeVoiceToolCallPayload,
  RuntimeVoiceToolCallResult,
  RuntimeWebSearchResult,
} from "@stella/contracts/protocol";
import type {
  RuntimeEndEvent,
  RuntimeErrorEvent,
  RuntimeStatusEvent,
  RuntimeStreamEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
} from "../../kernel/agent-runtime.js";
import type { AgentLifecycleEvent } from "../../kernel/agents/local-agent-manager.js";
import type { ToolContext, ToolResult } from "../../kernel/tools/types.js";
import { textFromUnknown } from "../../kernel/agent-runtime/shared.js";
import {
  sanitizeToolError,
  sanitizeToolResult,
  sanitizeToolVisibleText,
} from "../../kernel/tools/safety.js";
import type { AgentMessage } from "../../kernel/agent-core/types.js";
import type { CloudJournalAppendRecord } from "../../kernel/runner/cloud-transcript-write.js";
import type { VoiceToolCallReceipt } from "../../kernel/storage/runtime-store.js";

type VoiceRunner = {
  handleLocalChat: (
    payload: {
      conversationId: string;
      userMessageId: string;
      userPrompt: string;
      promptMessages?: RuntimePromptMessage[];
      agentType?: string;
      storageMode?: "cloud" | "local";
    },
    callbacks: {
      onStream: (event: RuntimeStreamEvent) => void;
      onStatus?: (event: RuntimeStatusEvent) => void;
      onToolStart: (event: RuntimeToolStartEvent) => void;
      onToolEnd: (event: RuntimeToolEndEvent) => void;
      onError: (event: RuntimeErrorEvent) => void;
      onEnd: (event: RuntimeEndEvent) => void;
      onAgentEvent?: (event: AgentLifecycleEvent) => void;
    },
  ) => Promise<{ runId: string }>;
  appendCloudJournal: (request: {
    conversationId: string;
    appendId: string;
    records: CloudJournalAppendRecord[];
  }) => Promise<{ queued: true; replayed: boolean }>;
  beginVoiceToolCallReceipt: (args: {
    conversationId: string;
    callId: string;
    requestFingerprint: string;
    operationId: string;
    startedAt: number;
  }) => VoiceToolCallReceipt;
  completeVoiceToolCallReceipt: (args: {
    conversationId: string;
    callId: string;
    requestFingerprint: string;
    completionJson: string;
  }) => void;
  getVoiceOrchestratorConfig: (
    payload: RuntimeVoiceOrchestratorConfigRequest,
  ) => Promise<RuntimeVoiceOrchestratorConfig>;
  executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
  webSearch: (
    query: string,
    options?: { category?: string },
  ) => Promise<RuntimeWebSearchResult>;
};

type PendingVoiceRequest = {
  payload: RuntimeVoiceChatPayload;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

type VoiceToolCatalogCacheEntry = {
  config: RuntimeVoiceOrchestratorConfig;
  cachedAt: number;
};

type VoiceRuntimeServiceOptions = {
  getRunner: () => VoiceRunner | null;
  getDeviceId: () => string | null;
  emitAgentEvent: (payload: RuntimeVoiceAgentEventPayload) => void;
};

const normalizeError = (error: unknown) =>
  error instanceof Error
    ? error
    : new Error(String(error ?? "Unknown voice runtime error"));

const VOICE_TOOL_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS = 30_000;
const THREAD_VISIBLE_JSON_MAX_CHARS = 12_000;
const EPHEMERAL_VOICE_CONTEXT_MAX_MESSAGES = 40;
const EPHEMERAL_VOICE_CONTEXT_MAX_CHARS = 40_000;
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
} as const;

const truncate = (value: string, maxChars: number): string =>
  value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}...(truncated)`;

const stringifyBounded = (value: unknown, maxChars: number): string => {
  if (typeof value === "string") return truncate(value.trim(), maxChars);
  try {
    return truncate(JSON.stringify(value), maxChars);
  } catch {
    return truncate(String(value), maxChars);
  }
};

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJsonValue(entry)]),
    );
  }
  return value;
};

const voiceAppendId = (
  kind: "transcript" | "tool" | "operation",
  identity: string,
): string =>
  `voice-${kind}:${createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 40)}`;

const voiceAssistantMessage = (
  content: Array<Record<string, unknown>>,
  timestamp: number,
  extra: Record<string, unknown> = {},
): AgentMessage =>
  ({
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "stella",
    model: "voice",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp,
    source: "voice",
    ...extra,
  }) as unknown as AgentMessage;

const formatModelVisibleToolOutput = (result: ToolResult): string => {
  if (result.error) {
    return `Error: ${sanitizeToolError(result.error)}`;
  }
  return sanitizeToolVisibleText(
    truncate(
      textFromUnknown(sanitizeToolResult(result.result)),
      MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS,
    ),
  );
};

type VoiceToolCompletion = {
  response: RuntimeVoiceToolCallResult;
  records: CloudJournalAppendRecord[];
};

const parseVoiceToolCompletion = (serialized: string): VoiceToolCompletion => {
  const parsed = JSON.parse(serialized) as Partial<VoiceToolCompletion>;
  if (
    !parsed.response ||
    typeof parsed.response.output !== "string" ||
    !Array.isArray(parsed.records) ||
    !parsed.records.every(
      (record) =>
        record?.kind === "message" &&
        (record.role === "assistant" || record.role === "toolResult") &&
        typeof record.payloadJson === "string",
    )
  ) {
    throw new Error("Voice tool completion receipt is malformed.");
  }
  return {
    response: parsed.response,
    records: parsed.records,
  };
};

export class VoiceRuntimeService {
  private pendingVoiceRequest: PendingVoiceRequest | null = null;
  private voiceRequestActive = false;
  private toolConfigCache = new Map<string, VoiceToolCatalogCacheEntry>();
  /** Voice-only prompt bridge. Never written to runtime_thread_entries. */
  private ephemeralContextByConversation = new Map<
    string,
    RuntimePromptMessage[]
  >();

  constructor(private readonly options: VoiceRuntimeServiceOptions) {}

  async persistTranscript(payload: {
    conversationId: string;
    eventId: string;
    timestamp: number;
    role: "user" | "assistant";
    text: string;
    uiVisibility?: "visible" | "hidden";
    voiceSession?: { durationMs: number };
  }) {
    const runner = this.ensureRunner();
    const eventId = payload.eventId.trim();
    if (!eventId) {
      throw new Error("Voice transcript eventId is required.");
    }
    if (
      !Number.isFinite(payload.timestamp) ||
      payload.timestamp < 0 ||
      !Number.isSafeInteger(payload.timestamp)
    ) {
      throw new Error("Voice transcript timestamp is invalid.");
    }
    const timestamp = payload.timestamp;
    const message =
      payload.role === "user"
        ? ({
            role: "user",
            content: [{ type: "text", text: payload.text }],
            timestamp,
            source: "voice",
            ...(payload.voiceSession
              ? { voiceSession: payload.voiceSession }
              : {}),
          } as unknown as AgentMessage)
        : voiceAssistantMessage(
            [{ type: "text", text: payload.text }],
            timestamp,
            payload.voiceSession
              ? { voiceSession: payload.voiceSession }
              : undefined,
          );
    const queued = await runner.appendCloudJournal({
      conversationId: payload.conversationId,
      appendId: voiceAppendId("transcript", eventId),
      records: [
        {
          kind: "message",
          role: payload.role,
          payloadJson: JSON.stringify(message),
          hidden: payload.uiVisibility === "hidden",
        },
      ],
    });
    // The cloud outbox insertion is the acknowledgement boundary. Mirror the
    // text into local operational context only for the first admission so an
    // invoke retry whose response was lost cannot duplicate model history.
    if (!queued.replayed) {
      this.appendEphemeralContext(
        payload.conversationId,
        `${payload.role === "user" ? "Voice user" : "Voice assistant"}: ${payload.text}`,
      );
    }
    return { ok: true as const };
  }

  async webSearch(payload: { query: string; category?: string }) {
    return await this.ensureRunner().webSearch(payload.query, {
      category: payload.category,
    });
  }

  async getOrchestratorConfig(
    payload: RuntimeVoiceOrchestratorConfigRequest,
  ): Promise<RuntimeVoiceOrchestratorConfig> {
    const config =
      await this.ensureRunner().getVoiceOrchestratorConfig(payload);
    this.toolConfigCache.set(payload.conversationId, {
      config,
      cachedAt: Date.now(),
    });
    return config;
  }

  async executeTool(
    payload: RuntimeVoiceToolCallPayload,
  ): Promise<RuntimeVoiceToolCallResult> {
    const runner = this.ensureRunner();
    const config = await this.resolveToolConfig(payload.conversationId);
    const allowedToolNames = config.tools.map((tool) => tool.name);
    const allowed = new Set(allowedToolNames);
    const callId = payload.callId.trim();
    if (!callId) throw new Error("Voice tool callId is required.");
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          stableJsonValue({
            name: payload.name,
            args: payload.args,
          }),
        ),
      )
      .digest("hex");
    const receipt = runner.beginVoiceToolCallReceipt({
      conversationId: payload.conversationId,
      callId,
      requestFingerprint,
      operationId: voiceAppendId(
        "operation",
        `${payload.conversationId}\u0000${callId}`,
      ),
      startedAt: Date.now(),
    });
    if (receipt.status === "pending") {
      throw new Error(
        "This voice tool call was interrupted after it started and cannot be repeated safely.",
      );
    }
    if (receipt.status === "completed") {
      const completion = parseVoiceToolCompletion(receipt.completionJson);
      await runner.appendCloudJournal({
        conversationId: payload.conversationId,
        appendId: voiceAppendId("tool", callId),
        records: completion.records,
      });
      return completion.response;
    }
    const runId = receipt.operationId;

    this.recordVoiceToolRequest(payload);

    let result: ToolResult;
    if (!allowed.has(payload.name)) {
      result = {
        error: `${payload.name} is not available to the voice orchestrator.`,
      };
    } else {
      result = await runner.executeTool(payload.name, payload.args, {
        conversationId: payload.conversationId,
        deviceId: this.options.getDeviceId() ?? "unknown",
        requestId: receipt.operationId,
        runId,
        rootRunId: runId,
        agentType: "orchestrator",
        storageMode: "cloud",
        allowedToolNames,
      });
    }

    const output = formatModelVisibleToolOutput(result);
    this.recordVoiceToolResult(payload, result, output);
    const details = sanitizeToolResult(result.details ?? result.result);
    const response: RuntimeVoiceToolCallResult = {
      output,
      ...(details !== undefined ? { details } : {}),
      ...(result.fileChanges?.length
        ? { fileChanges: result.fileChanges }
        : {}),
      ...(result.producedFiles?.length
        ? { producedFiles: result.producedFiles }
        : {}),
      ...(result.error ? { error: sanitizeToolError(result.error) } : {}),
    };
    const records = this.buildCloudVoiceToolExchange(
      payload,
      result,
      output,
      receipt.startedAt,
    );
    runner.completeVoiceToolCallReceipt({
      conversationId: payload.conversationId,
      callId,
      requestFingerprint,
      completionJson: JSON.stringify({ response, records }),
    });
    await runner.appendCloudJournal({
      conversationId: payload.conversationId,
      appendId: voiceAppendId("tool", callId),
      records,
    });
    return response;
  }

  async orchestratorChat(payload: RuntimeVoiceChatPayload) {
    if (this.voiceRequestActive) {
      if (this.pendingVoiceRequest) {
        this.pendingVoiceRequest.reject(
          new Error("Superseded by newer voice request"),
        );
      }
      return await new Promise<string>((resolve, reject) => {
        this.pendingVoiceRequest = { payload, resolve, reject };
      });
    }

    this.voiceRequestActive = true;
    try {
      return await this.executeVoiceChat(payload);
    } finally {
      await this.drainVoiceQueue();
    }
  }

  isBusy() {
    return this.voiceRequestActive;
  }

  getPendingRequestCount() {
    return this.pendingVoiceRequest ? 1 : 0;
  }

  private ensureRunner() {
    const runner = this.options.getRunner();
    if (!runner) {
      throw new Error("Stella runtime not initialized");
    }
    return runner;
  }

  private async resolveToolConfig(
    conversationId: string,
  ): Promise<RuntimeVoiceOrchestratorConfig> {
    const cached = this.toolConfigCache.get(conversationId);
    if (
      cached &&
      Date.now() - cached.cachedAt < VOICE_TOOL_CONFIG_CACHE_TTL_MS
    ) {
      return cached.config;
    }
    return await this.getOrchestratorConfig({ conversationId });
  }

  private recordVoiceToolRequest(payload: RuntimeVoiceToolCallPayload) {
    this.appendEphemeralContext(
      payload.conversationId,
      [
        `[Tool call] ${payload.name}`,
        `request_id: ${payload.callId}`,
        `args: ${stringifyBounded(payload.args, THREAD_VISIBLE_JSON_MAX_CHARS)}`,
      ].join("\n"),
    );
  }

  private recordVoiceToolResult(
    payload: RuntimeVoiceToolCallPayload,
    result: ToolResult,
    output: string,
  ) {
    const content = result.error
      ? [
          `[Tool result] ${payload.name}`,
          `request_id: ${payload.callId}`,
          `error: ${sanitizeToolError(result.error)}`,
        ].join("\n")
      : [
          `[Tool result] ${payload.name}`,
          `request_id: ${payload.callId}`,
          `result: ${stringifyBounded(output, THREAD_VISIBLE_JSON_MAX_CHARS)}`,
        ].join("\n");
    this.appendEphemeralContext(payload.conversationId, content);
  }

  private appendEphemeralContext(conversationId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const current =
      this.ephemeralContextByConversation.get(conversationId) ?? [];
    current.push({
      text: trimmed.slice(0, EPHEMERAL_VOICE_CONTEXT_MAX_CHARS),
      uiVisibility: "hidden",
      messageType: "message",
      display: false,
    });
    while (
      current.length > EPHEMERAL_VOICE_CONTEXT_MAX_MESSAGES ||
      current.reduce((total, entry) => total + entry.text.length, 0) >
        EPHEMERAL_VOICE_CONTEXT_MAX_CHARS
    ) {
      current.shift();
    }
    this.ephemeralContextByConversation.set(conversationId, current);
  }

  private buildCloudVoiceToolExchange(
    payload: RuntimeVoiceToolCallPayload,
    result: ToolResult,
    output: string,
    timestamp: number,
  ): CloudJournalAppendRecord[] {
    const request = voiceAssistantMessage(
      [
        {
          type: "toolCall",
          id: payload.callId,
          name: payload.name,
          arguments: payload.args,
        },
      ],
      timestamp,
      { stopReason: "toolUse" },
    );
    const response = {
      role: "toolResult",
      toolCallId: payload.callId,
      toolName: payload.name,
      content: [{ type: "text", text: output }],
      details: sanitizeToolResult(result.details ?? result.result),
      isError: Boolean(result.error),
      timestamp: timestamp + 1,
      source: "voice",
      ...(result.fileChanges?.length
        ? { fileChanges: result.fileChanges }
        : {}),
      ...(result.producedFiles?.length
        ? { producedFiles: result.producedFiles }
        : {}),
    } as unknown as AgentMessage;
    return [
      {
        kind: "message",
        role: "assistant",
        payloadJson: JSON.stringify(request),
      },
      {
        kind: "message",
        role: "toolResult",
        payloadJson: JSON.stringify(response),
      },
    ];
  }

  private async drainVoiceQueue() {
    const pending = this.pendingVoiceRequest;
    this.pendingVoiceRequest = null;

    if (!pending) {
      this.voiceRequestActive = false;
      return;
    }

    try {
      pending.resolve(await this.executeVoiceChat(pending.payload));
    } catch (error) {
      pending.reject(normalizeError(error));
    } finally {
      await this.drainVoiceQueue();
    }
  }

  private async executeVoiceChat(payload: RuntimeVoiceChatPayload) {
    const runner = this.ensureRunner();
    let activeRunId = "";
    let fullText = "";
    let syntheticSeq = 1;
    let settled = false;

    const resolveOnce = (resolve: (value: string) => void, value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const rejectOnce = (reject: (error: Error) => void, error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(normalizeError(error));
    };

    return await new Promise<string>((resolve, reject) => {
      const emitAgentEvent = (
        event: Omit<RuntimeAgentEventPayload, "type">,
        type: AgentStreamEventType,
      ) => {
        this.options.emitAgentEvent({
          requestId: payload.requestId,
          event: {
            ...event,
            type,
          },
        });
      };

      runner
        .handleLocalChat(
          {
            conversationId: payload.conversationId,
            userMessageId: `voice-${Date.now()}`,
            userPrompt: payload.message,
            promptMessages: [
              ...(this.ephemeralContextByConversation.get(
                payload.conversationId,
              ) ?? []),
            ],
            agentType: "orchestrator",
            storageMode: "cloud",
          },
          {
            onStream: (event) => {
              if (event.chunk) {
                fullText += event.chunk;
              }
              emitAgentEvent(event, AGENT_STREAM_EVENT_TYPES.STREAM);
            },
            onStatus: (event) =>
              emitAgentEvent(event, AGENT_STREAM_EVENT_TYPES.STATUS),
            onToolStart: (event) =>
              emitAgentEvent(event, AGENT_STREAM_EVENT_TYPES.TOOL_START),
            onToolEnd: (event) =>
              emitAgentEvent(event, AGENT_STREAM_EVENT_TYPES.TOOL_END),
            onAgentEvent: (event) => {
              this.options.emitAgentEvent({
                requestId: payload.requestId,
                event: {
                  type: event.type,
                  runId:
                    event.rootRunId ?? activeRunId ?? payload.conversationId,
                  seq: syntheticSeq++,
                  agentId: event.agentId,
                  agentType: event.agentType,
                  description: event.description,
                  parentAgentId: event.parentAgentId,
                  result: event.result,
                  error: event.error,
                  statusText: event.statusText,
                },
              });
            },
            onEnd: (event) => {
              this.options.emitAgentEvent({
                requestId: payload.requestId,
                event: {
                  ...event,
                  type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                  outcome: AGENT_RUN_FINISH_OUTCOMES.COMPLETED,
                },
              });
              resolveOnce(resolve, (event.finalText ?? fullText) || "Done.");
            },
            onError: (event) => {
              this.options.emitAgentEvent({
                requestId: payload.requestId,
                event: {
                  ...event,
                  type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                  outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
                  reason: event.error,
                },
              });
              rejectOnce(reject, event.error ?? "Unknown voice runtime error");
            },
          },
        )
        .then(({ runId }) => {
          activeRunId = runId;
          return { runId };
        })
        .catch((error) => {
          rejectOnce(reject, error);
          return undefined;
        });
    });
  }
}
