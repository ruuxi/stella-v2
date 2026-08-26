import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { EventRecord, MessageRecord } from "@stella/contracts/local-chat";
import type { TaskItem } from "@/features/chat/lib/event-transforms";
import type { StreamingAssistantOverlay } from "@/features/chat/streaming/streaming-types";
import { streamingAssistantOverlayId } from "@/features/chat/streaming/streaming-types";
import type { SendMessageArgs } from "@/features/chat/streaming/chat-types";
import { showToast } from "@/ui/toast";
import {
  cloudAttachmentsStore,
  isWebShell,
  type CloudAttachment,
  withAttachmentPreamble,
} from "./cloud-composer-store";
import {
  activeCloudUserMessageIds,
  completeJournalWindowRecords,
  journalRecordsToMessageRecords,
  mergeCanonicalMessagesWithLocalCache,
} from "./journal-message-records";
import {
  journalRecordsToCloudActivityEvents,
  journalRecordsToCloudFileEvents,
  mergeCanonicalCloudEventsWithLocalOverlay,
  nextLocalCloudEventOverlayExpiry,
} from "./journal-activity-files";
import {
  mergeCloudConversationTasks,
  useCloudConversationActivity,
} from "./use-cloud-activity";
import { messageText, type JournalRecord } from "./conversation-protocol";
import type { PendingPrompt } from "./conversation-store";
import {
  useConversation,
  type CloudConversationView,
} from "./use-conversation";
import "./cloud-chat-status.css";

const EMPTY_EVENTS: EventRecord[] = [];
const EMPTY_MESSAGES: MessageRecord[] = [];
const EMPTY_TASKS: TaskItem[] = [];
export const LOCAL_CLOUD_TASK_OVERLAY_TTL_MS = 10 * 60_000;

const journalUserMessageId = (
  record: Extract<JournalRecord, { kind: "message" }>,
): string =>
  record.clientMsgId ?? `cloud:${record.turnId}:message:${record.seq}`;

export const findCloudUserMessageRecord = (
  records: readonly JournalRecord[],
  userMessageId: string,
): Extract<JournalRecord, { kind: "message" }> | null =>
  records.find(
    (record): record is Extract<JournalRecord, { kind: "message" }> =>
      record.kind === "message" &&
      record.role === "user" &&
      journalUserMessageId(record) === userMessageId,
  ) ?? null;

/** Existing Fork/Rewind UX operates on the prefix before the chosen prompt. */
export const cloudPrefixBoundaryForUserMessage = (
  records: readonly JournalRecord[],
  userMessageId: string,
): { targetSeq: number; throughSeq: number } | null => {
  const record = findCloudUserMessageRecord(records, userMessageId);
  return record ? { targetSeq: record.seq, throughSeq: record.seq - 1 } : null;
};

export const cloudPendingPromptsToEvents = (
  pending: readonly PendingPrompt[],
): EventRecord[] =>
  pending.map((entry) => ({
    _id: entry.clientMsgId,
    timestamp: entry.createdAtMs,
    type: "user_message",
    payload: { text: entry.text },
  }));

const owningUserMessageId = (
  records: readonly JournalRecord[],
  pending: readonly PendingPrompt[],
  turnId: string,
): string | null => {
  const canonical = records.find(
    (record): record is Extract<JournalRecord, { kind: "message" }> =>
      record.kind === "message" &&
      record.role === "user" &&
      record.turnId === turnId,
  );
  if (canonical) return journalUserMessageId(canonical);
  return pending.find((entry) => entry.turnId === turnId)?.clientMsgId ?? null;
};

export const cloudLiveToStreamingAssistants = (
  records: readonly JournalRecord[],
  pending: readonly PendingPrompt[],
  live: CloudConversationView["state"]["live"],
): StreamingAssistantOverlay[] => {
  if (!live?.text) return [];
  const userMessageId = owningUserMessageId(records, pending, live.turnId);
  if (!userMessageId) return [];
  const committedAssistantCount = records.filter(
    (record) =>
      record.kind === "message" &&
      record.role === "assistant" &&
      record.turnId === live.turnId &&
      Boolean(messageText(record.payload)),
  ).length;
  const indexInTurn = committedAssistantCount + 1;
  const latestTurnTimestamp = records
    .filter((record) => record.turnId === live.turnId)
    .at(-1)?.createdAtMs;
  const pendingTimestamp = pending.find(
    (entry) => entry.turnId === live.turnId,
  )?.createdAtMs;
  return [
    {
      _id: streamingAssistantOverlayId(userMessageId, indexInTurn),
      userMessageId,
      indexInTurn,
      text: live.text,
      timestamp: (latestTurnTimestamp ?? pendingTimestamp ?? 0) + 1,
      runId: live.turnId,
    },
  ];
};

