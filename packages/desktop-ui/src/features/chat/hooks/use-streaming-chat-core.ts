import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { getPlatform } from "@/platform/electron/platform";
import { useChatStore } from "@/context/chat-store-context";
import { getOrCreateDeviceId } from "@/platform/electron/device-id";
import type { SendMessageArgs } from "../streaming/chat-types";
import type { MessageMetadata } from "@/features/chat/lib/event-transforms";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import type { MessageRecord } from "@stella/contracts/local-chat";
import { resolveComposerContextState } from "../composer-context";
import {
  buildAllLocalAttachments,
  toDisplayAttachments,
} from "../streaming/message-context";
import { toPastedTextDescriptor } from "../lib/paste-context";
import { getComposerAppSelections } from "../composer-context";
import { useLocalAgentStream } from "../streaming/use-local-agent-stream";
import {
  combineQueuedSendPayloads,
  orderQueuedMessages,
  removeQueuedUserMessageById,
  restoreQueuedMessagesAfterFailedDrain,
  timestampQueuedOptimisticEventForDrain,
  type QueuedUserMessage,
} from "./queued-user-messages";
import { useQueuedDequeueClock } from "./use-queued-dequeue-clock";

export type { QueuedUserMessage } from "./queued-user-messages";

type UseStreamingChatOptions = {
  conversationId: string | null;
  locale: string;
  notifyTierRestrictedModel?: () => void | Promise<void>;
  /**
   * SQLite-persisted message stream (no optimistic / scheduled overlay).
   * Used to detect (a) an assistant reply for the pending user message,
   * (b) optimistic events that have been persisted (can be dropped),
   * (c) queued user messages that have been persisted.
   *
   * Must be the un-overlaid source — passing in the merged display
   * stream would loop optimistic events through this hook into
   * displayMessages.
   */
  persistedMessages: MessageRecord[];
};

const createLocalMessageId = () => `local-${crypto.randomUUID()}`;

/**
 * Bounded preview of quoted / "Ask Stella" context stored on the sent message.
 * Mirrors the runtime's `QUOTED_TEXT_PREVIEW_MAX_CHARS` so the optimistic value
 * matches what persistence recomputes, keeping the chip stable across the
 * optimistic → persisted swap. See `runtime/kernel/chat-prompt-context.ts`.
 */
const QUOTED_TEXT_PREVIEW_MAX_CHARS = 4_000;

export const buildContextMessageMetadata = (
  chatContext: SendMessageArgs["chatContext"],
  selectedText: SendMessageArgs["selectedText"],
  base?: MessageMetadata,
): MessageMetadata | undefined => {
  const appSelectionLabels = getComposerAppSelections(chatContext)
    .map((selection) => selection.label?.trim() ?? "")
    .filter((label) => label.length > 0);
  // Joined singular kept for legacy single-slot consumers.
  const appSelectionLabel =
    appSelectionLabels.length > 0 ? appSelectionLabels.join(", ") : undefined;
  const activityLabel = chatContext?.activity?.label?.trim();
  const pastedTexts = (chatContext?.pastedTexts ?? [])
    .map((text) => text?.trim() ?? "")
    .filter((text) => text.length > 0)
    .map(toPastedTextDescriptor);
  // Quoted / "Ask Stella" selection. The runtime persists this same bounded
  // preview onto the user message once it lands, but the optimistic row is
  // rendered before then — without carrying it here the just-sent message drops
  // its quoted-text chip until persistence catches up. Reads the composer's
  // `selectedText` and falls back to `chatContext.selectedText`, matching the
  // runtime's own resolution order.
  const quotedSource =
    selectedText?.trim() || chatContext?.selectedText?.trim() || "";
  const quotedText = quotedSource
    ? quotedSource.slice(0, QUOTED_TEXT_PREVIEW_MAX_CHARS)
    : undefined;
  if (
    !appSelectionLabel &&
    !activityLabel &&
    pastedTexts.length === 0 &&
    !quotedText
  ) {
    return base;
  }

  return {
    ...(base ?? {}),
    context: {
      ...(base?.context ?? {}),
      ...(appSelectionLabel ? { appSelectionLabel } : {}),
      ...(appSelectionLabels.length > 0 ? { appSelectionLabels } : {}),
      ...(activityLabel ? { activityLabel } : {}),
      ...(pastedTexts.length > 0 ? { pastedTexts } : {}),
      ...(quotedText ? { quotedText } : {}),
    },
  };
};

