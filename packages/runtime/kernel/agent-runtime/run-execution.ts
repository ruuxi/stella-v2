import type { AgentEvent, AgentMessage } from "../agent-core/types.js";
import { Buffer } from "node:buffer";
import { Deferred, Effect, Layer, ManagedRuntime, Scope } from "effect";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "@stella/contracts/protocol";
import {
  subscribeRuntimeAgentEvents,
  type RuntimeRunEventRecorder,
} from "./run-events.js";
import {
  createRuntimePromptAgentMessage,
  prepareRuntimeAttachments,
} from "./run-preparation.js";
import {
  enrichImageContentForTextOnlyModel,
  IMAGE_DESCRIPTION_CUSTOM_TYPE,
  type ImageDescriptionService,
} from "./image-description.js";
import { getAgentCompletion, now } from "./shared.js";
import type { RuntimeRunCallbacks } from "./types.js";
import {
  persistThreadCustomMessage,
  persistThreadPayloadMessage,
} from "./thread-memory.js";
import { THREAD_PERSISTENCE_ERROR_CODE } from "./agent-run-retry.js";
import { ORCHESTRATOR_ROSTER_CUSTOM_TYPE } from "../storage/shared.js";

type RuntimeExecutableAgent = {
  state: {
    messages: AgentMessage[];
    model?: {
      provider?: string;
      api?: string;
      id?: string;
      input?: ("text" | "image")[];
    };
  };
  subscribe: (listener: (event: AgentEvent) => void) => () => void;
  prompt: (message: AgentMessage | AgentMessage[]) => Promise<void>;
  followUp: (message: AgentMessage) => void;
  continue: () => Promise<void>;
  abort: () => void;
};

const DEFAULT_AGENT_STARTUP_IDLE_TIMEOUT_MS = 15 * 1000;
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Ceiling while tool calls are in flight. Deliberately above the agent-core
// per-tool inactivity bound (10 min) so the tool-level cancellation — which
// fails only the tool and lets the agent continue — always wins when tool
// tracking is intact. This run-killing backstop fires only when tracking
// leaked (e.g. a lost tool_execution_end).
const DEFAULT_AGENT_TOOL_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const AGENT_ABORT_SETTLE_GRACE_MS = 100;

const configuredTimeoutMs = (envName: string, fallbackMs: number): number => {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
};

/**
 * Requirements-free runtime + scope for the per-prompt watchdog fibers
 * (house convention: one module-level ManagedRuntime; context rides in
 * closures). Every forked fiber is interrupted in the prompt's finally
 * block, so nothing outlives its run.
 */
const executionRuntime = ManagedRuntime.make(Layer.empty);
const executionScope = Scope.makeUnsafe();

const waitForAgentAbortSettlement = (work: Promise<void>): Promise<void> =>
  // Bounded settle race; the losing sleep arm is fiber-interrupted (the
  // Effect replacement for the old `clearTimeout` + unref'd timer).
  executionRuntime.runPromise(
    Effect.raceFirst(
      Effect.promise(() =>
        work.then(
          () => undefined,
          () => undefined,
        ),
      ),
      Effect.sleep(AGENT_ABORT_SETTLE_GRACE_MS),
    ),
  );

const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;

const attachmentMimeType = (attachment: RuntimeAttachmentRef): string =>
  attachment.mimeType?.trim().toLowerCase() ?? "";

const isRemoteImageAttachment = (attachment: RuntimeAttachmentRef): boolean =>
  /^https?:\/\//i.test(attachment.url) &&
  (attachmentMimeType(attachment).startsWith("image/") ||
    attachment.kind?.toLowerCase() === "image");

const materializeRemoteImageAttachment = async (
  attachment: RuntimeAttachmentRef,
  signal?: AbortSignal,
): Promise<RuntimeAttachmentRef> => {
  if (!isRemoteImageAttachment(attachment)) return attachment;
  try {
    const response = await fetch(attachment.url, { signal });
    if (!response.ok) return attachment;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_IMAGE_BYTES) return attachment;
    const mimeType =
      attachmentMimeType(attachment) ||
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() ||
      "";
    if (!mimeType.startsWith("image/")) return attachment;
    return {
      ...attachment,
      mimeType,
      url: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  } catch {
    return attachment;
  }
};