/**
 * Cloud start currently accepts one visible prompt string. Text remains
 * byte-for-byte what the user typed; a context-only submit gets a readable
 * fallback instead of silently doing nothing. Rich/hidden composer context is
 * intentionally not serialized into the visible journal row.
 */
export const cloudPromptFromSendArgs = (args: SendMessageArgs): string => {
  const text = args.text.trim();
  if (text) return text;
  const selected = args.selectedText?.trim();
  if (selected) return `Help me with this selected text:\n\n${selected}`;
  const pasted = args.chatContext?.pastedTexts
    ?.map((entry) => entry.trim())
    .filter((entry): entry is string => Boolean(entry))
    .join("\n\n");
  if (pasted) return `Help me with this pasted text:\n\n${pasted}`;
  return args.chatContext ? "Help me with the attached context." : "";
};

/**
 * Local SQLite is only a transient overlay while the canonical socket is
 * live. Connecting, offline, and terminal/blocked states must render the
 * cloud projection (or an explicit error) instead of reviving cached rows as
 * an undeclared local authority.
 */
export const shouldUseLocalCloudOverlay = (
  status: CloudConversationView["status"],
): boolean => status === "live";

export const localCloudTaskOverlay = (
  status: CloudConversationView["status"],
  tasks: readonly TaskItem[],
  nowMs: number,
): TaskItem[] => {
  if (!shouldUseLocalCloudOverlay(status)) return [];
  return tasks.filter(
    (task) =>
      task.status === "running" &&
      Number.isFinite(task.lastUpdatedAtMs) &&
      task.lastUpdatedAtMs <= nowMs + 60_000 &&
      task.lastUpdatedAtMs + LOCAL_CLOUD_TASK_OVERLAY_TTL_MS > nowMs,
  );
};

const nextLocalCloudTaskOverlayExpiry = (
  tasks: readonly TaskItem[],
  nowMs: number,
): number | null => {
  let next: number | null = null;
  for (const task of localCloudTaskOverlay("live", tasks, nowMs)) {
    const expiresAt = task.lastUpdatedAtMs + LOCAL_CLOUD_TASK_OVERLAY_TTL_MS;
    if (next === null || expiresAt < next) next = expiresAt;
  }
  return next;
};

