/**
 * An orchestrator chat turn run by the real Claude Code CLI.
 *
 * The OrchestratorSession DO owns the system prompt, the tools, and the
 * journal; this mode only runs `claude` against them. The CLI sees the DO's
 * catalog through the private MCP host, and every call is forwarded to the DO
 * over the turn broker under the CLI's own `tool_use` id. Finished assistant
 * messages, status changes, and usage are batched (~500 ms) into ordered event
 * frames the DO journals. No `text_delta` frames are sent: the DO does not
 * broadcast partial text yet, and each frame costs a bounded broker request.
 * Native session state (CLAUDE_CONFIG_DIR) is sealed and checkpointed exactly
 * as an agent thread's is; the BuildSession turns this result into the DO's
 * terminal frame.
 *
 *   claude --MCP--> executeTool --broker tool--> BuildSession --> DO
 *   claude --stream-json--> batches --broker events--> BuildSession --> DO
 */

import {
  CLOUD_ORCHESTRATOR_BROKER_PATHS,
  parseCloudOrchestratorCliTurnSpec,
  type CloudCliAssistantMessage,
  type CloudCliUsage,
  type CloudOrchestratorEvent,
  type CloudOrchestratorEventBatch,
  type CloudOrchestratorToolCallRequest,
  type CloudOrchestratorToolResult,
} from "@stella/contracts/cloud-orchestrator-cli";
import {
  buildClaudeCodeNativeToolRuntimePrompt,
  createClaudeNativeToolUseCorrelator,
  getClaudeCodeStatusChangeFromStreamEvent,
} from "@stella/runtime/kernel/integrations/claude-code-session-runtime.js";
import { createClaudeCodeToolMcpHost } from "@stella/runtime/kernel/integrations/claude-code-tool-mcp-host.js";
import {
  TOOL_RESULT_AUTHORIZED_IMAGES,
  type AuthorizedToolImage,
  type ToolResult,
} from "@stella/runtime/kernel/tools/types.js";
import {
  commitTurnStateBeforeTranscript,
  createBuilderFallbackAgentTurnResult,
  parseCloudModelGatewayInput,
  type AgentTurnInput,
  type AgentTurnResult,
} from "./agent-turn.js";
import { parseAuthoritativeAgentHistory } from "./agent-history.js";
import {
  CLOUD_CLAUDE_MCP_SERVER_NAME,
  cloudClaudeRoleProfile,
  nativeHistoryCursorFromMessages,
  nativeHistoryCursorFromRows,
  runNativeAgentTurn,
  type ClaudeStreamJsonEvent,
} from "./native-agent-turn.js";
import { createNativeTurnCancellation } from "./turn-cancellation.js";
import type { TurnCredentialBrokerClient } from "./turn-credential-broker.js";

export type OrchestratorTurnInput = Extract<
  AgentTurnInput,
  { role: "orchestrator" }
>;

type Usage = AgentTurnResult["usage"];
type Broker = Pick<TurnCredentialBrokerClient, "postJson">;

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, llmCalls: 0 };
/**
 * Pending events are coalesced for this long before they are posted. The
 * broker admits a bounded number of requests per attempt (4096), and only a
 * finished message, a status change, or usage is sent, so a batch is at most
 * one request per model round plus a few.
 */
export const ORCHESTRATOR_EVENT_BATCH_MS = 500;
/** Backoff before each retry of a retryable broker answer (~7.5 s total). */
const BROKER_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];
const MCP_TOOL_PREFIX = `mcp__${CLOUD_CLAUDE_MCP_SERVER_NAME}__`;

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const numberAt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The DO no longer names this turn active; nothing more may run for it. */
export class OrchestratorTurnInactiveError extends Error {
  constructor(message = "This chat turn is no longer active.") {
    super(message);
    this.name = "OrchestratorTurnInactiveError";
  }
}

/**
 * The BuildSession answers 410 when the DO refused the frame (the turn is
 * over) and 503 when the DO was unreachable, busy, or failed; both frames
 * are idempotent at the DO (a replayed batchSeq is acknowledged, a replayed
 * toolCallId with identical args returns its recorded result), so 503/429
 * are retried with the identical body. A thrown error means the broker
 * client closed itself, and nothing can be sent for this attempt any more.
 */