const materializePromptAttachments = async (
  attachments?: RuntimeAttachmentRef[],
  target?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
  signal?: AbortSignal,
): Promise<RuntimeAttachmentRef[] | undefined> => {
  if (!attachments?.length) return attachments;
  const materialized = await Promise.all(
    attachments.map((attachment) =>
      materializeRemoteImageAttachment(attachment, signal),
    ),
  );
  return await prepareRuntimeAttachments(materialized, target);
};

export const isDurablyPersistedRuntimePromptInput = (
  input: RuntimePromptMessage,
): boolean =>
  input.messageType === "message" &&
  Boolean(input.customType?.trim()) &&
  input.customType !== "runtime.queued_message_reply";

const shouldPersistRuntimePromptInput = (
  input: RuntimePromptMessage,
): boolean => isDurablyPersistedRuntimePromptInput(input);

const canonicalizeRuntimePromptContent = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeRuntimePromptContent);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [
          key,
          canonicalizeRuntimePromptContent(nested),
        ]),
    );
  }
  return value;
};

const sameRuntimePromptContent = (left: unknown, right: unknown): boolean => {
  try {
    return (
      JSON.stringify(canonicalizeRuntimePromptContent(left)) ===
      JSON.stringify(canonicalizeRuntimePromptContent(right))
    );
  } catch {
    return left === right;
  }
};

const reusePrePersistedRuntimePromptMessages = (
  agent: RuntimeExecutableAgent,
  promptMessages: Array<{
    message: AgentMessage;
    input: RuntimePromptMessage & { attachments?: RuntimeAttachmentRef[] };
  }>,
): Set<AgentMessage> => {
  const retained = agent.state.messages.slice();
  const reused = new Set<AgentMessage>();
  let changed = false;
  for (const promptMessage of promptMessages) {
    if (
      promptMessage.input.customType !== "runtime.task_lifecycle" ||
      promptMessage.message.role !== "runtimeInternal"
    ) {
      continue;
    }
    let existingIndex = -1;
    for (let index = retained.length - 1; index >= 0; index -= 1) {
      const message = retained[index];
      if (
        message.role === "runtimeInternal" &&
        message.customType === promptMessage.message.customType &&
        message.eventId === promptMessage.message.eventId &&
        message.timestamp === promptMessage.message.timestamp &&
        message.display === promptMessage.message.display &&
        sameRuntimePromptContent(message.content, promptMessage.message.content)
      ) {
        existingIndex = index;
        break;
      }
    }
    if (existingIndex < 0) continue;
    // The crash-safe lifecycle row was loaded into the Agent's history before
    // this run. Move that exact object into the prompt rather than showing it
    // to the provider once from history and once again as the new prompt.
    promptMessage.message = retained[existingIndex];
    reused.add(promptMessage.message);
    retained.splice(existingIndex, 1);
    changed = true;
  }
  if (changed) agent.state.messages = retained;
  return reused;
};

