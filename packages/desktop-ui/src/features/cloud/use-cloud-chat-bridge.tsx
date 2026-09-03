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
  countReplyRefs,
  provideReplyCounts,
} from "@/features/chat/services/reply-counts-store";
import { provideLineageSource } from "@/features/chat/services/lineage-messages-store";
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
import type { JournalRecord } from "./conversation-protocol";
import type { PendingPrompt } from "./conversation-store";
import {
  useConversation,
  type CloudConversationView,
} from "./use-conversation";
import "./cloud-chat-status.css";
import { browserAttachmentUploads } from "./browser-chat-attachments";

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

/**
 * Only a prompt that is still awaiting canonical cloud progress may drive the
 * queued-user entrance animation. Failed prompts remain visible for their
 * Retry/Discard controls, but they are settled UI and must not stay "pending".
 */
export const latestInFlightCloudUserMessageId = (
  pending: readonly PendingPrompt[],
): string | null =>
  pending.findLast((entry) => !entry.error)?.clientMsgId ?? null;

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
 * Local execution rows are only a transient overlay while the canonical
 * socket is live. They are distinct from the explicitly labelled derived
 * cloud-journal cache and can never revive as an undeclared authority.
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
  const showCached =
    state.recordsSource === "cached-stale" && state.records.length > 0;
  if (
    !showConnection &&
    !showCached &&
    failed.length === 0 &&
    !state.olderNotice
  ) {
    return null;
  }
  return (
    <div className="cloud-chat-status-tail">
      {showCached ? (
        <div
          className="cloud-chat-status-tail__notice"
          data-status="cached-stale"
          role="status"
        >
          Showing saved history while reconnecting. New activity still requires
          Stella&apos;s cloud.
        </div>
      ) : null}
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
  hasOlderActivity: boolean;
  isLoadingOlderActivity: boolean;
  loadOlderActivity: () => void;
  optimisticEvents: EventRecord[];
  isWebShell: boolean;
  isStreaming: boolean;
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
      browserAttachmentUploads.clearReady(
        new Set(submittedAttachments.map((attachment) => attachment.path)),
      );
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
    const pendingEntry = conversation.pending.findLast((entry) => !entry.error);
    const turnId =
      conversation.state.live?.turnId ??
      (pendingEntry?.turnId !== null ? pendingEntry?.turnId : null) ??
      null;
    const cancellation = turnId
      ? conversation.cancelTurn(turnId)
      : pendingEntry
        ? conversation.cancelPending(pendingEntry.clientMsgId)
        : Promise.resolve(false);
    void cancellation.then((delivered) => {
      if (delivered) return;
      showToast({
        title: "Couldn’t stop this cloud turn",
        description: "The stop could not be delivered. Try again in a moment.",
        variant: "error",
      });
    });
  }, [conversation, enabled, webShell]);

  // Reply references in cloud mode resolve client-side from the loaded
  // journal window (there is no local `entry_ref` index for a cloud
  // conversation), so the counts and focus lineage come from here.
  useEffect(() => {
    if (!enabled || !conversationId) return;
    provideReplyCounts(conversationId, countReplyRefs(persistedMessages));
    provideLineageSource(conversationId, {
      messages: persistedMessages,
      hasOlder: conversation.state.hasOlder,
      loadOlder: conversation.loadOlder,
      tasks,
    });
    return () => {
      provideReplyCounts(conversationId, null);
      provideLineageSource(conversationId, null);
    };
  }, [
    conversation.loadOlder,
    conversation.state.hasOlder,
    conversationId,
    enabled,
    persistedMessages,
    tasks,
  ]);

  const extraTail = useMemo<ReactNode>(
    () =>
      enabled ? (
        <CloudConversationStatusTail conversation={conversation} />
      ) : null,
    [conversation, enabled],
  );
  const pendingUserMessageId = latestInFlightCloudUserMessageId(
    conversation.pending,
  );
  const activeToolName = conversation.state.live?.toolName ?? null;

  return {
    conversation,
    records: completeRecords,
    persistedMessages,
    activities,
    files,
    tasks,
    hasOlderActivity: cloudActivity.hasOlder,
    isLoadingOlderActivity: cloudActivity.isLoadingOlder,
    loadOlderActivity: cloudActivity.loadOlder,
    optimisticEvents,
    isWebShell: webShell,
    isStreaming,
    runtimeStatusText: activeToolName
      ? (conversation.state.live?.toolLabel ?? `Running ${activeToolName}…`)
      : isStreaming
        ? "Thinking…"
        : null,
    activeToolName,
    pendingUserMessageId,
    // The local replica (including an explicit known-empty snapshot) paints
    // immediately. Cloud reconciliation is connection status, not a reason to
    // replace the entire chat surface with a blocking history spinner.
    isInitialLoading: false,
    sendMessage,
    cancelCurrentStream,
    extraTail,
  };
}