function CloudConversationStatusTail({
  conversation,
}: {
  conversation: CloudConversationView;
}) {
  const { state, pending, retryConnection, retrySend, dismissSend } =
    conversation;
  const failed = pending.filter((entry) => Boolean(entry.error));
  const showConnection =
    state.status === "blocked" ||
    (state.status === "offline" && Boolean(state.statusMessage));
  if (!showConnection && failed.length === 0 && !state.olderNotice) return null;
  return (
    <div className="cloud-chat-status-tail">
      {showConnection ? (
        <div
          className="cloud-chat-status-tail__notice"
          data-status={state.status}
          role="status"
        >
          <span>
            {state.statusMessage ?? "Reconnecting to Stella's cloud…"}
          </span>
          {state.status === "blocked" && state.statusRetryable ? (
            <button type="button" onClick={retryConnection}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {state.olderNotice ? (
        <div className="cloud-chat-status-tail__notice">
          {state.olderNotice}
        </div>
      ) : null}
      {failed.map((entry) => (
        <div
          className="cloud-chat-status-tail__notice cloud-chat-status-tail__notice--error"
          key={entry.clientMsgId}
          role="alert"
        >
          <span>{entry.error}</span>
          <span className="cloud-chat-status-tail__actions">
            <button
              type="button"
              onClick={() => void retrySend(entry.clientMsgId)}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => dismissSend(entry.clientMsgId)}
            >
              Discard
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

const useLocalOverlayClock = (
  activity: readonly EventRecord[],
  files: readonly EventRecord[],
  tasks: readonly TaskItem[],
): number => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  // A newly arrived overlay needs a fresh comparison clock before paint. If
  // the prior render is minutes old, using its timestamp can classify a real
  // task as a future record and hide it until the TTL timer finally fires.
  useLayoutEffect(() => {
    setNowMs(Date.now());
  }, [activity, files, tasks]);
  useEffect(() => {
    const now = Date.now();
    const expiries = [
      nextLocalCloudEventOverlayExpiry(activity, now),
      nextLocalCloudEventOverlayExpiry(files, now),
      nextLocalCloudTaskOverlayExpiry(tasks, now),
    ].filter((value): value is number => value !== null);
    const next = expiries.length ? Math.min(...expiries) : null;
    if (next === null) return;
    const timer = window.setTimeout(
      () => setNowMs(Date.now()),
      Math.max(0, next - now) + 1,
    );
    return () => window.clearTimeout(timer);
  }, [activity, files, nowMs, tasks]);
  return nowMs;
};

export type CloudChatBridge = {
  conversation: CloudConversationView;
  records: readonly JournalRecord[];
  persistedMessages: MessageRecord[];
  activities: EventRecord[];
  files: EventRecord[];
  tasks: TaskItem[];
  optimisticEvents: EventRecord[];
  streamingAssistants: StreamingAssistantOverlay[];
  isWebShell: boolean;
  isStreaming: boolean;
  isStreamingResponseText: boolean;
  runtimeStatusText: string | null;
  activeToolName: string | null;
  pendingUserMessageId: string | null;
  isInitialLoading: boolean;
  sendMessage: (args: SendMessageArgs) => Promise<boolean>;
  cancelCurrentStream: () => void;
  extraTail: ReactNode;
};

export function useCloudChatBridge({
  conversationId,
  enabled,
  localMessages,
  localActivities,
  localFiles,
  localTasks,
}: {
  conversationId: string | null;
  enabled: boolean;
  localMessages: MessageRecord[];
  localActivities: EventRecord[];
  localFiles: EventRecord[];
  localTasks: TaskItem[];
}): CloudChatBridge {
  const decoratePrompt = useCallback(
    (prompt: string, attachments: readonly CloudAttachment[]) =>
      withAttachmentPreamble(prompt, attachments),
    [],
  );
  const onSent = useCallback(
    (submittedAttachments: readonly CloudAttachment[]) => {
      cloudAttachmentsStore.clearIfCurrent(submittedAttachments);
    },
    [],
  );
  const conversation = useConversation(
    enabled ? conversationId : null,
    decoratePrompt,
    onSent,
  );
  const cloudActivity = useCloudConversationActivity(
    enabled ? conversationId : null,
  );
  const webShell = isWebShell();
  const completeRecords = useMemo(
    () =>
      completeJournalWindowRecords(
        conversation.state.records,
        conversation.state.hasOlder,
      ),
    [conversation.state.hasOlder, conversation.state.records],
  );
  const canonicalMessages = useMemo(
    () => journalRecordsToMessageRecords(completeRecords),
    [completeRecords],
  );
  const activeUserIds = useMemo(
    () => activeCloudUserMessageIds(completeRecords),
    [completeRecords],
  );
  const mayUseLocalOverlay = shouldUseLocalCloudOverlay(
    conversation.state.status,
  );
  const persistedMessages = useMemo(
    () =>
      enabled
        ? mergeCanonicalMessagesWithLocalCache(
            canonicalMessages,
            mayUseLocalOverlay ? localMessages : EMPTY_MESSAGES,
            activeUserIds,
          )
        : EMPTY_MESSAGES,
    [
      activeUserIds,
      canonicalMessages,
      enabled,
      localMessages,
      mayUseLocalOverlay,
    ],
  );
  const canonicalActivities = useMemo(
    () => journalRecordsToCloudActivityEvents(completeRecords),
    [completeRecords],
  );
  const canonicalFiles = useMemo(
    () => journalRecordsToCloudFileEvents(completeRecords),
    [completeRecords],
  );
  const overlayNowMs = useLocalOverlayClock(
    localActivities,
    localFiles,
    localTasks,
  );
  const activities = useMemo(
    () =>
      enabled
        ? mergeCanonicalCloudEventsWithLocalOverlay(
            canonicalActivities,
            mayUseLocalOverlay ? localActivities : EMPTY_EVENTS,
            { nowMs: overlayNowMs },
          )
        : EMPTY_EVENTS,
    [
      canonicalActivities,
      enabled,
      localActivities,
      mayUseLocalOverlay,
      overlayNowMs,
    ],
  );
  const files = useMemo(
    () =>
      enabled
        ? mergeCanonicalCloudEventsWithLocalOverlay(
            canonicalFiles,
            mayUseLocalOverlay ? localFiles : EMPTY_EVENTS,
            { nowMs: overlayNowMs },
          )
        : EMPTY_EVENTS,
    [canonicalFiles, enabled, localFiles, mayUseLocalOverlay, overlayNowMs],
  );
  const tasks = useMemo(
    () =>
      enabled && cloudActivity.hasLoaded
        ? mergeCloudConversationTasks(
            cloudActivity.tasks,
            localCloudTaskOverlay(
              conversation.state.status,
              localTasks,
              overlayNowMs,
            ),
          )
        : EMPTY_TASKS,
    [
      cloudActivity.hasLoaded,
      cloudActivity.tasks,
      conversation.state.status,
      enabled,
      localTasks,
      overlayNowMs,
    ],
  );
  const optimisticEvents = useMemo(
    () =>
      enabled && webShell
        ? cloudPendingPromptsToEvents(conversation.pending)
        : EMPTY_EVENTS,
    [conversation.pending, enabled, webShell],
  );
  const streamingAssistants = useMemo(
    () =>
      enabled && webShell
        ? cloudLiveToStreamingAssistants(
            completeRecords,
            conversation.pending,
            conversation.state.live,
          )
        : [],
    [
      completeRecords,
      conversation.pending,
      conversation.state.live,
      enabled,
      webShell,
    ],
  );
  const pendingInFlight = conversation.pending.filter((entry) => !entry.error);
  const isStreaming = Boolean(
    enabled && webShell && (conversation.state.live || pendingInFlight.length),
  );

  const sendMessage = useCallback(
    async (args: SendMessageArgs): Promise<boolean> => {
      if (!enabled || !webShell || !conversationId) return false;
      if (
        conversation.pending.some(
          (entry) => entry.turnId === null && !entry.error,
        )
      ) {
        return false;
      }
      const prompt = cloudPromptFromSendArgs(args);
      if (!prompt) return false;
      // `send` registers the optimistic row synchronously before awaiting the
      // mutation. Once it is visible, the composer can clear; any failure is
      // retained on that same row with idempotent Retry/Discard controls.
      void conversation.send(prompt);
      args.onClear();
      return true;
    },
    [conversation, conversationId, enabled, webShell],
  );

  const cancelCurrentStream = useCallback(() => {
    if (!enabled || !webShell) return;
    const turnId =
      conversation.state.live?.turnId ??
      conversation.pending.findLast(
        (entry) => entry.turnId !== null && !entry.error,
      )?.turnId ??
      null;
    if (turnId && conversation.cancelTurn(turnId)) return;
    showToast({
      title: "Couldn’t stop this cloud turn",
      description: "The stop could not be delivered. Try again in a moment.",
      variant: "error",
    });
  }, [conversation, enabled, webShell]);

  const extraTail = useMemo<ReactNode>(
    () =>
      enabled ? (
        <CloudConversationStatusTail conversation={conversation} />
      ) : null,
    [conversation, enabled],
  );
  const pendingUserMessageId = optimisticEvents.at(-1)?._id ?? null;
  const activeToolName = conversation.state.live?.toolName ?? null;

  return {
    conversation,
    records: completeRecords,
    persistedMessages,
    activities,
    files,
    tasks,
    optimisticEvents,
    streamingAssistants,
    isWebShell: webShell,
    isStreaming,
    isStreamingResponseText: Boolean(conversation.state.live?.text),
    runtimeStatusText: activeToolName
      ? (conversation.state.live?.toolLabel ?? `Running ${activeToolName}…`)
      : isStreaming
        ? "Thinking…"
        : null,
    activeToolName,
    pendingUserMessageId,
    isInitialLoading: Boolean(
      enabled &&
        conversationId &&
        conversation.state.records.length === 0 &&
        (conversation.state.status === "idle" ||
          conversation.state.status === "connecting"),
    ),
    sendMessage,
    cancelCurrentStream,
    extraTail,
  };
}