export const executeRuntimeAgentPrompt = async (args: {
  agent: RuntimeExecutableAgent;
  promptText?: string;
  attachments?: RuntimeAttachmentRef[];
  promptMessages?: Array<
    RuntimePromptMessage & {
      attachments?: RuntimeAttachmentRef[];
    }
  >;
  runId: string;
  agentType: string;
  userMessageId: string;
  recorder: RuntimeRunEventRecorder;
  abortSignal?: AbortSignal;
  callbacks?: Partial<RuntimeRunCallbacks>;
  onProgress?: (chunk: string) => void;
  displayEventHandler?: (event: AgentEvent) => boolean;
  hookEmitter?: HookEmitter;
  threadStore?: import("../storage/runtime-store.js").RuntimeStore;
  threadKey?: string;
  conversationId?: string;
  stellaDataDir?: string;
  uiVisibility?: "visible" | "hidden";
  attemptGeneration?: number;
  /** Lazily describes newly-arriving images when the selected model is text-only. */
  describeImages?: ImageDescriptionService;
  /**
   * Resume the agent loop from its existing in-memory context instead of
   * appending a new prompt. Used by the safety model-swap retry: the failed
   * attempt's prompt is already in context (and persisted), so re-prompting
   * would duplicate it. Requires the context's last message to not be an
   * assistant message (callers pop the errored assistant before resuming).
   */
  resume?: boolean;
  onAfterPrompt?: () => Promise<void> | void;
  onCleanup?: () => Promise<void> | void;
  onThreadPersistenceError?: (error: unknown) => void;
  onThreadPersistenceRecovered?: () => void;
}): Promise<{ finalText: string; errorMessage?: string }> => {
  const throwIfPromptAborted = () => {
    const signal = args.abortSignal;
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error(
      typeof signal.reason === "string" && signal.reason.trim()
        ? signal.reason
        : "Request was aborted",
    );
    error.name = "AbortError";
    throw error;
  };
  throwIfPromptAborted();
  const abortHandler = () => args.agent.abort();
  args.abortSignal?.addEventListener("abort", abortHandler);

  const startupIdleTimeoutMs = configuredTimeoutMs(
    "STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS",
    DEFAULT_AGENT_STARTUP_IDLE_TIMEOUT_MS,
  );
  const idleTimeoutMs = configuredTimeoutMs(
    "STELLA_AGENT_IDLE_TIMEOUT_MS",
    DEFAULT_AGENT_IDLE_TIMEOUT_MS,
  );
  const toolIdleTimeoutMs = configuredTimeoutMs(
    "STELLA_AGENT_TOOL_IDLE_TIMEOUT_MS",
    DEFAULT_AGENT_TOOL_IDLE_TIMEOUT_MS,
  );
  let idleSettled = false;
  let hasAgentActivity = false;
  const activeToolCallIds = new Set<string>();
  let lastActivityAt = Date.now();
  let activityLatch = Deferred.makeUnsafe<void>();
  let rejectIdle: (error: Error) => void = () => {};
  const idleFailure = new Promise<never>((_, reject) => {
    rejectIdle = reject;
  });
  // A tool owns its own completion/cancellation semantics. Long-running
  // commands can legitimately be silent for more than the agent stream's
  // idle window, so while tool calls are in flight the watchdog runs with
  // the much longer tool ceiling instead of the stream idle window. The
  // agent-core per-tool inactivity bound cancels a silent tool (with an
  // error result the agent survives) well before this fires; reaching this
  // timeout means tool tracking leaked and the run really is dead.
  const currentIdleBoundMs = () =>
    activeToolCallIds.size > 0
      ? toolIdleTimeoutMs
      : hasAgentActivity
        ? idleTimeoutMs
        : startupIdleTimeoutMs;
  // The three-level idle watchdog as one deadline-looped fiber (the Effect
  // replacement for the re-armed setTimeout): every agent event pushes
  // `lastActivityAt` and completes the activity latch, so the loop
  // re-sleeps toward the fresh deadline under whichever bound currently
  // applies (startup / stream-idle / tool ceiling). Interrupting the fiber
  // in the finally block below is the old `clearTimeout`.
  const watchdogFiber = executionRuntime.runSync(
    Effect.forkIn(
      Effect.gen(function* () {
        for (;;) {
          const timeoutMs = currentIdleBoundMs();
          const remainingMs = timeoutMs - (Date.now() - lastActivityAt);
          if (remainingMs <= 0) break;
          const latch = Deferred.makeUnsafe<void>();
          activityLatch = latch;
          yield* Effect.raceFirst(
            Effect.sleep(remainingMs),
            Deferred.await(latch),
          );
        }
        idleSettled = true;
        const toolsInFlight = activeToolCallIds.size > 0;
        const timeoutMs = currentIdleBoundMs();
        try {
          args.agent.abort();
        } catch {
          // Best effort; the prompt race below owns surfacing the timeout.
        }
        rejectIdle(
          new Error(
            toolsInFlight
              ? `Agent produced no activity for ${Math.round(timeoutMs / 1000)}s while ${activeToolCallIds.size} tool call(s) were still marked in flight.`
              : `Agent did not produce activity for ${Math.round(timeoutMs / 1000)}s.`,
          ),
        );
      }),
      executionScope,
      { startImmediately: true },
    ),
  );
  const markAgentActivity = (event?: AgentEvent) => {
    hasAgentActivity = true;
    if (event?.type === "tool_execution_start") {
      activeToolCallIds.add(event.toolCallId);
    } else if (event?.type === "tool_execution_end") {
      activeToolCallIds.delete(event.toolCallId);
    }
    if (idleSettled) return;
    lastActivityAt = Date.now();
    Deferred.doneUnsafe(activityLatch, Effect.void);
  };
  const unsubscribeIdle = args.agent.subscribe(markAgentActivity);

  let threadPersistenceError: unknown;
  const unsubscribe = subscribeRuntimeAgentEvents({
    agent: args.agent,
    runId: args.runId,
    agentType: args.agentType,
    recorder: args.recorder,
    callbacks: args.callbacks,
    onProgress: args.onProgress,
    displayEventHandler: args.displayEventHandler,
    hookEmitter: args.hookEmitter,
    threadStore: args.threadStore,
    threadKey: args.threadKey,
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    ...(args.stellaDataDir ? { stellaDataDir: args.stellaDataDir } : {}),
    ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
    ...(typeof args.attemptGeneration === "number"
      ? { attemptGeneration: args.attemptGeneration }
      : {}),
    onThreadPersistenceError: (error, retry) => {
      threadPersistenceError = error;
      args.onThreadPersistenceError?.(error);
      try {
        retry();
        threadPersistenceError = undefined;
        args.onThreadPersistenceRecovered?.();
        return;
      } catch (retryError) {
        threadPersistenceError = retryError;
      }
      // Do not let a continuously steered/follow-up prompt begin another
      // provider turn after its completed group failed to become durable.
      args.agent.abort();
    },
  });

  const assertThreadPersistence = () => {
    if (!threadPersistenceError) return;
    const message =
      threadPersistenceError instanceof Error
        ? threadPersistenceError.message
        : String(threadPersistenceError);
    const persistenceError = new Error(
      `Failed to persist complete assistant/tool group: ${message}`,
    ) as Error & { code?: string };
    persistenceError.code = THREAD_PERSISTENCE_ERROR_CODE;
    throw persistenceError;
  };

  try {
    if (args.resume) {
      throwIfPromptAborted();
      const continuePromise = args.agent.continue();
      continuePromise.catch(() => undefined);
      try {
        await Promise.race([continuePromise, idleFailure]);
      } catch (error) {
        // When the watchdog aborts the Agent, wait for its loop to append the
        // terminal errored assistant before returning control to run-level
        // retry preparation. Otherwise a retry can race the still-settling
        // attempt and resume on an assistant tail.
        await waitForAgentAbortSettlement(continuePromise);
        throw error;
      }
      assertThreadPersistence();
      await args.onAfterPrompt?.();
      const completion = getAgentCompletion(args.agent);
      return {
        ...completion,
        finalText: completion.finalText.trim(),
      };
    }
    const imageTarget = args.agent.state.model
      ? {
          provider: args.agent.state.model.provider,
          api: args.agent.state.model.api,
          modelId: args.agent.state.model.id,
        }
      : undefined;
    const promptInputs =
      args.promptMessages && args.promptMessages.length > 0
        ? await Promise.all(
            args.promptMessages.map(async (message) => ({
              ...message,
              attachments: await materializePromptAttachments(
                message.attachments,
                imageTarget,
                args.abortSignal,
              ),
            })),
          )
        : [
            {
              text: args.promptText ?? "",
              attachments: await materializePromptAttachments(
                args.attachments,
                imageTarget,
                args.abortSignal,
              ),
            },
          ];
    const promptTimestamp = now();
    const promptMessages = (
      await Promise.all(
        promptInputs.map(async (input, index) => {
          const inputTimestamp =
            typeof input.timestamp === "number" &&
            Number.isFinite(input.timestamp)
              ? input.timestamp
              : promptTimestamp + index * 2;
          const message = createRuntimePromptAgentMessage(
            input,
            inputTimestamp,
          );
          if (
            (message.role !== "user" && message.role !== "runtimeInternal") ||
            typeof message.content === "string"
          ) {
            return [{ message, input }];
          }
          const enrichedContent = await enrichImageContentForTextOnlyModel({
            content: message.content,
            model: args.agent.state.model,
            describeImages: args.describeImages,
            signal: args.abortSignal,
          });
          if (enrichedContent === message.content) {
            return [{ message, input }];
          }
          const description = enrichedContent.at(-1);
          if (description?.type !== "text") {
            return [{ message, input }];
          }
          const descriptionInput = {
            text: description.text,
            messageType: "message" as const,
            customType: IMAGE_DESCRIPTION_CUSTOM_TYPE,
            display: false,
            uiVisibility: "hidden" as const,
          };
          return [
            { message, input },
            {
              message: createRuntimePromptAgentMessage(
                descriptionInput,
                promptTimestamp + index * 2 + 1,
              ),
              input: descriptionInput,
            },
          ];
        }),
      )
    ).flat();
    const prePersistedRuntimePromptMessages =
      reusePrePersistedRuntimePromptMessages(args.agent, promptMessages);
    for (const [index, promptMessage] of promptMessages.entries()) {
      const promptInput = promptMessage.input ?? promptInputs[index];
      const messageType = promptInput?.messageType ?? "user";
      if (
        messageType === "user" &&
        promptMessage.message.role === "user" &&
        args.threadStore &&
        args.threadKey
      ) {
        persistThreadPayloadMessage(args.threadStore, {
          threadKey: args.threadKey,
          payload: promptMessage.message,
          ...(args.agentType === "orchestrator"
            ? { preservePayloadExactly: true }
            : {}),
        });
      }
      if (
        messageType === "message" &&
        promptMessage.message.role === "runtimeInternal" &&
        shouldPersistRuntimePromptInput(promptInput) &&
        args.threadStore &&
        args.threadKey
      ) {
        if (!prePersistedRuntimePromptMessages.has(promptMessage.message)) {
          persistThreadCustomMessage(args.threadStore, {
            threadKey: args.threadKey,
            customType: promptInput.customType,
            content: promptMessage.message.content,
            display: promptMessage.message.display === true,
            timestamp: promptMessage.message.timestamp,
            ...(promptMessage.message.eventId
              ? { eventId: promptMessage.message.eventId }
              : {}),
            ...(args.agentType === "orchestrator"
              ? { preservePayloadExactly: true }
              : {}),
          });
        }
        if (
          promptInput.customType === ORCHESTRATOR_ROSTER_CUSTOM_TYPE &&
          args.conversationId
        ) {
          args.threadStore.consumeOrchestratorReminder?.(args.conversationId);
        }
      }
      const uiVisibility = promptInput?.uiVisibility;
      if (messageType === "user" && uiVisibility) {
        args.callbacks?.onUserMessage?.({
          userMessageId: args.userMessageId,
          text: promptInput.text,
          timestamp: promptMessage.message.timestamp,
          uiVisibility,
        });
      }
    }
    // The signal may have fired while attachments or image descriptions
    // were awaited. Agent.abort() is a no-op before Agent.prompt() creates
    // its controller, so recheck before provider dispatch.
    throwIfPromptAborted();
    const promptPromise = args.agent.prompt(
      promptMessages.map((message) => message.message),
    );
    promptPromise.catch(() => undefined);
    try {
      await Promise.race([promptPromise, idleFailure]);
    } catch (error) {
      // See the resume branch above: retry fencing needs the aborted Agent
      // loop fully settled before inspecting and removing its error tail.
      await waitForAgentAbortSettlement(promptPromise);
      throw error;
    }
    assertThreadPersistence();
    await args.onAfterPrompt?.();
    const completion = getAgentCompletion(args.agent);

    return {
      ...completion,
      finalText: completion.finalText.trim(),
    };
  } finally {
    idleSettled = true;
    watchdogFiber.interruptUnsafe();
    try {
      await args.onCleanup?.();
    } finally {
      unsubscribeIdle();
      unsubscribe();
      args.abortSignal?.removeEventListener("abort", abortHandler);
    }
  }
};