export const postToBrokerWithRetry = async (
  broker: Broker,
  target: string,
  body: unknown,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await broker.postJson(target, body);
    const retryable = response.status === 503 || response.status === 429;
    const delay = BROKER_RETRY_DELAYS_MS[attempt];
    if (!retryable || delay === undefined) return response;
    await response.body?.cancel().catch(() => undefined);
    await sleep(delay);
  }
};

const isTurnOverStatus = (status: number): boolean =>
  status === 410 || status === 409;

// ---------------------------------------------------------------------------
// Ordered event frames
// ---------------------------------------------------------------------------

/**
 * One ordered lane to the broker. Event batches get strictly increasing
 * `batchSeq` values and each waits for the previous acknowledgement; tool
 * calls ride the same chain, so every batch queued before a call (its
 * assistant `tool_use` included) is delivered before the call is forwarded.
 */
export class OrchestratorEventLane {
  #pending: CloudOrchestratorEvent[] = [];
  #batchSeq = 0;
  #chain: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #failure: Error | undefined;

  constructor(
    private readonly broker: Broker,
    private readonly onFatal: (error: Error) => void,
    private readonly batchMs = ORCHESTRATOR_EVENT_BATCH_MS,
  ) {}

  get failure(): Error | undefined {
    return this.#failure;
  }

  emit(event: CloudOrchestratorEvent): void {
    if (this.#failure) return;
    const last = this.#pending.at(-1);
    if (event.type === "usage" && last?.type === "usage") {
      this.#pending[this.#pending.length - 1] = event;
    } else {
      this.#pending.push(event);
    }
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.batchMs);
  }

  /** Queue everything pending as the next batch; resolves once delivered. */
  flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#pending.length > 0 && !this.#failure) {
      const batch: CloudOrchestratorEventBatch = {
        batchSeq: ++this.#batchSeq,
        events: this.#pending,
      };
      this.#pending = [];
      this.#chain = this.#chain.then(() => this.#post(batch));
    }
    return this.#chain;
  }

  /** Run `task` after every batch queued so far has been delivered. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    void this.flush();
    const run = this.#chain.then(() => {
      if (this.#failure) throw this.#failure;
      return task();
    });
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#pending = [];
    this.onFatal(error);
  }

  async #post(batch: CloudOrchestratorEventBatch): Promise<void> {
    if (this.#failure) return;
    let response: Response;
    try {
      response = await postToBrokerWithRetry(
        this.broker,
        CLOUD_ORCHESTRATOR_BROKER_PATHS.events,
        batch,
      );
    } catch (error) {
      this.#fail(
        new Error(
          `Stella lost this chat turn's event stream: ${asError(error).message}`,
        ),
      );
      return;
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return;
    // 410: the DO ended the turn. Anything else (a 409 sequence gap, retries
    // exhausted) leaves the journal unable to follow this stream.
    this.#fail(
      response.status === 410
        ? new OrchestratorTurnInactiveError()
        : new Error(
            `Stella couldn't deliver this chat turn's events (${response.status}).`,
          ),
    );
  }
}

// ---------------------------------------------------------------------------
// stream-json -> CloudOrchestratorEvent
// ---------------------------------------------------------------------------

type OpenAssistantMessage = {
  id: string;
  model: string;
  content: CloudCliAssistantMessage["content"];
  toolUseIds: string[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  stopReason?: string;
};

const mergeUsage = (
  target: OpenAssistantMessage["usage"],
  value: unknown,
): void => {
  const usage = asRecord(value);
  if (!usage) return;
  target.input = numberAt(usage.input_tokens) ?? target.input;
  target.output = numberAt(usage.output_tokens) ?? target.output;
  target.cacheRead =
    numberAt(usage.cache_read_input_tokens) ?? target.cacheRead;
  target.cacheWrite =
    numberAt(usage.cache_creation_input_tokens) ?? target.cacheWrite;
};

const stopReasonOf = (
  value: string | undefined,
): Pick<CloudCliAssistantMessage, "stopReason" | "errorMessage"> => {
  switch (value) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return { stopReason: "stop" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { stopReason: "length" };
    case "refusal":
      return {
        stopReason: "error",
        errorMessage: "The model stopped this response.",
      };
    default:
      return { stopReason: "aborted" };
  }
};

/**
 * Turns the CLI's stream into DO events. The CLI emits one `assistant` event
 * per finished content block, all sharing the API message id, and starts
 * executing a `tool_use` before the rest of its message has streamed; so
 * blocks are collected per message and the message is journaled once, at
 * `message_stop` (or when the next message, the result, or exit closes it).
 * A tool call waits for that so its assistant row always precedes its result.
 */
