import { Buffer } from "node:buffer";
import { subscribeRuntimeAgentEvents } from "./run-events.js";
import {
  createRuntimePromptAgentMessage,
  prepareRuntimeAttachments,
} from "./run-preparation.js";
import {
  enrichImageContentForTextOnlyModel,
  IMAGE_DESCRIPTION_CUSTOM_TYPE,
} from "./image-description.js";
import { getAgentCompletion, now } from "./shared.js";
import {
  persistThreadCustomMessage,
  persistThreadPayloadMessage,
} from "./thread-memory.js";
import { THREAD_PERSISTENCE_ERROR_CODE } from "./agent-run-retry.js";
import { ORCHESTRATOR_ROSTER_CUSTOM_TYPE } from "../storage/shared.js";
const DEFAULT_AGENT_STARTUP_IDLE_TIMEOUT_MS = 15 * 1000;
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Ceiling while tool calls are in flight. Deliberately above the agent-core
// per-tool inactivity bound (10 min) so the tool-level cancellation — which
// fails only the tool and lets the agent continue — always wins when tool
// tracking is intact. This run-killing backstop fires only when tracking
// leaked (e.g. a lost tool_execution_end).
const DEFAULT_AGENT_TOOL_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const configuredTimeoutMs = (envName, fallbackMs) => {
    const raw = process.env[envName]?.trim();
  if (!raw) return fallbackMs;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
};
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const attachmentMimeType = (attachment) =>
  attachment.mimeType?.trim().toLowerCase() ?? "";
const isRemoteImageAttachment = (attachment) =>
  /^https?:\/\//i.test(attachment.url) &&
    (attachmentMimeType(attachment).startsWith("image/") ||
        attachment.kind?.toLowerCase() === "image");
const materializeRemoteImageAttachment = async (attachment, signal) => {
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
const materializePromptAttachments = async (attachments, target, signal) => {
  if (!attachments?.length) return attachments;
  const materialized = await Promise.all(
    attachments.map((attachment) =>
      materializeRemoteImageAttachment(attachment, signal),
    ),
  );
    return await prepareRuntimeAttachments(materialized, target);
};
export const isDurablyPersistedRuntimePromptInput = (input) =>
  input.messageType === "message" &&
    Boolean(input.customType?.trim()) &&
    input.customType !== "runtime.queued_message_reply";
const shouldPersistRuntimePromptInput = (input) =>
  isDurablyPersistedRuntimePromptInput(input);
export const executeRuntimeAgentPrompt = async (args) => {
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
    let idleTimer;
    let idleSettled = false;
    let hasAgentActivity = false;
    const activeToolCallIds = new Set();
    let rejectIdle = () => { };
    const idleFailure = new Promise((_, reject) => {
        rejectIdle = reject;
    });
    const refreshIdleTimer = () => {
    if (idleSettled) return;
    if (idleTimer) clearTimeout(idleTimer);
        idleTimer = undefined;
        // A tool owns its own completion/cancellation semantics. Long-running
        // commands can legitimately be silent for more than the agent stream's
        // idle window, so while tool calls are in flight the watchdog is armed
        // with the much longer tool ceiling instead of the stream idle window.
        // The agent-core per-tool inactivity bound cancels a silent tool (with
        // an error result the agent survives) well before this fires; reaching
        // this timeout means tool tracking leaked and the run really is dead.
        const toolsInFlight = activeToolCallIds.size > 0;
        const timeoutMs = toolsInFlight
            ? toolIdleTimeoutMs
            : hasAgentActivity
                ? idleTimeoutMs
                : startupIdleTimeoutMs;
        idleTimer = setTimeout(() => {
            idleSettled = true;
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
        }, timeoutMs);
        idleTimer.unref?.();
    };
    const markAgentActivity = (event) => {
        hasAgentActivity = true;
        if (event?.type === "tool_execution_start") {
            activeToolCallIds.add(event.toolCallId);
    } else if (event?.type === "tool_execution_end") {
            activeToolCallIds.delete(event.toolCallId);
        }
        refreshIdleTimer();
    };
    refreshIdleTimer();
    const unsubscribeIdle = args.agent.subscribe(markAgentActivity);
    let threadPersistenceError;
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
    );
        persistenceError.code = THREAD_PERSISTENCE_ERROR_CODE;
        throw persistenceError;
    };
    try {
        if (args.resume) {
            throwIfPromptAborted();
            const continuePromise = args.agent.continue();
            continuePromise.catch(() => undefined);
            await Promise.race([continuePromise, idleFailure]);
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
                messageType: "message",
                customType: IMAGE_DESCRIPTION_CUSTOM_TYPE,
                display: false,
                uiVisibility: "hidden",
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
        if (promptInput.customType === ORCHESTRATOR_ROSTER_CUSTOM_TYPE) {
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
        await Promise.race([promptPromise, idleFailure]);
        assertThreadPersistence();
        await args.onAfterPrompt?.();
        const completion = getAgentCompletion(args.agent);
        return {
            ...completion,
            finalText: completion.finalText.trim(),
        };
  } finally {
        idleSettled = true;
    if (idleTimer) clearTimeout(idleTimer);
        try {
            await args.onCleanup?.();
    } finally {
            unsubscribeIdle();
            unsubscribe();
            args.abortSignal?.removeEventListener("abort", abortHandler);
        }
    }
};