const buildOptimisticUserEvent = (args: {
  id: string;
  text: string;
  timestamp: number;
  platform?: string;
  timezone?: string;
  locale?: string;
  metadata?: SendMessageArgs["metadata"];
  attachments: ReturnType<typeof buildAllLocalAttachments>;
  mode?: string;
}): EventRecord => ({
  _id: args.id,
  type: "user_message",
  timestamp: args.timestamp,
  payload: {
    text: args.text,
    ...(args.attachments.length ? { attachments: args.attachments } : {}),
    ...(args.platform ? { platform: args.platform } : {}),
    ...(args.timezone ? { timezone: args.timezone } : {}),
    ...(args.locale ? { locale: args.locale } : {}),
    ...(args.metadata ? { metadata: args.metadata } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
  },
});

type QueuedStreamPayload = {
  id: string;
  queueOrder: number;
  conversationId: string;
  userPrompt: string;
  selectedText: SendMessageArgs["selectedText"];
  chatContext: SendMessageArgs["chatContext"];
  deviceId: string;
  platform?: string;
  timezone?: string;
  locale?: string;
  messageMetadata?: SendMessageArgs["metadata"];
  attachments: ReturnType<typeof buildAllLocalAttachments>;
  optimisticEvent: EventRecord;
};

export function useStreamingChatCore({
  conversationId,
  locale,
  notifyTierRestrictedModel,
  persistedMessages,
}: UseStreamingChatOptions) {
  const activeConversationId = conversationId;
  const [optimisticEvents, setOptimisticEvents] = useState<EventRecord[]>([]);
  const [queuedUserMessages, setQueuedUserMessages] = useState<
    QueuedUserMessage[]
  >([]);
  const queuedStreamPayloadsRef = useRef<QueuedStreamPayload[]>([]);
  const drainingQueuedPayloadsRef = useRef<QueuedStreamPayload[]>([]);
  const drainingQueuedMessageIdRef = useRef<string | null>(null);
  const queuedMessageOrderRef = useRef(0);
  const queueDrainPausedRef = useRef(false);
  const pendingSendRef = useRef<symbol | null>(null);
  const [isSending, setIsSending] = useState(false);
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const { isLocalStorage, storageMode } = useChatStore();
  const issueDequeueTimestamp = useQueuedDequeueClock({
    conversationId: activeConversationId,
    persistedMessages,
    optimisticEvents,
  });

  const reconcileAcceptedUserMessage = useCallback(
    (optimisticId: string, acceptedId: string) => {
      if (optimisticId === acceptedId) return;
      setOptimisticEvents((current) =>
        current.map((event) =>
          event._id === optimisticId ? { ...event, _id: acceptedId } : event,
        ),
      );
    },
    [],
  );

  const removeQueuedUserMessage = useCallback((messageId: string) => {
    queuedStreamPayloadsRef.current = queuedStreamPayloadsRef.current.filter(
      (message) => message.id !== messageId,
    );
    if (drainingQueuedMessageIdRef.current === messageId) {
      drainingQueuedMessageIdRef.current = null;
      drainingQueuedPayloadsRef.current = [];
    }
    queueDrainPausedRef.current = false;
    setQueuedUserMessages((current) =>
      removeQueuedUserMessageById(current, messageId),
    );
  }, []);

  const handleRunStarted = useCallback((event: { userMessageId?: string }) => {
    const userMessageId = event.userMessageId;
    if (!userMessageId) return;
    queuedStreamPayloadsRef.current = queuedStreamPayloadsRef.current.filter(
      (message) => message.id !== userMessageId,
    );
    if (drainingQueuedMessageIdRef.current === userMessageId) {
      drainingQueuedMessageIdRef.current = null;
      drainingQueuedPayloadsRef.current = [];
    }
    setQueuedUserMessages((current) =>
      removeQueuedUserMessageById(current, userMessageId),
    );
  }, []);

  const handleRunFinished = useCallback(
    (event: {
      userMessageId?: string;
      outcome: "completed" | "error" | "canceled";
    }) => {
      if (event.userMessageId && event.outcome !== "completed") {
        setOptimisticEvents((current) =>
          current.filter((message) => message._id !== event.userMessageId),
        );
      }
      if (
        event.userMessageId &&
        drainingQueuedMessageIdRef.current === event.userMessageId
      ) {
        drainingQueuedMessageIdRef.current = null;
        drainingQueuedPayloadsRef.current = [];
      }
      // A terminal outcome for the active run must not discard renderer-owned
      // follow-ups. If they have not been accepted yet, the idle-drain effect
      // will send them as the next turn. A drain that did start is removed by
      // `handleRunStarted`, so a later run error/cancel cannot replay it.
    },
    [],
  );

  const {
    taskDecorations,
    runtimeStatusText,
    activeToolCallId,
    activeToolName,
    latestCompletedTool,
    hasToolActivity,
    isToolActive,
    answerLanded,
    reasoningText,
    streamingAssistants,
    isStreaming,
    pendingUserMessageId,
    setPendingUserMessageId,
    startStream,
    cancelCurrentStream,
  } = useLocalAgentStream({
    activeConversationId,
    storageMode,
    onRunStarted: handleRunStarted,
    onRunFinished: handleRunFinished,
  }) as Omit<
    ReturnType<typeof useLocalAgentStream>,
    "setPendingUserMessageId"
  > & {
    setPendingUserMessageId: Dispatch<SetStateAction<string | null>>;
  };

  useEffect(() => {
    queuedStreamPayloadsRef.current = [];
    drainingQueuedPayloadsRef.current = [];
    drainingQueuedMessageIdRef.current = null;
    queuedMessageOrderRef.current = 0;
    queueDrainPausedRef.current = false;
    pendingSendRef.current = null;
    setIsSending(false);
    setOptimisticEvents([]);
    setQueuedUserMessages([]);
    setPendingUserMessageId(null);
  }, [activeConversationId, setPendingUserMessageId]);

  const clearOptimisticMessage = useCallback(
    (messageId: string) => {
      setOptimisticEvents((current) =>
        current.filter((event) => event._id !== messageId),
      );
      setPendingUserMessageId((current) =>
        current === messageId ? null : current,
      );
    },
    [setPendingUserMessageId],
  );

  const drainQueuedMessagesIfIdle = useCallback(() => {
    if (isStreaming || !activeConversationId) return;
    if (drainingQueuedMessageIdRef.current) return;
    if (queueDrainPausedRef.current) return;
    // Flush the ENTIRE queue in one drain: every message still waiting when
    // the app goes idle is combined (in queue order) into a single turn so
    // the assistant answers them together instead of running one full
    // response turn per queued message. A lone queued message passes through
    // `combineQueuedSendPayloads` untouched.
    const drainable = orderQueuedMessages(
      queuedStreamPayloadsRef.current.filter(
        (message) => message.conversationId === activeConversationId,
      ),
    );
    const combined = combineQueuedSendPayloads(drainable);
    if (!combined) return;

    const drainedIds = new Set(drainable.map((message) => message.id));
    drainingQueuedMessageIdRef.current = combined.id;
    drainingQueuedPayloadsRef.current = drainable;
    queuedStreamPayloadsRef.current = queuedStreamPayloadsRef.current.filter(
      (message) => !drainedIds.has(message.id),
    );
    setQueuedUserMessages((current) =>
      current.filter((message) => !drainedIds.has(message.id)),
    );
    const dequeuedAtMs = issueDequeueTimestamp();
    const optimisticEventTemplate =
      drainable.length === 1
        ? combined.optimisticEvent
        : buildOptimisticUserEvent({
            id: combined.id,
            text:
              combined.userPrompt ||
              combined.selectedText?.trim() ||
              "Attached context",
            timestamp: dequeuedAtMs,
            platform: combined.platform,
            timezone: combined.timezone,
            locale: combined.locale,
            ...(combined.messageMetadata
              ? { metadata: combined.messageMetadata }
              : {}),
            attachments: toDisplayAttachments(combined.attachments),
          });
    const optimisticEvent = timestampQueuedOptimisticEventForDrain(
      optimisticEventTemplate,
      dequeuedAtMs,
    );
    setOptimisticEvents((current) =>
      current.some((event) => event._id === combined.id)
        ? current
        : [...current, optimisticEvent],
    );
    setPendingUserMessageId(combined.id);

    startStream({
      userPrompt: combined.userPrompt,
      selectedText: combined.selectedText,
      chatContext: combined.chatContext,
      deviceId: combined.deviceId,
      platform: combined.platform,
      timezone: combined.timezone,
      locale: combined.locale,
      ...(combined.messageMetadata
        ? { messageMetadata: combined.messageMetadata }
        : {}),
      attachments: combined.attachments,
      userMessageEventId: combined.id,
      onUserMessageAccepted: (acceptedId: string) =>
        reconcileAcceptedUserMessage(combined.id, acceptedId),
      userMessageTimestamp: optimisticEvent.timestamp,
      onStartFailed: () => {
        if (drainingQueuedMessageIdRef.current === combined.id) {
          drainingQueuedMessageIdRef.current = null;
        }
        const failedDrain = drainingQueuedPayloadsRef.current;
        drainingQueuedPayloadsRef.current = [];
        queueDrainPausedRef.current = true;
        queuedStreamPayloadsRef.current = restoreQueuedMessagesAfterFailedDrain(
          queuedStreamPayloadsRef.current,
          failedDrain,
        );
        clearOptimisticMessage(combined.id);
        setQueuedUserMessages((current) =>
          restoreQueuedMessagesAfterFailedDrain(
            current,
            failedDrain.map((message) => {
              const payload = message.optimisticEvent.payload as
                | { text?: unknown }
                | undefined;
              return {
                id: message.id,
                text:
                  (typeof payload?.text === "string" ? payload.text : "") ||
                  message.userPrompt ||
                  "Attached context",
                timestamp: message.optimisticEvent.timestamp,
                queueOrder: message.queueOrder,
              };
            }),
          ),
        );
      },
    });
  }, [
    activeConversationId,
    clearOptimisticMessage,
    isStreaming,
    issueDequeueTimestamp,
    setPendingUserMessageId,
    startStream,
    reconcileAcceptedUserMessage,
  ]);

  useEffect(() => {
    if (!pendingUserMessageId) return;

    // Once the runtime is no longer streaming AND we've seen a
    // persisted assistant_message that targets the pending user
    // message, drop `pendingUserMessageId` so composer / scroll
    // gating logic stops treating the turn as in-flight. Do NOT wipe
    // `streamingAssistants` here: active live rows keep owning the
    // visible text and borrow SQLite metadata as it arrives. A
    // multi-message run (preamble + post-tool answer) persists each row
    // as its own SQLite write, often across two `localChat:updated`
    // snapshots; clearing on the first snapshot would still drop the
    // second row's live stream for one tick.
    if (isStreaming) return;
    const hasAssistantReply = persistedMessages.some((message) => {
      if (message.type !== "assistant_message") return false;
      if (!message.payload || typeof message.payload !== "object") return false;
      const payload = message.payload as { userMessageId?: string };
      return payload.userMessageId === pendingUserMessageId;
    });
    if (hasAssistantReply) {
      setPendingUserMessageId(null);
    }
  }, [
    isStreaming,
    pendingUserMessageId,
    persistedMessages,
    setPendingUserMessageId,
  ]);

  const acknowledgeMessages = useCallback((messages: readonly MessageRecord[]) => {
    const persistedIds = new Set(
      messages.map((message) => message._id),
    );
    setOptimisticEvents((current) => {
      const next = current.filter((event) => !persistedIds.has(event._id));
      return next.length === current.length ? current : next;
    });
  }, []);

  useEffect(() => {
    if (optimisticEvents.length > 0) acknowledgeMessages(persistedMessages);
  }, [acknowledgeMessages, optimisticEvents, persistedMessages]);

  useEffect(() => {
    const persistedIds = new Set(
      persistedMessages.map((message) => message._id),
    );
    const queuedPayloads = queuedStreamPayloadsRef.current.filter(
      (message) => !persistedIds.has(message.id),
    );
    if (queuedPayloads.length !== queuedStreamPayloadsRef.current.length) {
      queuedStreamPayloadsRef.current = queuedPayloads;
    }
    if (queuedUserMessages.length > 0) {
      setQueuedUserMessages((current) => {
        const next = current.filter((message) => !persistedIds.has(message.id));
        return next.length === current.length ? current : next;
      });
    }
  }, [persistedMessages, queuedUserMessages.length]);

  useEffect(() => {
    drainQueuedMessagesIfIdle();
  }, [drainQueuedMessagesIfIdle, queuedUserMessages.length]);

  const sendMessage = useCallback(
    async (options: SendMessageArgs) => {
      const resolvedConversationId = activeConversationId;
      const cleanedText = options.text.trim();
      const contextState = resolveComposerContextState(
        options.chatContext,
        options.selectedText,
      );
      const hasAttachments = Boolean(
        options.chatContext?.regionScreenshots?.length ||
        options.chatContext?.files?.length,
      );

      if (
        !resolvedConversationId ||
        activeConversationIdRef.current !== resolvedConversationId ||
        (!cleanedText && !contextState.hasSubmittableContext)
      ) {
        return false;
      }
      if (pendingSendRef.current) {
        return false;
      }

      const sendAttempt = Symbol("composer-send");
      pendingSendRef.current = sendAttempt;
      setIsSending(true);

      const attachments =
        isLocalStorage && hasAttachments
          ? buildAllLocalAttachments(options.chatContext)
          : [];
      const messageMetadata = buildContextMessageMetadata(
        options.chatContext,
        options.selectedText,
        options.metadata,
      );
      const platform = getPlatform();
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const requestLocale = locale;
      const optimisticUserMessageId = createLocalMessageId();
      const optimisticText =
        cleanedText || options.selectedText?.trim() || "Attached context";

      const messageTimestamp = Date.now();
      const optimisticEvent = buildOptimisticUserEvent({
        id: optimisticUserMessageId,
        text: optimisticText,
        timestamp: messageTimestamp,
        platform,
        timezone,
        locale: requestLocale,
        ...(messageMetadata ? { metadata: messageMetadata } : {}),
        attachments: toDisplayAttachments(attachments),
      });

      setOptimisticEvents((current) => [...current, optimisticEvent]);
      setPendingUserMessageId(optimisticUserMessageId);
      options.onClear();
      options.onOptimisticStart?.();

      try {
        const deviceId = await getOrCreateDeviceId();
        const accepted = await startStream({
          userPrompt: cleanedText,
          selectedText: options.selectedText,
          chatContext: options.chatContext,
          deviceId,
          platform,
          timezone,
          locale: requestLocale,
          ...(messageMetadata ? { messageMetadata } : {}),
          attachments,
          userMessageEventId: optimisticUserMessageId,
          onUserMessageAccepted: (acceptedId: string) =>
            reconcileAcceptedUserMessage(optimisticUserMessageId, acceptedId),
          userMessageTimestamp: messageTimestamp,
        });
        if (!accepted) {
          clearOptimisticMessage(optimisticUserMessageId);
          options.onRestore?.();
          return false;
        }

        // Fire-and-forget: surface a "model not available on your plan"
        // toast for restricted tiers (anonymous/free/go) when the user has a
        // saved non-default override for orchestrator/general. The backend
        // silently coerces to the tier-default model regardless. Deduped so
        // it doesn't spam on every send.
        void notifyTierRestrictedModel?.();

        console.log(
          `[stella:trace] sendMessage (steer) | textLength=${cleanedText.length}`,
        );
        return true;
      } catch (error) {
        clearOptimisticMessage(optimisticUserMessageId);
        options.onRestore?.();
        console.error(
          "Failed to prepare local agent chat:",
          error instanceof Error ? error.message : String(error),
        );
        return false;
      } finally {
        if (pendingSendRef.current === sendAttempt) {
          pendingSendRef.current = null;
          setIsSending(false);
        }
      }
    },
    [
      activeConversationId,
      isLocalStorage,
      clearOptimisticMessage,
      notifyTierRestrictedModel,
      startStream,
      reconcileAcceptedUserMessage,
      locale,
      setPendingUserMessageId,
    ],
  );

  return {
    taskDecorations,
    optimisticEvents,
    acknowledgeMessages,
    queuedUserMessages,
    runtimeStatusText,
    activeToolCallId,
    activeToolName,
    latestCompletedTool,
    hasToolActivity,
    isToolActive,
    reasoningText,
    streamingAssistants,
    isStreaming: isSending || isStreaming,
    answerLanded: !isSending && answerLanded,
    pendingUserMessageId,
    removeQueuedUserMessage,
    sendMessage,
    cancelCurrentStream,
  };
}