export class CliAssistantAssembler {
  #open: OpenAssistantMessage | undefined;
  #journaled = new Set<string>();
  #waiters = new Map<string, Array<() => void>>();
  #closed = false;
  #inputTokens = 0;
  #outputTokens = 0;
  #llmCalls = 0;

  constructor(
    private readonly emit: (event: CloudOrchestratorEvent) => void,
    private readonly fallbackModel: string,
  ) {}

  observe(event: ClaudeStreamJsonEvent): void {
    const status = getClaudeCodeStatusChangeFromStreamEvent(event);
    if (status) {
      this.emit({
        type: "status",
        state: status.state === "compacting" ? "compacting" : "running",
        text: status.text,
      });
      return;
    }
    if (event.type === "stream_event") {
      const source = asRecord(event.event);
      if (source?.type === "message_start") {
        const message = asRecord(source.message);
        this.#start(message);
      } else if (source?.type === "message_delta" && this.#open) {
        const delta = asRecord(source.delta);
        if (typeof delta?.stop_reason === "string") {
          this.#open.stopReason = delta.stop_reason;
        }
        mergeUsage(this.#open.usage, source.usage);
      } else if (source?.type === "message_stop") {
        this.#finalize();
      }
      return;
    }
    if (event.type === "assistant") {
      const message = asRecord(event.message);
      const id = typeof message?.id === "string" ? message.id : "";
      if (!this.#open || this.#open.id !== id) this.#start(message);
      const open = this.#open!;
      if (!Array.isArray(message?.content)) return;
      for (const raw of message.content) {
        const block = asRecord(raw);
        if (block?.type === "text" && typeof block.text === "string") {
          open.content.push({ type: "text", text: block.text });
        } else if (
          block?.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          open.content.push({
            type: "thinking",
            thinking: block.thinking,
            ...(typeof block.signature === "string"
              ? { thinkingSignature: block.signature }
              : {}),
          });
        } else if (
          block?.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          open.toolUseIds.push(block.id);
          open.content.push({
            type: "toolCall",
            id: block.id,
            name: block.name.startsWith(MCP_TOOL_PREFIX)
              ? block.name.slice(MCP_TOOL_PREFIX.length)
              : block.name,
            arguments: asRecord(block.input) ?? {},
          });
        }
      }
      return;
    }
    if (event.type === "result") this.#finalize();
  }

  /** Resolves once the assistant message carrying `toolUseId` is queued. */
  waitForToolUse(toolUseId: string, signal?: AbortSignal): Promise<void> {
    if (this.#closed || this.#journaled.has(toolUseId)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entries = this.#waiters.get(toolUseId) ?? [];
      const onAbort = () => {
        const index = entries.indexOf(done);
        if (index >= 0) entries.splice(index, 1);
        reject(signal?.reason ?? new Error("Tool call aborted."));
      };
      const done = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      entries.push(done);
      this.#waiters.set(toolUseId, entries);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  /** Cumulative usage of the messages journaled so far. */
  get usage(): Usage {
    return {
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      llmCalls: this.#llmCalls,
    };
  }

  /** Journal whatever is still open; the CLI is gone. */
  close(): void {
    this.#finalize();
    this.#closed = true;
    for (const entries of this.#waiters.values()) {
      for (const resolve of entries.splice(0)) resolve();
    }
    this.#waiters.clear();
  }

  #start(message: Record<string, unknown> | null): void {
    this.#finalize();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    mergeUsage(usage, message?.usage);
    this.#open = {
      id: typeof message?.id === "string" ? message.id : "",
      model:
        typeof message?.model === "string" && message.model
          ? message.model
          : this.fallbackModel,
      content: [],
      toolUseIds: [],
      usage,
    };
  }

  #finalize(): void {
    const open = this.#open;
    this.#open = undefined;
    if (!open || open.content.length === 0) return;
    const usage: CloudCliUsage = {
      input: open.usage.input,
      output: open.usage.output,
      cacheRead: open.usage.cacheRead,
      cacheWrite: open.usage.cacheWrite,
      totalTokens:
        open.usage.input +
        open.usage.output +
        open.usage.cacheRead +
        open.usage.cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    this.emit({
      type: "assistant_message",
      message: {
        role: "assistant",
        content: open.content,
        api: "claude-code",
        provider: "anthropic",
        model: open.model,
        ...(open.id ? { responseId: open.id } : {}),
        usage,
        ...stopReasonOf(open.stopReason),
        timestamp: Date.now(),
      },
    });
    this.#llmCalls += 1;
    this.#inputTokens += usage.input + usage.cacheRead + usage.cacheWrite;
    this.#outputTokens += usage.output;
    this.emit({
      type: "usage",
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      llmCalls: this.#llmCalls,
    });
    for (const id of open.toolUseIds) {
      this.#journaled.add(id);
      const entries = this.#waiters.get(id);
      this.#waiters.delete(id);
      for (const resolve of entries ?? []) resolve();
    }
  }
}

// ---------------------------------------------------------------------------
// Tool forwarding
// ---------------------------------------------------------------------------

const AUTHORIZED_IMAGE_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** The DO's serialized AgentToolResult as the MCP host's ToolResult. */
export const toolResultFromOrchestrator = (
  result: CloudOrchestratorToolResult,
): ToolResult => {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .flatMap((block) =>
      block?.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
  if (result.isError) {
    return { error: text || "The tool failed." };
  }
  const images: AuthorizedToolImage[] = content.flatMap((block) =>
    block?.type === "image" &&
    typeof block.data === "string" &&
    AUTHORIZED_IMAGE_TYPES.has(block.mimeType)
      ? [
          {
            data: Buffer.from(block.data, "base64"),
            mimeType: block.mimeType as AuthorizedToolImage["mimeType"],
            sourcePath: "stella-orchestrator-tool",
          },
        ]
      : [],
  );
  // `details` are the DO's UI metadata; the model only ever sees content.
  return {
    result: text,
    ...(images.length > 0 ? { [TOOL_RESULT_AUTHORIZED_IMAGES]: images } : {}),
  };
};

/**
 * Read the broker's answer to one forwarded call. A refusal for an inactive
 * turn ends the turn; an unknown tool or an id conflict is the model's tool
 * error (nothing ran); anything else unexpected is a tool error too.
 */
export const readOrchestratorToolResponse = async (
  response: Response,
  toolName: string,
): Promise<ToolResult> => {
  if (isTurnOverStatus(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw new OrchestratorTurnInactiveError();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Stella couldn't run ${toolName} (${response.status}).`);
  }
  const body = asRecord(await response.json().catch(() => null));
  if (body?.ok === true) {
    const result = asRecord(body.result);
    if (result && Array.isArray(result.content)) {
      return toolResultFromOrchestrator(
        result as unknown as CloudOrchestratorToolResult,
      );
    }
  } else if (body?.ok === false) {
    const error = asRecord(body.error);
    const message =
      typeof error?.message === "string" && error.message
        ? error.message
        : `Stella refused ${toolName}.`;
    if (error?.code === "turn_inactive") {
      throw new OrchestratorTurnInactiveError(message);
    }
    throw new Error(message);
  }
  throw new Error(`Stella returned an unreadable result for ${toolName}.`);
};

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

const failed = (error: string): AgentTurnResult => ({
  ok: false,
  finalText: "",
  error,
  usage: EMPTY_USAGE,
  checkpointPolicy: "preserve_prior",
});

export const runOrchestratorTurn = async (args: {
  input: OrchestratorTurnInput;
  broker: TurnCredentialBrokerClient;
}): Promise<AgentTurnResult> => {
  const { input, broker } = args;
  const spec = parseCloudOrchestratorCliTurnSpec({
    systemPrompt: input.systemPrompt,
    toolCatalog: input.toolCatalog,
  });
  if (!spec) {
    return failed(
      "Stella couldn't validate this chat turn's tools. Try again.",
    );
  }
  const modelGateway = parseCloudModelGatewayInput(input.modelGateway);
  const execution = input.execution;
  if (!modelGateway || execution.engine !== "anthropic") {
    return failed(
      "Stella couldn't validate this chat turn's Claude access. Try again.",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.nativeStateIntegrityKey)) {
    return failed(
      "Stella couldn't validate this chat's Claude session state. Try again.",
    );
  }
  try {
    parseAuthoritativeAgentHistory(input.history ?? []);
  } catch (error) {
    console.error(
      `authoritative orchestrator history rejected: ${asError(error).message}`,
    );
    return failed("Stella couldn't validate this chat's history. Try again.");
  }

  // The DO ending the turn (inactive / lost event stream) must kill the CLI
  // from a tool call or the event lane. The latch is one-shot, so the first
  // reason is the one the turn reports.
  const turnCancellation = createNativeTurnCancellation();
  const abortTurn = (error: Error): void => {
    turnCancellation.abort(error);
  };
  const lane = new OrchestratorEventLane(broker, abortTurn);
  const assembler = new CliAssistantAssembler(
    (event) => lane.emit(event),
    execution.model,
  );
  const correlator = createClaudeNativeToolUseCorrelator();
  const identityScope = `${input.threadId}:${input.turnId}`;

  const executeTool = async (
    toolCallId: string,
    name: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> => {
    await assembler.waitForToolUse(toolCallId, signal);
    const request: CloudOrchestratorToolCallRequest = {
      toolCallId,
      name,
      args: toolArgs,
    };
    // No caller signal: aborting a broker request closes the whole client.
    let response: Response;
    try {
      response = await lane.enqueue(() =>
        postToBrokerWithRetry(
          broker,
          CLOUD_ORCHESTRATOR_BROKER_PATHS.tool,
          request,
        ),
      );
    } catch (error) {
      // The lane failed or the broker client closed itself: no later frame
      // can reach the DO for this attempt, so the turn ends here.
      const lost =
        lane.failure ??
        new Error(
          `Stella lost this chat turn's tool channel: ${asError(error).message}`,
        );
      abortTurn(lost);
      throw lost;
    }
    try {
      return await readOrchestratorToolResponse(response, name);
    } catch (error) {
      if (error instanceof OrchestratorTurnInactiveError) abortTurn(error);
      throw error;
    }
  };

  let mcpHost: Awaited<ReturnType<typeof createClaudeCodeToolMcpHost>>;
  try {
    mcpHost = await createClaudeCodeToolMcpHost({
      tools: spec.toolCatalog,
      identityScope,
      allowLegacyImagePathReopen: false,
      getActiveTurn: () => ({
        identityScope,
        nativeToolCallIds: true,
        claimNativeToolUseId: (toolName, toolArgs, signal) =>
          correlator.claim(toolName, toolArgs, signal),
        checkToolUseIntegrity: (toolName, toolArgs, signal) =>
          correlator.resolveToolUseIntegrity(toolName, toolArgs, signal),
        executeTool,
      }),
    });
  } catch (error) {
    return failed(
      `Stella couldn't prepare this chat turn's tools: ${asError(error).message}`,
    );
  }

  let finalText = "";
  let error: string | undefined;
  let usage: Usage = EMPTY_USAGE;
  let historyCursor: string;
  let transcriptRows: Array<{
    ordinal: number;
    role: string;
    payloadJson: string;
  }>;
  let nativeCheckpoint:
    | Awaited<ReturnType<typeof runNativeAgentTurn>>["nativeStateCheckpoint"]
    | undefined;
  try {
    let native: Awaited<ReturnType<typeof runNativeAgentTurn>>;
    try {
      native = await runNativeAgentTurn({
        profile: cloudClaudeRoleProfile({
          role: "orchestrator",
          threadId: input.threadId,
          conversationId: input.conversationId,
        }),
        prompt: input.prompt,
        systemPrompt: buildClaudeCodeNativeToolRuntimePrompt(spec.systemPrompt),
        execution,
        gatewayOrigin: modelGateway.origin,
        capability: modelGateway.capability,
        threadId: input.threadId,
        turnId: input.turnId,
        authoritativeHistoryCursor: nativeHistoryCursorFromRows(
          input.history ?? [],
        ),
        stateIntegrityKey: input.nativeStateIntegrityKey,
        ...(input.rebuildNativeSession === true
          ? { recoveryHistory: input.history ?? [] }
          : {}),
        claudeMcpServerConfig: mcpHost.mcpServerConfig,
        cancellation: turnCancellation,
        onStreamEvent: (event) => {
          correlator.observeStreamEvent(event);
          if (event.type === "assistant") {
            correlator.observeAssistantMessage(event);
            const content = asRecord(event.message)?.content;
            for (const raw of Array.isArray(content) ? content : []) {
              const block = asRecord(raw);
              if (
                block?.type === "tool_use" &&
                typeof block.id === "string" &&
                typeof block.name === "string"
              ) {
                correlator.observe({
                  toolCallId: block.id,
                  toolName: block.name,
                  toolArgs: asRecord(block.input) ?? {},
                });
              }
            }
          }
          assembler.observe(event);
        },
      });
    } catch (runError) {
      // Nothing durable was sealed: keep the prior native state, so the next
      // turn resumes from the last good checkpoint.
      assembler.close();
      await lane.flush();
      return failed(asError(runError).message);
    }
    if (!native.error) {
      // The CLI must have listed the DO's catalog, or its tools were absent.
      try {
        await mcpHost.waitForClientReady(undefined, 1_000);
      } catch (readyError) {
        error = asError(readyError).message;
      }
    }
    finalText = native.finalText.trim();
    error = native.error ?? error;
    // A killed CLI never writes its `result` totals; keep the per-message sum.
    assembler.close();
    usage =
      native.usage.inputTokens + native.usage.outputTokens > 0
        ? native.usage
        : assembler.usage;
    nativeCheckpoint = native.nativeStateCheckpoint;
    historyCursor = nativeHistoryCursorFromMessages(
      input.turnId,
      native.messages,
    );
    transcriptRows = native.messages.map((message, ordinal) => ({
      ordinal,
      role: (message as { role: string }).role,
      payloadJson: JSON.stringify(message),
    }));
  } finally {
    // No tool call may start once the native state is being archived.
    await mcpHost.close().catch((closeError) => {
      console.error(
        `orchestrator MCP close failed: ${asError(closeError).message}`,
      );
    });
  }

  // The last batch lands before the result: the DO sees every message and
  // the final usage before the BuildSession's terminal frame.
  assembler.close();
  lane.emit({ type: "usage", ...usage });
  await lane.flush();
  if (lane.failure && !error) error = lane.failure.message;

  let checkpointMs = 0;
  const started = performance.now();
  try {
    const receipt = await commitTurnStateBeforeTranscript({
      historyCursor,
      ...(nativeCheckpoint ? { nativeCheckpoint } : {}),
      broker,
      appendTranscript: async () => {
        const body = {
          conversationId: input.threadId,
          turnId: input.turnId,
          messages: transcriptRows,
        };
        let response = await broker.postJson("/api/cloud/messages", body);
        if (!response.ok) {
          response = await broker.postJson("/api/cloud/messages", body);
        }
        if (!response.ok) {
          throw new Error(
            `Thread transcript persist failed (${response.status}).`,
          );
        }
      },
    });
    checkpointMs = Math.round(performance.now() - started);
    return {
      ok: !error,
      finalText,
      ...(error ? { error } : {}),
      usage,
      checkpointMs,
      turnStateCheckpoint: receipt,
    };
  } catch (checkpointError) {
    console.error(
      `orchestrator checkpoint failed: ${asError(checkpointError).message}`,
    );
    // Builder quiesces the process tree and resumes the idempotent journal
    // from this exact transcript, as for an agent turn.
    return createBuilderFallbackAgentTurnResult({
      finalText,
      ...(error ? { error } : {}),
      usage,
      historyCursor,
      messages: transcriptRows,
      ...(nativeCheckpoint ? { nativeCheckpoint } : {}),
    });
  }
};
