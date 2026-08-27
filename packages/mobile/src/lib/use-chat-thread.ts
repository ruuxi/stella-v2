import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, LayoutAnimation } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import {
  loadChatMessages,
  saveChatMessages,
  loadChatSyncState,
  saveChatSyncState,
  type ChatThreadId,
} from "./offline-chat-storage";
import {
  acknowledgeDesktopChatOutbox,
  enqueueDesktopChatOutbox,
  loadDesktopChatOutbox,
} from "./desktop-chat-outbox";
import {
  restoreOutboxMessages,
  type DesktopChatOutboxRecord,
} from "./desktop-chat-outbox-state";
import { postStream, postStreamAnonymous, StreamAbortError } from "./http";
import type { MobileChatStreamToolCall } from "./mobile-chat-stream";
import { hasAiConsent, requestAiConsent } from "./ai-consent";
import {
  getOrCreateMobileDeviceId,
  type StoredPhoneAccess,
} from "./phone-access";
import {
  closeDesktopBridgeSendBatch,
  DesktopOfflineError,
  fetchDesktopBridgeThreadTasks,
  sendDesktopBridgeChat,
  sendDesktopBridgeSteer,
  syncDesktopBridgeChatMessages,
  type DesktopBridgeActivity,
  type DesktopBridgeAttachment,
  type DesktopBridgeSendBatch,
  type DesktopBridgeSendStatus,
  type DesktopTaskDecoration,
} from "./desktop-bridge-chat";
import {
  buildWorkingIndicatorState,
  IDLE_WORKING_ACTIVITY,
  WORKING_ACTIVITY_KEYS,
  type WorkingActivity,
  type WorkingIndicatorState,
} from "../components/working-indicator-state";
import {
  collapseLinkedDuplicates,
  finalizeAssistantTurnText,
  linkOptimisticTurnToCanonical,
  mergeMessagesById,
  reconcileSentDesktopTurn,
  retargetOptimisticReplyToUser,
} from "./chat-merge";
import { openDesktopBridgeLive } from "./desktop-bridge-live";
import {
  consumeDesktopLocalChatPush,
  desktopLiveConnectionSyncPlan,
  desktopSyncPullPlan,
  desktopSyncJoinPlan,
  desktopTaskPollIntervalMs,
  mergeDeferredDesktopSyncIntent,
  shouldArmDesktopTaskPoll,
  shouldDeferLocalChatPushDuringSend,
  shouldStartDesktopSyncRun,
  shouldScheduleDesktopTranscriptSyncForPush,
  shouldSyncOnLocalChatPush,
} from "./desktop-sync-policy";
import { recordSyncDiagnostic } from "./sync-diagnostics";
import { applyLiveAgentWorkState } from "./agent-work-live-state";
import {
  collectConversationTasks,
  overlayDesktopThreadTasks,
} from "./mobile-task-merge";
import {
  collectActivityHubArtifacts,
  groupActivityArtifacts,
} from "./activity-hub-model";
import { toSendableImage } from "./image-attachments";
import {
  buildOfflineChatRequest,
  prepareOfflineChatImages,
  type OfflineChatImagePayload,
  type OfflineChatToolMessage,
} from "./offline-chat-request";
import { admitSend } from "./send-admission";
import { shouldReuseQueuedReplayBatch } from "./desktop-send-batch-policy";
import { drainDesktopSteerAcceptanceQueue } from "./desktop-steer-pump";
import { userFacingError } from "./user-facing-error";
import { notifySuccess } from "./haptics";
import { loadMemoryFacts, rememberFact, forgetFact } from "./chat-memory";
import {
  loadCheckpoint,
  runCompaction,
  buildCompactedContext,
} from "./chat-compaction";
import { buildMobileModelContext, normalizeMobileToolCall } from "./chat-tools";
import { formatRecallResults } from "./chat-recall";
import {
  initMessageIndex,
  indexMessages,
  searchMessages,
} from "./chat-message-index";
import { resolveMap, mapArtifactFor } from "./chat-maps";
import { generatePdf, pdfArtifactFor } from "./chat-pdf";
import { generateChatImage } from "./chat-image-gen";
import { searchChatWeb } from "./chat-web-search";
import type {
  ChatArtifact,
  ChatMessage,
  ComposerQuote,
  MobileTask,
} from "../types";

export type DesktopSyncOutcome = {

  offline: boolean;

  deferred?: boolean;

  rows?: number;

  acceptedUserMessageIds?: string[];

  preparedSend?: DesktopBridgeSendBatch;

  error?: string;
};

const HISTORY_MESSAGE_LIMIT = 100;

const OFFLINE_CHAT_STREAM_PATH = "/api/mobile/offline-chat/stream";

const OFFLINE_ARTIFACT_CONVERSATION_ID = "offline-chat";

const MAX_OFFLINE_TOOL_ROUNDS = 4;

const PERSIST_DEBOUNCE_MS = 500;

let lastLocalIdOrder = 0;
const createId = () => {

  lastLocalIdOrder = Math.max(Date.now(), lastLocalIdOrder + 1);
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `mobile:${String(lastLocalIdOrder).padStart(16, "0")}:${random}`;
};

const composeQuotedText = (quotes: ComposerQuote[], typed: string): string => {
  if (quotes.length === 0) return typed;
  const blocks = quotes
    .map((quote) =>
      quote.text
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
    )
    .join("\n\n");
  return typed ? `${blocks}\n\n${typed}` : blocks;
};

const composeRawQuotes = (quotes: ComposerQuote[]): string =>
  quotes
    .map((quote) => quote.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");

const QUOTED_TEXT_PREVIEW_MAX_CHARS = 4_000;

const WAKE_STATUS_COPY: Record<DesktopBridgeSendStatus, string | undefined> = {
  connecting: undefined,
  waking: "Waking your computer",
  running: undefined,
};

const assetsToBridgeAttachments = async (
  assets: ImagePicker.ImagePickerAsset[],
): Promise<DesktopBridgeAttachment[]> => {
  const out: DesktopBridgeAttachment[] = [];
  for (const asset of assets) {

    const sendable = await toSendableImage(asset);
    if (!sendable) continue;
    out.push({
      url: `data:${sendable.mimeType};base64,${sendable.base64}`,
      mimeType: sendable.mimeType,
    });
  }
  if (assets.length > 0 && out.length === 0) {

    throw new Error("Couldn't attach that photo. Try a different image.");
  }
  return out;
};

const restoreRewoundAttachments = async (
  message: ChatMessage,
): Promise<ImagePicker.ImagePickerAsset[]> => {
  const uris = message.thumbnailUris ?? [];
  if (uris.length === 0) return [];
  const assets: ImagePicker.ImagePickerAsset[] = [];
  for (const uri of uris) {
    try {
      const base64 = await new File(uri).base64();
      if (!base64) continue;

      assets.push({
        uri,
        base64,
        width: 0,
        height: 0,
      } as ImagePicker.ImagePickerAsset);
    } catch {

    }
  }
  return assets;
};

type QueuedSend = {
  dispatchId: string;
  clientRequestId: string;
  userMessageId: string;

  text: string;

  promptText?: string;

  selectedText?: string;
  assets: ImagePicker.ImagePickerAsset[];
  queueSequence?: number;
};

export type ChatTransport =
  | { kind: "cloud"; guest: boolean }
  | { kind: "desktop"; access: StoredPhoneAccess };

export type ChatThread = {

  conversationId?: string | null;
  messages: ChatMessage[];
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  attachments: ImagePicker.ImagePickerAsset[];
  setAttachments: React.Dispatch<
    React.SetStateAction<ImagePicker.ImagePickerAsset[]>
  >;

  quotes: ComposerQuote[];

  addQuote: (text: string) => void;

  removeQuote: (id: string) => void;
  sending: boolean;

  workingIndicator: WorkingIndicatorState;
  storageLoaded: boolean;

  conversationArtifacts: ChatArtifact[];

  conversationTasks: MobileTask[];

  activityArtifactsByTaskId: ReadonlyMap<string, ChatArtifact[]>;

  conversationOwnedArtifacts: ChatArtifact[];

  send: () => { userMessageId: string } | null;

  sendPrompt?: (prompt: string) => { userMessageId: string } | null;
  stop: () => void;

  runDesktopSync: (options?: {
    catchUp?: boolean;
    trigger?: string;
  }) => Promise<DesktopSyncOutcome>;

  livePushConnected: boolean;

  catchingUp: boolean;

  rewindToMessage: (messageId: string) => void;
};

export function useChatThread(opts: {
  threadId: ChatThreadId;
  transport: ChatTransport;
}): ChatThread {
  const { threadId, transport } = opts;
  const isDesktop = transport.kind === "desktop";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(
    isDesktop ? null : threadId,
  );
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);

  const [quotes, setQuotes] = useState<ComposerQuote[]>([]);
  const addQuote = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setQuotes((prev) => [...prev, { id: createId(), text: trimmed }]);
  }, []);
  const removeQuote = useCallback((id: string) => {
    setQuotes((prev) => prev.filter((q) => q.id !== id));
  }, []);
  const [sending, setSending] = useState(false);
  const [appActive, setAppActive] = useState(
    () =>
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive",
  );
  const [workingActivity, setWorkingActivity] = useState<WorkingActivity>(
    IDLE_WORKING_ACTIVITY,
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      setAppActive(next === "active" || next === "unknown");
    });
    return () => subscription.remove();
  }, []);

  const patchActivity = useCallback((patch: Partial<WorkingActivity>) => {
    setWorkingActivity((current) => {

      for (const key of Object.keys(patch) as (keyof WorkingActivity)[]) {
        if (!Object.is(current[key], patch[key])) {
          return { ...current, ...patch };
        }
      }
      return current;
    });
  }, []);

  const replaceActivity = useCallback((next: WorkingActivity) => {
    setWorkingActivity((current) => {
      for (const key of WORKING_ACTIVITY_KEYS) {
        if (!Object.is(current[key], next[key])) return next;
      }
      return current;
    });
  }, []);

  const queueRef = useRef<QueuedSend[]>([]);
  const acceptedDesktopSendIdsRef = useRef<Set<string>>(new Set());
  const stoppedDispatchIdsRef = useRef<Set<string>>(new Set());
  const activeDispatchRef = useRef<{
    dispatchId: string;
    userMessageId: string;
    replyId: string;
    abort: AbortController;
    generation: number;
    primaryAccepted: boolean;
    latestResponseUserMessageId: string;
  } | null>(null);
  const dispatchGenerationRef = useRef(0);
  const pendingEnqueueRef = useRef<Set<string>>(new Set());
  const steerPumpPromiseRef = useRef<Promise<unknown> | null>(null);
  const steerPumpGenerationRef = useRef(0);
  const pumpDesktopSteersRef = useRef<(() => void) | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const syncCursorRef = useRef<string | null>(null);
  const syncConversationIdRef = useRef<string | null>(null);
  const didMountSyncRef = useRef(false);

  const desktopSyncRef = useRef<{
    promise: Promise<DesktopSyncOutcome>;
    catchUp: boolean;
  } | null>(null);
  const desktopSendBatchRef = useRef<DesktopBridgeSendBatch | null>(null);

  const syncGenerationRef = useRef(0);

  const pendingReconcileRef = useRef<Promise<void> | null>(null);
  const drainQueueRef = useRef<(() => void) | null>(null);

  const dispatchRef = useRef<((item: QueuedSend) => Promise<void>) | null>(
    null,
  );

  useEffect(() => {
    void Promise.all([
      loadChatMessages(threadId),
      loadChatSyncState(threadId),
      loadDesktopChatOutbox(threadId),
    ]).then(([loaded, syncState, storedOutbox]) => {
      syncConversationIdRef.current = syncState.conversationId;
      setConversationId(
        isDesktop ? (syncState.conversationId ?? null) : threadId,
      );
      syncCursorRef.current = syncState.cursor;

      const healed = restoreOutboxMessages(
        collapseLinkedDuplicates(loaded),
        storedOutbox,
      );
      setMessages(healed);
      setStorageLoaded(true);

      const outboxByUserMessageId = new Map(
        storedOutbox.map((record) => [record.userMessageId, record]),
      );
      const pendingSends = healed.filter(
        (m) =>
          m.role === "user" &&
          (outboxByUserMessageId.has(m.id) ||
            (m.queued === true && !m.hasImage)) &&
          m.text.trim().length > 0,
      );
      for (const row of pendingSends) {
        const stored = outboxByUserMessageId.get(row.id);
        queueRef.current.push({
          dispatchId: stored?.sendId ?? row.id,
          clientRequestId: stored?.sendId ?? row.id,
          userMessageId: row.id,
          text: stored?.text ?? row.text,
          assets: (stored?.assets ?? []) as ImagePicker.ImagePickerAsset[],
          ...(stored ? { queueSequence: stored.sequence } : {}),
        });
      }
      queueRef.current.sort(
        (a, b) =>
          (a.queueSequence ?? Number.MAX_SAFE_INTEGER) -
          (b.queueSequence ?? Number.MAX_SAFE_INTEGER),
      );

      if (pendingSends.length > 0) {
        drainQueueRef.current?.();
      }
    });
  }, [isDesktop, threadId]);

  const pendingSaveRef = useRef<ChatMessage[] | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMessageChangeAtRef = useRef(0);
  useEffect(() => {
    if (!storageLoaded) return;
    pendingSaveRef.current = messages;
    lastMessageChangeAtRef.current = Date.now();

    if (saveTimerRef.current !== null) return;
    const arm = (delayMs: number) => {
      saveTimerRef.current = setTimeout(() => {
        const idleMs = Date.now() - lastMessageChangeAtRef.current;
        if (idleMs < PERSIST_DEBOUNCE_MS) {
          arm(PERSIST_DEBOUNCE_MS - idleMs);
          return;
        }
        saveTimerRef.current = null;
        const snapshot = pendingSaveRef.current;
        if (!snapshot) return;
        pendingSaveRef.current = null;
        void saveChatMessages(threadId, snapshot);
        if (threadId === "cloud") void indexMessages(snapshot);
      }, delayMs);
    };
    arm(PERSIST_DEBOUNCE_MS);
  }, [messages, storageLoaded, threadId]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current === null) return;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    };
  }, [threadId]);

  useEffect(() => {
    if (threadId !== "cloud") return;
    void initMessageIndex();
  }, [threadId]);

  useEffect(() => {
    return () => {
      const pending = pendingSaveRef.current;
      if (pending) {
        pendingSaveRef.current = null;
        void saveChatMessages(threadId, pending);
      }
    };
  }, [threadId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const sendingRef = useRef(false);
  const markSending = useCallback((next: boolean) => {
    sendingRef.current = next;
    setSending(next);
  }, []);
  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  const pendingPushSyncRef = useRef<{ catchUp: boolean } | null>(null);
  const deferDesktopSync = useCallback((catchUp: boolean) => {
    pendingPushSyncRef.current = mergeDeferredDesktopSyncIntent(
      pendingPushSyncRef.current,
      catchUp,
    );
  }, []);

  const persistSyncState = useCallback(
    (state: { conversationId?: string | null; cursor?: string | null }) => {
      const conversationId = state.conversationId?.trim() || null;
      const cursor = state.cursor?.trim() || null;
      syncConversationIdRef.current = conversationId;
      setConversationId(conversationId);
      syncCursorRef.current = cursor;
      void saveChatSyncState(threadId, { conversationId, cursor });
    },
    [threadId],
  );

  const acknowledgeDesktopSendIds = useCallback(
    (acceptedIds: Iterable<string>) => {
      const ids = new Set(
        [...acceptedIds].map((id) => id.trim()).filter((id) => id.length > 0),
      );
      if (ids.size === 0) return;
      for (const id of ids) acceptedDesktopSendIdsRef.current.add(id);
      queueRef.current = queueRef.current.filter(
        (item) =>
          !ids.has(item.clientRequestId) && !ids.has(item.userMessageId),
      );
      void acknowledgeDesktopChatOutbox(threadId, ids).catch(() => {});
    },
    [threadId],
  );

  const desktopAccess = isDesktop ? transport.access : null;
  const desktopDeviceId = desktopAccess?.desktopDeviceId ?? null;

  const [catchingUp, setCatchingUp] = useState(false);
  const catchUpDepthRef = useRef(0);
  const trackCatchUpRun = useCallback((run: Promise<unknown>) => {
    catchUpDepthRef.current += 1;
    setCatchingUp(true);
    void run.finally(() => {
      catchUpDepthRef.current -= 1;
      if (catchUpDepthRef.current === 0) setCatchingUp(false);
    });
  }, []);

  const runDesktopSync = useCallback(
    (options?: {
      catchUp?: boolean;

      duringSend?: boolean;

      trigger?: string;
    }): Promise<DesktopSyncOutcome> => {
      const catchUp = options?.catchUp === true;
      const trigger = options?.trigger ?? "unlabelled";
      if (!desktopAccess) return Promise.resolve({ offline: false });
      const existing = desktopSyncRef.current;
      if (existing) {

        const joinPlan = desktopSyncJoinPlan({
          existingCatchUp: existing.catchUp,
          requestedCatchUp: catchUp,
        });
        if (joinPlan === "share") {
          if (catchUp) trackCatchUpRun(existing.promise);
          return existing.promise;
        }
        const chained = existing.promise.then(() =>
          runDesktopSyncRef.current({ catchUp: true, trigger }),
        );
        trackCatchUpRun(chained);
        return chained;
      }

      if (
        !shouldStartDesktopSyncRun({
          sending: sendingRef.current,
          duringSend: options?.duringSend === true,
        })
      ) {
        deferDesktopSync(catchUp);
        recordSyncDiagnostic({
          at: Date.now(),
          trigger,
          catchUp,
          sinceCursor: syncCursorRef.current,
          fullWindow: false,
          outcome: "deferred",
        });
        return Promise.resolve({ offline: false, deferred: true });
      }

      const generation = syncGenerationRef.current;
      let run: Promise<DesktopSyncOutcome> = Promise.resolve({
        offline: false,
      });
      run = (async (): Promise<DesktopSyncOutcome> => {
        const startedAt = Date.now();
        let plan = { sinceCursor: null as string | null, fullWindow: true };
        try {

          const pendingReconcile = pendingReconcileRef.current;
          if (pendingReconcile) await pendingReconcile;
          const expectedConversationId = syncConversationIdRef.current;

          plan = desktopSyncPullPlan({
            catchUp,
            expectedConversationId,
            cursor: syncCursorRef.current,
          });
          const next = await syncDesktopBridgeChatMessages({
            access: desktopAccess,
            expectedConversationId,
            sinceCursor: plan.sinceCursor,
            maxMessages: HISTORY_MESSAGE_LIMIT,
          });
          if (generation !== syncGenerationRef.current) {
            recordSyncDiagnostic({
              at: Date.now(),
              trigger,
              catchUp,
              sinceCursor: plan.sinceCursor,
              fullWindow: plan.fullWindow,
              outcome: "stale-generation",
              durationMs: Date.now() - startedAt,
            });
            return { offline: false };
          }
          persistSyncState({
            conversationId: next.conversationId,
            cursor: next.cursor,
          });
          closeDesktopBridgeSendBatch(desktopSendBatchRef.current);
          desktopSendBatchRef.current = next.preparedSend;
          const acceptedUserMessageIds = next.messages
            .filter((message) => message.role === "user")
            .map((message) => message.id);
          acknowledgeDesktopSendIds(acceptedUserMessageIds);
          setMessages((current) => mergeMessagesById(current, next.messages));
          if (!sendingRef.current && queueRef.current.length > 0) {
            queueMicrotask(() => drainQueueRef.current?.());
          }
          recordSyncDiagnostic({
            at: Date.now(),
            trigger,
            catchUp,
            sinceCursor: plan.sinceCursor,
            fullWindow: plan.fullWindow,
            outcome: "ok",
            rows: next.messages.length,
            cursorOut: next.cursor,
            conversationChanged: next.conversationChanged,
            durationMs: Date.now() - startedAt,
          });
          return {
            offline: false,
            rows: next.messages.length,
            acceptedUserMessageIds,
            preparedSend: next.preparedSend,
          };
        } catch (error) {

          const offline = error instanceof DesktopOfflineError;
          const message =
            error instanceof Error ? error.message : String(error);
          recordSyncDiagnostic({
            at: Date.now(),
            trigger,
            catchUp,
            sinceCursor: plan.sinceCursor,
            fullWindow: plan.fullWindow,
            outcome: offline ? "offline" : "error",
            durationMs: Date.now() - startedAt,
            error: message,
          });
          return { offline, error: message };
        } finally {

          if (generation === syncGenerationRef.current) {
            if (desktopSyncRef.current?.promise === run) {
              desktopSyncRef.current = null;
            }
          }
        }
      })();
      desktopSyncRef.current = { promise: run, catchUp };
      if (catchUp) trackCatchUpRun(run);
      return run;
    },
    [
      acknowledgeDesktopSendIds,
      desktopAccess,
      deferDesktopSync,
      persistSyncState,
      trackCatchUpRun,
    ],
  );

  const runDesktopSyncRef = useRef(runDesktopSync);
  useEffect(() => {
    runDesktopSyncRef.current = runDesktopSync;
  }, [runDesktopSync]);

  useEffect(() => {
    didMountSyncRef.current = false;
    desktopSyncRef.current = null;
    pendingReconcileRef.current = null;
    closeDesktopBridgeSendBatch(desktopSendBatchRef.current);
    desktopSendBatchRef.current = null;
    return () => {
      syncGenerationRef.current += 1;
      closeDesktopBridgeSendBatch(desktopSendBatchRef.current);
      desktopSendBatchRef.current = null;
    };
  }, [desktopDeviceId, threadId]);

  useEffect(() => {
    if (!desktopAccess || !appActive) return;
    if (didMountSyncRef.current) return;
    if (!storageLoaded) return;
    didMountSyncRef.current = true;

    void runDesktopSync({ catchUp: true, trigger: "landing" });
  }, [appActive, desktopAccess, runDesktopSync, storageLoaded]);

  const [desktopThreadTasks, setDesktopThreadTasks] = useState<
    MobileTask[] | null
  >(null);
  const [desktopTaskDecoration, setDesktopTaskDecoration] =
    useState<DesktopTaskDecoration | null>(null);

  type ThreadTasksFetchState = {
    scopeKey: string;
    inFlight: boolean;
    queued: boolean;
  };
  const threadTasksScopeKey = `${desktopDeviceId ?? ""}\u0000${threadId}`;
  const threadTasksFetchRef = useRef<ThreadTasksFetchState>({
    scopeKey: threadTasksScopeKey,
    inFlight: false,
    queued: false,
  });

  if (threadTasksFetchRef.current.scopeKey !== threadTasksScopeKey) {
    threadTasksFetchRef.current = {
      scopeKey: threadTasksScopeKey,
      inFlight: false,
      queued: false,
    };
  }
  const refreshDesktopThreadTasks = useCallback(async () => {
    if (!desktopAccess) return;
    const state = threadTasksFetchRef.current;
    if (state.scopeKey !== threadTasksScopeKey) return;
    if (state.inFlight) {
      state.queued = true;
      return;
    }
    state.inFlight = true;
    try {
      do {
        state.queued = false;
        const conversationId = syncConversationIdRef.current;
        if (!conversationId) return;
        const tasks = await fetchDesktopBridgeThreadTasks(
          desktopAccess,
          conversationId,
        );

        if (threadTasksFetchRef.current !== state) return;
        if (tasks) setDesktopThreadTasks(tasks);
      } while (state.queued);
    } finally {
      state.inFlight = false;
    }
  }, [desktopAccess, threadTasksScopeKey]);

  useEffect(() => {
    setDesktopThreadTasks(null);
    setDesktopTaskDecoration(null);
  }, [desktopDeviceId, threadId]);

  useEffect(() => {
    if (!desktopAccess || !storageLoaded || !appActive) return;
    void refreshDesktopThreadTasks();
  }, [appActive, desktopAccess, refreshDesktopThreadTasks, storageLoaded]);

  const [livePushConnected, setLivePushConnected] = useState(false);
  const storageLoadedRef = useRef(storageLoaded);
  useEffect(() => {
    storageLoadedRef.current = storageLoaded;
  }, [storageLoaded]);

  useEffect(() => {
    if (!desktopAccess) return;
    let pushDebounce: ReturnType<typeof setTimeout> | null = null;
    const seenPushEventIds = new Set<string>();
    const handle = openDesktopBridgeLive({
      access: desktopAccess,
      onLocalChatUpdated: (payload) => {
        const disposition = consumeDesktopLocalChatPush({
          activeConversationId: syncConversationIdRef.current,
          payloadConversationId: payload.conversationId,
          eventId: payload.event?._id,
          seenEventIds: seenPushEventIds,
        });
        if (disposition !== "sync") return;
        if (!shouldScheduleDesktopTranscriptSyncForPush(payload.event?.type)) {
          return;
        }
        const gates = {
          storageLoaded: storageLoadedRef.current,
          sending: sendingRef.current,
        };
        if (!shouldSyncOnLocalChatPush(gates)) {
          if (shouldDeferLocalChatPushDuringSend(gates)) {
            deferDesktopSync(false);
          }
          return;
        }

        if (pushDebounce) clearTimeout(pushDebounce);
        pushDebounce = setTimeout(() => {
          pushDebounce = null;
          if (sendingRef.current) {

            deferDesktopSync(false);
            return;
          }
          void runDesktopSync({ trigger: "push" });
        }, 400);
      },

      onThreadActivityUpdated: (payload) => {
        const current = syncConversationIdRef.current;
        if (
          payload.conversationId &&
          current &&
          payload.conversationId !== current
        ) {
          return;
        }
        void refreshDesktopThreadTasks();
      },

      onTaskDecorationUpdated: setDesktopTaskDecoration,
      onConnectedChange: (connected, details) => {
        setLivePushConnected(connected);

        if (connected) void refreshDesktopThreadTasks();

        if (connected && storageLoadedRef.current) {
          void runDesktopSync(desktopLiveConnectionSyncPlan(details));
        }
      },
    });
    return () => {
      if (pushDebounce) clearTimeout(pushDebounce);
      handle.close();
      setLivePushConnected(false);
    };
  }, [
    deferDesktopSync,
    desktopAccess,
    refreshDesktopThreadTasks,
    runDesktopSync,
  ]);

  useEffect(() => {
    if (!appActive) return;
    if (sending) return;
    if (!storageLoaded) return;
    if (!pendingPushSyncRef.current) return;

    let cancelled = false;
    void (async () => {
      const pendingReconcile = pendingReconcileRef.current;
      if (pendingReconcile) await pendingReconcile;
      if (cancelled) return;

      const pending = pendingPushSyncRef.current;
      if (!pending) return;
      pendingPushSyncRef.current = null;
      await runDesktopSync({
        catchUp: pending.catchUp,
        trigger: pending.catchUp
          ? "post-send-catch-up-flush"
          : "post-send-flush",
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [appActive, sending, storageLoaded, runDesktopSync]);

  const appendAssistantSegment = useCallback(
    (replyId: string, segment: string) => {
      if (!segment) return;
      setMessages((m) =>
        m.map((msg) => {
          if (msg.id !== replyId) return msg;
          const text = msg.text
            ? `${msg.text.replace(/\s+$/, "")}\n\n${segment}`
            : segment;
          return { ...msg, text };
        }),
      );
    },
    [],
  );

  const finishDispatch = useCallback(() => {
    const settle = async () => {

      while (steerPumpPromiseRef.current) {
        await steerPumpPromiseRef.current;
      }
      activeDispatchRef.current = null;
      markSending(false);
      setWorkingActivity(IDLE_WORKING_ACTIVITY);
      if (queueRef.current.length > 0 && appActive) {
        drainQueueRef.current?.();
      } else {
        closeDesktopBridgeSendBatch(desktopSendBatchRef.current);
        desktopSendBatchRef.current = null;
      }
    };
    void settle();
  }, [appActive, markSending]);

  const pumpDesktopSteers = useCallback(() => {
    if (!desktopAccess || steerPumpPromiseRef.current) return;
    const active = activeDispatchRef.current;
    const batch = desktopSendBatchRef.current;
    if (
      !active ||
      !active.primaryAccepted ||
      active.abort.signal.aborted ||
      !batch ||
      batch.closed ||
      queueRef.current.length === 0
    ) {
      return;
    }

    const pumpGeneration = steerPumpGenerationRef.current;
    const dispatchGeneration = active.generation;
    let pumpOutcome: "drained" | "blocked" | "stopped" | null = null;
    const pump = (async () => {
      const canContinue = () => {
        const currentActive = activeDispatchRef.current;
        return (
          steerPumpGenerationRef.current === pumpGeneration &&
          currentActive?.generation === dispatchGeneration &&
          !currentActive.abort.signal.aborted
        );
      };
      pumpOutcome = await drainDesktopSteerAcceptanceQueue({
        peek: () => queueRef.current[0] ?? null,
        accept: async (item) => {
          const bridgeAttachments = await assetsToBridgeAttachments(
            item.assets,
          );
          return sendDesktopBridgeSteer({
            access: desktopAccess,
            batch,
            request: {
              message: item.text,
              clientRequestId: item.clientRequestId,
              userMessageEventId: item.userMessageId,
              attachments:
                bridgeAttachments.length > 0 ? bridgeAttachments : undefined,
            },
          });
        },
        onAccepted: (item, receipt) => {
          if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
          acknowledgeDesktopSendIds([
            item.clientRequestId,
            item.userMessageId,
            receipt.userMessageId,
          ]);
          setMessages((current) =>
            current.map((message) =>
              message.id === item.userMessageId
                ? {
                    ...message,
                    queued: false,
                    ...(receipt.userMessageId !== item.userMessageId
                      ? { canonicalId: receipt.userMessageId }
                      : {}),
                  }
                : message,
            ),
          );
        },
        canContinue,
      });
      return pumpOutcome;
    })().finally(() => {
      if (steerPumpPromiseRef.current === pump) {
        steerPumpPromiseRef.current = null;
        if (
          queueRef.current.length > 0 &&
          activeDispatchRef.current?.primaryAccepted &&

          pumpOutcome === "drained"
        ) {
          queueMicrotask(() => pumpDesktopSteersRef.current?.());
        }
      }
    });
    steerPumpPromiseRef.current = pump;
  }, [acknowledgeDesktopSendIds, desktopAccess]);

  useEffect(() => {
    pumpDesktopSteersRef.current = pumpDesktopSteers;
  }, [pumpDesktopSteers]);

  const flushPersistNow = useCallback(() => {
    setMessages((current) => {
      void saveChatMessages(threadId, current).catch(() => {});
      if (threadId === "cloud") void indexMessages(current);
      return current;
    });
  }, [threadId]);

  const dispatchCloud = useCallback(
    async (item: QueuedSend, replyId: string, abort: AbortController) => {
      const guest = transport.kind === "cloud" ? transport.guest : false;

      const toolsEnabled = threadId === "cloud" && transport.kind === "cloud";
      const queuedIds = new Set(queueRef.current.map((q) => q.userMessageId));
      const priorMessages = messagesRef.current.filter(
        (m) =>
          m.id !== item.userMessageId &&
          m.id !== replyId &&
          !queuedIds.has(m.id) &&
          !m.queued,
      );
      const baseHistory = priorMessages
        .map((m) => ({ role: m.role, text: m.text }))
        .filter((m) => m.text.trim().length > 0);

      let imagesPayload: OfflineChatImagePayload[];
      try {
        imagesPayload = await prepareOfflineChatImages(item.assets);
      } catch (error) {
        setMessages((messages) =>
          messages.map((message) =>
            message.id === replyId
              ? { ...message, text: userFacingError(error) }
              : message,
          ),
        );
        acknowledgeDesktopSendIds([item.dispatchId, item.userMessageId]);
        activeDispatchRef.current = null;
        finishDispatch();
        flushPersistNow();
        return;
      }

      const ensureFallbackReply = () => {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId && !msg.text
              ? { ...msg, text: "No reply came back. Try again." }
              : msg,
          ),
        );
      };

      const streamFn = guest ? postStreamAnonymous : postStream;
      const streamOptions = {
        signal: abort.signal,
        ...(guest
          ? {
              headers: {
                "X-Stella-Mobile-Device-Id": await getOrCreateMobileDeviceId(),
              },
            }
          : {}),
      };

      const complete = async (
        prompt: string,
        history: { role: ChatMessage["role"]; text: string }[],
      ): Promise<string> => {
        let acc = "";
        await streamFn(
          OFFLINE_CHAT_STREAM_PATH,
          buildOfflineChatRequest({ message: prompt, history, images: [] }),
          (delta) => {
            acc += delta;
          },
          streamOptions,
        );
        return acc;
      };

      type ToolExecutionResult = { text: string; isError: boolean };
      const upsertToolStep = (
        step: NonNullable<ChatMessage["toolSteps"]>[number],
      ) => {
        setMessages((current) =>
          current.map((message) => {
            if (message.id !== replyId) return message;
            const steps = message.toolSteps ?? [];
            const index = steps.findIndex(
              (candidate) => candidate.id === step.id,
            );
            return {
              ...message,
              toolSteps:
                index === -1
                  ? [...steps, step]
                  : steps.map((candidate, stepIndex) =>
                      stepIndex === index ? step : candidate,
                    ),
            };
          }),
        );
      };
      const removeToolStep = (toolCallId: string) => {
        setMessages((current) =>
          current.map((message) =>
            message.id === replyId
              ? {
                  ...message,
                  toolSteps: (message.toolSteps ?? []).filter(
                    (step) => step.id !== toolCallId,
                  ),
                }
              : message,
          ),
        );
      };
      const upsertArtifact = (artifact: ChatArtifact) => {
        setMessages((current) =>
          current.map((message) => {
            if (message.id !== replyId) return message;
            const artifacts = message.artifacts ?? [];
            const index = artifacts.findIndex(
              (candidate) => candidate.id === artifact.id,
            );
            return {
              ...message,
              artifacts:
                index === -1
                  ? [...artifacts, artifact]
                  : artifacts.map((candidate, artifactIndex) =>
                      artifactIndex === index ? artifact : candidate,
                    ),
            };
          }),
        );
      };

      const applyMapTool = async (
        call: {
          places?: string[];
          origin?: string;
          destination?: string;
          mode?: string;
          title?: string;
        },
        toolCallId: string,
        textOffset: number,
      ): Promise<ToolExecutionResult> => {
        const outcome = await resolveMap(call);
        if (!outcome.ok) {
          upsertToolStep({
            id: toolCallId,
            toolName: "map",
            status: "error",
            args: { title: call.title ?? "Map" },
            textOffset,
          });
          return { text: outcome.error, isError: true };
        }
        const artifact = mapArtifactFor(
          outcome.result.payload,
          OFFLINE_ARTIFACT_CONVERSATION_ID,
          0,
        );
        removeToolStep(toolCallId);
        upsertArtifact({ ...artifact, id: toolCallId, textOffset });
        return {
          text: `Displayed the map${call.title ? `: ${call.title}` : ""}.`,
          isError: false,
        };
      };

      const applyPdfTool = async (
        call: {
          title?: string;
          content: string;
          filename?: string;
        },
        toolCallId: string,
        textOffset: number,
      ): Promise<ToolExecutionResult> => {
        const outcome = await generatePdf(call);
        if (!outcome.ok) {
          upsertToolStep({
            id: toolCallId,
            toolName: "pdf",
            status: "error",
            args: { title: call.title ?? "PDF" },
            textOffset,
          });
          return { text: outcome.error, isError: true };
        }
        const artifact = pdfArtifactFor(
          {
            ...outcome.result.payload,
            textOffset,
            toolCallId,
          },
          OFFLINE_ARTIFACT_CONVERSATION_ID,
        );
        removeToolStep(toolCallId);
        upsertArtifact({ ...artifact, id: toolCallId, textOffset });
        return {
          text: `Created and attached the PDF${call.title ? `: ${call.title}` : ""}.`,
          isError: false,
        };
      };

      const applyImageTool = async (
        call: { prompt: string; aspectRatio?: string; numImages?: number },
        toolCallId: string,
        textOffset: number,
      ): Promise<ToolExecutionResult> => {
        const createdAt = Date.now();
        const imagePayload: Extract<
          ChatArtifact["payload"],
          { kind: "media" }
        > = {
          kind: "media",
          asset: { kind: "image", filePaths: [] },
          createdAt,
          prompt: call.prompt,
          presentation: "inline-image",
          aspectRatio: call.aspectRatio,
          numImages: call.numImages ?? 1,
          toolCallId,
          generationState: "running",
          textOffset,
        };
        const artifact: ChatArtifact = {
          id: toolCallId,
          conversationId: OFFLINE_ARTIFACT_CONVERSATION_ID,
          textOffset,
          payload: imagePayload,
        };
        upsertArtifact(artifact);
        try {
          const result = await generateChatImage(call, {
            toolCallId,
            signal: abort.signal,
          });
          upsertArtifact({
            ...artifact,
            payload: {
              ...imagePayload,
              asset: { kind: "image", filePaths: result.filePaths },
              generationState: "completed",
            },
          });
          return {
            text: `Generated ${result.filePaths.length || call.numImages || 1} image${
              (result.filePaths.length || call.numImages || 1) === 1 ? "" : "s"
            } and displayed the result.`,
            isError: false,
          };
        } catch (error) {
          const canceled =
            abort.signal.aborted ||
            (error instanceof Error && error.name === "AbortError") ||
            (error as { status?: unknown }).status === "canceled";
          upsertArtifact({
            ...artifact,
            payload: {
              ...imagePayload,
              generationState: canceled ? "canceled" : "failed",
            },
          });
          return {
            text: canceled
              ? "Image generation was canceled."
              : `Image generation failed: ${userFacingError(error)}`,
            isError: true,
          };
        }
      };

      try {
        if (!toolsEnabled) {

          await streamFn(
            OFFLINE_CHAT_STREAM_PATH,
            buildOfflineChatRequest({
              message: item.text,
              history: baseHistory,
              images: imagesPayload,
            }),
            (segment) => {
              appendAssistantSegment(replyId, segment);
              if (/\S/.test(segment)) patchActivity({ answerLanded: true });
            },
            streamOptions,
          );
          ensureFallbackReply();
          notifySuccess();
          return;
        }

        const [memoryFacts, existingCheckpoint] = await Promise.all([
          loadMemoryFacts(),
          loadCheckpoint(),
        ]);
        let checkpoint = existingCheckpoint;
        try {
          const updated = await runCompaction({
            messages: priorMessages,
            checkpoint,
            summarize: (prompt) => complete(prompt, []),
          });
          if (updated) checkpoint = updated;
        } catch {

        }
        const context = buildCompactedContext(priorMessages, checkpoint);
        const mobileModelContext = buildMobileModelContext({
          memoryFacts,
          summary: context.summary,
        });
        const toolMessages: OfflineChatToolMessage[] = [];
        let toolTimelineOffset = 0;
        for (let round = 0; round <= MAX_OFFLINE_TOOL_ROUNDS; round += 1) {
          const allowTools = round < MAX_OFFLINE_TOOL_ROUNDS;
          const nativeCalls: MobileChatStreamToolCall[] = [];
          let roundText = "";
          let roundVisibleChars = 0;
          await streamFn(
            OFFLINE_CHAT_STREAM_PATH,
            buildOfflineChatRequest({
              message: item.text,
              history: context.history,
              images: imagesPayload,
              context: mobileModelContext,
              enableTools: allowTools,
              toolMessages,
            }),
            (segment) => {
              roundText += segment;
              roundVisibleChars += segment.length;
              appendAssistantSegment(replyId, segment);
              if (/\S/.test(segment)) patchActivity({ answerLanded: true });
            },
            {
              ...streamOptions,
              ...(allowTools
                ? {
                    onToolCall: (toolCall: MobileChatStreamToolCall) => {
                      nativeCalls.push(toolCall);
                    },
                  }
                : {}),
            },
          );
          const textOffset = toolTimelineOffset + roundVisibleChars;
          toolTimelineOffset = textOffset;

          if (nativeCalls.length === 0) break;

          patchActivity({ answerLanded: false });

          toolMessages.push({
            role: "assistant",
            text: roundText,
            toolCalls: nativeCalls,
            ...(nativeCalls[0]?.source
              ? { source: nativeCalls[0].source }
              : {}),
          });

          const indexedCalls = nativeCalls.map((nativeCall, index) => ({
            nativeCall,
            call: normalizeMobileToolCall(nativeCall),
            toolCallId: `${replyId}:tool:${round}:${index}`,
          }));

          for (const { call, nativeCall, toolCallId } of indexedCalls) {
            if (!call) {
              upsertToolStep({
                id: toolCallId,
                toolName: nativeCall.name,
                status: "error",
                textOffset,
              });
              continue;
            }
            if (call.tool !== "image_gen") {
              const args: Record<string, string> =
                call.tool === "web"
                  ? call.query
                    ? { query: call.query }
                    : { url: call.url ?? "" }
                  : call.tool === "pdf"
                    ? { title: call.title ?? "PDF" }
                    : call.tool === "recall"
                      ? { query: call.query }
                      : call.tool === "remember"
                        ? { title: call.key }
                        : {};
              upsertToolStep({
                id: toolCallId,
                toolName: call.tool,
                status: "running",
                args,
                textOffset,
              });
            }
          }

          for (const { call, nativeCall, toolCallId } of indexedCalls) {
            let result: ToolExecutionResult;
            if (!call) {
              result = {
                text: `The ${nativeCall.name} tool call had invalid arguments.`,
                isError: true,
              };
            } else if (call.tool === "remember") {
              try {
                await rememberFact(call.key, call.value);
                upsertToolStep({
                  id: toolCallId,
                  toolName: "remember",
                  status: "completed",
                  args: { title: call.key },
                  textOffset,
                });
                result = { text: `Remembered ${call.key}.`, isError: false };
              } catch (error) {
                upsertToolStep({
                  id: toolCallId,
                  toolName: "remember",
                  status: "error",
                  args: { title: call.key },
                  textOffset,
                });
                result = {
                  text: `Could not save that memory: ${userFacingError(error)}`,
                  isError: true,
                };
              }
            } else if (call.tool === "forget") {
              try {
                await forgetFact(call.key);
                upsertToolStep({
                  id: toolCallId,
                  toolName: "forget",
                  status: "completed",
                  textOffset,
                });
                result = { text: `Forgot ${call.key}.`, isError: false };
              } catch (error) {
                upsertToolStep({
                  id: toolCallId,
                  toolName: "forget",
                  status: "error",
                  textOffset,
                });
                result = {
                  text: `Could not remove that memory: ${userFacingError(error)}`,
                  isError: true,
                };
              }
            } else if (call.tool === "map") {
              result = await applyMapTool(call, toolCallId, textOffset);
            } else if (call.tool === "pdf") {
              result = await applyPdfTool(call, toolCallId, textOffset);
            } else if (call.tool === "recall") {
              const excludeIds = new Set([item.userMessageId, replyId]);
              const recallText = formatRecallResults(
                await searchMessages(call.query, { excludeIds }),
                call.query,
              );
              upsertToolStep({
                id: toolCallId,
                toolName: "recall",
                status: "completed",
                args: { query: call.query },
                textOffset,
              });
              result = { text: recallText, isError: false };
            } else if (call.tool === "web") {
              const webArgs = {
                ...(call.query ? { query: call.query } : {}),
                ...(call.url ? { url: call.url } : {}),
                ...(call.category ? { category: call.category } : {}),
                ...(call.prompt ? { prompt: call.prompt } : {}),
                ...(call.format ? { format: call.format } : {}),
              };
              try {
                const webResult = await searchChatWeb(webArgs);
                upsertToolStep({
                  id: toolCallId,
                  toolName: "web",
                  status: "completed",
                  args: webArgs,
                  textOffset,
                });
                result = { text: webResult.text, isError: false };
              } catch (error) {
                upsertToolStep({
                  id: toolCallId,
                  toolName: "web",
                  status: "error",
                  args: webArgs,
                  textOffset,
                });
                result = {
                  text: `Web tool failed: ${userFacingError(error)}`,
                  isError: true,
                };
              }
            } else {
              result = await applyImageTool(call, toolCallId, textOffset);
            }

            toolMessages.push({
              role: "toolResult",
              toolCallId: nativeCall.id,
              toolName: nativeCall.name,
              text: result.text,
              isError: result.isError,
            });
          }
        }

        ensureFallbackReply();
        notifySuccess();
      } catch (e) {
        if (e instanceof StreamAbortError) {
          setMessages((m) =>
            m.map((msg) =>
              msg.id === replyId ? { ...msg, stopped: true } : msg,
            ),
          );
        } else {
          setMessages((m) =>
            m.map((msg) =>
              msg.id === replyId
                ? { ...msg, text: msg.text || userFacingError(e) }
                : msg,
            ),
          );
        }
      } finally {
        acknowledgeDesktopSendIds([item.dispatchId, item.userMessageId]);
        if (activeDispatchRef.current?.replyId === replyId) {
          activeDispatchRef.current = null;
        }
        finishDispatch();

        flushPersistNow();
      }
    },
    [
      appendAssistantSegment,
      acknowledgeDesktopSendIds,
      finishDispatch,
      flushPersistNow,
      patchActivity,
      threadId,
      transport,
    ],
  );

  const dispatchDesktop = useCallback(
    async (
      item: QueuedSend,
      replyId: string,
      abort: AbortController,
      access: StoredPhoneAccess,
    ) => {
      let sawAssistantSegment = false;

      let canonicalUserMessageIdSeen = "";

      try {

        patchActivity({ statusText: WAKE_STATUS_COPY.connecting });
        const reusableBatch = shouldReuseQueuedReplayBatch({
          queueSequence: item.queueSequence,
          batchReady: desktopSendBatchRef.current?.closed === false,
        });
        if (reusableBatch && pendingReconcileRef.current) {
          await pendingReconcileRef.current;
        }
        const synced = reusableBatch
          ? ({ offline: false } satisfies DesktopSyncOutcome)
          : await runDesktopSync({
              duringSend: true,
              trigger: "send",
            });
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          activeDispatchRef.current = null;
          markSending(false);
          return;
        }
        if (synced.offline) {
          throw new DesktopOfflineError();
        }
        if (
          synced.acceptedUserMessageIds?.includes(item.userMessageId) ||
          acceptedDesktopSendIdsRef.current.has(item.userMessageId)
        ) {
          acknowledgeDesktopSendIds([item.clientRequestId, item.userMessageId]);
          activeDispatchRef.current = null;
          setMessages((messages) =>
            messages
              .filter((message) => message.id !== replyId)
              .map((message) =>
                message.id === item.userMessageId
                  ? { ...message, queued: false }
                  : message,
              ),
          );
          finishDispatch();
          return;
        }
        const bridgeAttachments = await assetsToBridgeAttachments(item.assets);
        const result = await sendDesktopBridgeChat({
          access,
          batch: desktopSendBatchRef.current ?? synced.preparedSend,
          message: item.promptText ?? item.text,
          ...(item.selectedText ? { selectedText: item.selectedText } : {}),
          clientRequestId: item.clientRequestId,
          userMessageEventId: item.userMessageId,
          attachments:
            bridgeAttachments.length > 0 ? bridgeAttachments : undefined,
          signal: abort.signal,
          onUserMessageId: (id) => {
            canonicalUserMessageIdSeen = id;
            acknowledgeDesktopSendIds([
              item.clientRequestId,
              item.userMessageId,
              id,
            ]);

            setMessages((m) =>
              linkOptimisticTurnToCanonical(m, {
                userMessageId: item.userMessageId,
                replyId,
                canonicalUserMessageId: id,
              }),
            );
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            const active = activeDispatchRef.current;
            if (active?.replyId === replyId) {
              active.primaryAccepted = true;
              active.latestResponseUserMessageId = id || item.userMessageId;
              pumpDesktopSteersRef.current?.();
            }
          },
          onResponseBoundary: (boundary) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            acknowledgeDesktopSendIds([boundary.userMessageId]);
            const active = activeDispatchRef.current;
            if (active?.replyId === replyId) {
              active.latestResponseUserMessageId = boundary.userMessageId;
            }
            setMessages((current) =>
              retargetOptimisticReplyToUser(current, {
                replyId,
                userMessageId: boundary.userMessageId,
              }),
            );
          },
          onStatus: (status) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;

            patchActivity({ statusText: WAKE_STATUS_COPY[status] });
          },
          onActivity: (activity: DesktopBridgeActivity) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;

            replaceActivity({
              toolName: activity.toolName || undefined,
              toolCallId: activity.toolCallId || undefined,
              statusText: activity.statusText || undefined,
              answerLanded: activity.answerLanded,
              hasToolActivity: activity.hasToolActivity,
            });
          },
          onAssistantSegment: (segment) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            sawAssistantSegment = true;
            appendAssistantSegment(replyId, segment.text);
          },
          onArtifacts: (artifacts) => {
            const stopped = stoppedDispatchIdsRef.current.has(item.dispatchId);
            const hasCanceledImage = artifacts.some(
              (artifact) =>
                artifact.payload.kind === "media" &&
                artifact.payload.asset.kind === "image" &&
                artifact.payload.generationState === "canceled",
            );
            if (stopped && !hasCanceledImage) return;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === replyId ? { ...msg, artifacts } : msg,
              ),
            );
          },
        });
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          activeDispatchRef.current = null;

          setMessages((m) =>
            linkOptimisticTurnToCanonical(m, {
              userMessageId: item.userMessageId,
              replyId,
              canonicalUserMessageId: result.userMessageId,
            }),
          );
          markSending(false);
          return;
        }

        const canonicalUserMessageId = result.userMessageId.trim();
        const responseUserMessageId =
          activeDispatchRef.current?.latestResponseUserMessageId ||
          canonicalUserMessageId ||
          item.userMessageId;
        setMessages((m) => {
          let changed = false;
          const next = m.map((msg) => {
            if (msg.id === replyId) {

              const text = finalizeAssistantTurnText(msg.text, result.text);
              const requestId = canonicalUserMessageId || msg.requestId;
              const artifacts =
                result.artifacts.length > 0 ? result.artifacts : msg.artifacts;
              if (
                text === msg.text &&
                requestId === msg.requestId &&
                artifacts === msg.artifacts
              ) {
                return msg;
              }
              changed = true;
              return {
                ...msg,
                text,
                ...(requestId ? { requestId } : {}),
                ...(artifacts ? { artifacts } : {}),
              };
            }
            if (msg.id === responseUserMessageId && canonicalUserMessageId) {
              if (msg.canonicalId === canonicalUserMessageId) return msg;
              changed = true;
              return { ...msg, canonicalId: canonicalUserMessageId };
            }
            return msg;
          });
          return changed ? next : m;
        });

        const reconcileGeneration = syncGenerationRef.current;
        const deferredSyncAtReconcileStart = pendingPushSyncRef.current;
        const reconcilePromise = syncDesktopBridgeChatMessages({
          access,
          expectedConversationId: syncConversationIdRef.current,
          sinceCursor: syncConversationIdRef.current
            ? syncCursorRef.current
            : null,
          maxMessages: HISTORY_MESSAGE_LIMIT,
        })
          .then((delta) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            if (reconcileGeneration !== syncGenerationRef.current) return;
            persistSyncState({
              conversationId: delta.conversationId,
              cursor: delta.cursor,
            });

            if (
              deferredSyncAtReconcileStart &&
              !deferredSyncAtReconcileStart.catchUp &&
              pendingPushSyncRef.current === deferredSyncAtReconcileStart
            ) {
              pendingPushSyncRef.current = null;
            }
            const hasCanonicalAssistant = delta.messages.some(
              (message) => message.role === "assistant",
            );
            if (!hasCanonicalAssistant) return;
            setMessages((m) =>
              responseUserMessageId === item.userMessageId
                ? reconcileSentDesktopTurn({
                    current: m,
                    userMessageId: item.userMessageId,
                    replyId,
                    sentText: item.promptText ?? item.text,
                    canonicalMessages: delta.messages,
                    ...(canonicalUserMessageId
                      ? { canonicalUserMessageId }
                      : {}),
                  })
                : mergeMessagesById(m, delta.messages),
            );
          })
          .catch(() => {

          });

        pendingReconcileRef.current = reconcilePromise;
        void reconcilePromise.finally(() => {
          if (pendingReconcileRef.current === reconcilePromise) {
            pendingReconcileRef.current = null;
          }
        });
        notifySuccess();
        finishDispatch();
      } catch (e) {
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          activeDispatchRef.current = null;

          setMessages((m) =>
            linkOptimisticTurnToCanonical(m, {
              userMessageId: item.userMessageId,
              replyId,
              canonicalUserMessageId: canonicalUserMessageIdSeen,
            }),
          );
          markSending(false);
          return;
        }

        const message =
          e instanceof DesktopOfflineError && !sawAssistantSegment
            ? "Your computer is offline. Wake it from the menu, then try again."
            : userFacingError(e);

        const linkId = canonicalUserMessageIdSeen.trim();
        setMessages((m) =>
          linkId
            ? m.map((msg) => {
                if (msg.id === replyId) {
                  return {
                    ...msg,
                    text: msg.text || message,
                    requestId: linkId,
                  };
                }
                if (msg.id === item.userMessageId) {
                  return { ...msg, canonicalId: linkId };
                }
                return msg;
              })
            : m
                .filter((msg) => msg.id !== replyId)
                .map((msg) =>
                  msg.id === item.userMessageId
                    ? { ...msg, queued: true }
                    : msg,
                ),
        );
        if (linkId) {
          finishDispatch();
        } else {

          if (
            !queueRef.current.some(
              (queued) => queued.clientRequestId === item.clientRequestId,
            )
          ) {
            queueRef.current.push(item);
            queueRef.current.sort(
              (a, b) =>
                (a.queueSequence ?? Number.MAX_SAFE_INTEGER) -
                (b.queueSequence ?? Number.MAX_SAFE_INTEGER),
            );
          }
          markSending(false);
          setWorkingActivity(IDLE_WORKING_ACTIVITY);
          closeDesktopBridgeSendBatch(desktopSendBatchRef.current);
          desktopSendBatchRef.current = null;
        }
      }
    },
    [
      appendAssistantSegment,
      acknowledgeDesktopSendIds,
      finishDispatch,
      markSending,
      patchActivity,
      replaceActivity,
      persistSyncState,
      runDesktopSync,
    ],
  );

  const dispatch = useCallback(
    async (item: QueuedSend) => {
      const replyId = createId();
      const abort = new AbortController();
      dispatchGenerationRef.current += 1;
      activeDispatchRef.current = {
        dispatchId: item.dispatchId,
        userMessageId: item.userMessageId,
        replyId,
        abort,
        generation: dispatchGenerationRef.current,
        primaryAccepted: false,
        latestResponseUserMessageId: item.userMessageId,
      };

      setWorkingActivity(IDLE_WORKING_ACTIVITY);

      const dispatchedAt = Date.now();
      setMessages((m) => [
        ...m.map((msg) => {
          if (msg.id !== item.userMessageId) return msg;

          return msg.queued
            ? { ...msg, queued: false, createdAt: dispatchedAt }
            : { ...msg, queued: false };
        }),
        {
          id: replyId,
          role: "assistant" as const,
          requestId: item.userMessageId,
          text: "",
          createdAt: dispatchedAt,
        },
      ]);

      if (transport.kind === "desktop") {
        await dispatchDesktop(item, replyId, abort, transport.access);
      } else {
        await dispatchCloud(item, replyId, abort);
      }
    },
    [dispatchCloud, dispatchDesktop, transport],
  );

  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  const drainQueue = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) return;
    markSending(true);
    void dispatchRef.current?.(next);
  }, [markSending]);

  useEffect(() => {
    drainQueueRef.current = drainQueue;
  }, [drainQueue]);

  const submit = useCallback(
    (suppliedPrompt?: string): { userMessageId: string } | null => {

      if (!storageLoaded) return null;
      const supplied = suppliedPrompt !== undefined;
      const typed = (suppliedPrompt ?? draft).trim();

      const pendingQuotes = supplied ? [] : quotes;

      const text = composeQuotedText(pendingQuotes, typed);
      const decoupleQuotes = typed.length > 0 && pendingQuotes.length > 0;
      const rawQuotes = decoupleQuotes ? composeRawQuotes(pendingQuotes) : "";
      const promptText = decoupleQuotes ? typed : text;
      const assets = supplied ? [] : attachments.slice();
      if (!text && assets.length === 0) return null;

      if (!hasAiConsent()) {
        requestAiConsent();
        return null;
      }

      if (!supplied) {
        setDraft("");
        setAttachments([]);
        setQuotes([]);
      }

      const admission = admitSend(sendingRef);

      const userMessageId = createId();
      const displayText = promptText || (assets.length ? "Photo" : "");
      const quotedPreview = rawQuotes
        ? rawQuotes.slice(0, QUOTED_TEXT_PREVIEW_MAX_CHARS)
        : undefined;
      const thumbs = assets.slice(0, 3).map((a) => a.uri);
      const createdAt = Date.now();
      const userMsg: ChatMessage = {
        id: userMessageId,
        role: "user",
        text: displayText,
        createdAt,
        hasImage: assets.length > 0,
        ...(thumbs.length > 0 ? { thumbnailUris: thumbs } : {}),
        ...(quotedPreview ? { quotedText: quotedPreview } : {}),
        ...(admission === "queue" ? { queued: true } : {}),
      };

      LayoutAnimation.configureNext({
        duration: 350,
        update: { type: LayoutAnimation.Types.spring, springDamping: 1 },
      });
      setMessages((m) => [...m, userMsg]);

      const item: QueuedSend = {
        dispatchId: userMessageId,
        clientRequestId: userMessageId,
        userMessageId,
        text,
        ...(decoupleQuotes ? { promptText, selectedText: rawQuotes } : {}),
        assets,
      };
      pendingEnqueueRef.current.add(userMessageId);
      if (admission === "dispatch") markSending(true);
      const durableRecord: Omit<DesktopChatOutboxRecord, "sequence"> = {
        sendId: userMessageId,
        userMessageId,
        text,
        displayText,
        createdAt,
        assets,
      };

      void enqueueDesktopChatOutbox(threadId, durableRecord)
        .then((stored) => {
          pendingEnqueueRef.current.delete(userMessageId);
          item.queueSequence = stored.sequence;
          if (
            acceptedDesktopSendIdsRef.current.has(item.userMessageId) ||
            stoppedDispatchIdsRef.current.has(item.dispatchId)
          ) {
            acknowledgeDesktopSendIds([
              item.clientRequestId,
              item.userMessageId,
            ]);
            return;
          }
          if (admission === "queue") {
            queueRef.current.push(item);
            queueRef.current.sort(
              (a, b) =>
                (a.queueSequence ?? Number.MAX_SAFE_INTEGER) -
                (b.queueSequence ?? Number.MAX_SAFE_INTEGER),
            );
            if (transport.kind === "desktop" && sendingRef.current) {
              pumpDesktopSteersRef.current?.();
            } else if (!sendingRef.current) {
              drainQueueRef.current?.();
            }
            return;
          }
          void dispatch(item);
        })
        .catch(() => {
          pendingEnqueueRef.current.delete(userMessageId);
          if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
          if (admission === "dispatch") markSending(false);
          setMessages((current) =>
            current.map((message) =>
              message.id === userMessageId
                ? { ...message, queued: true }
                : message,
            ),
          );
        });
      return { userMessageId };
    },
    [
      acknowledgeDesktopSendIds,
      attachments,
      dispatch,
      draft,
      quotes,
      markSending,
      storageLoaded,
      threadId,
      transport.kind,
    ],
  );

  const send = useCallback(() => submit(), [submit]);
  const sendPrompt = useCallback((prompt: string) => submit(prompt), [submit]);

  const stop = useCallback(() => {

    steerPumpGenerationRef.current += 1;
    const cancelledIds = [
      ...new Set([
        ...queueRef.current.map((q) => q.userMessageId),
        ...pendingEnqueueRef.current,
      ]),
    ];
    for (const id of cancelledIds) stoppedDispatchIdsRef.current.add(id);
    pendingEnqueueRef.current.clear();
    queueRef.current = [];
    if (cancelledIds.length > 0) {
      acknowledgeDesktopSendIds(cancelledIds);
    }
    if (cancelledIds.length > 0) {

      setMessages((m) =>
        m.map((msg) =>
          cancelledIds.includes(msg.id)
            ? { ...msg, queued: false, stopped: true }
            : msg,
        ),
      );
    }
    if (activeDispatchRef.current) {
      const active = activeDispatchRef.current;
      stoppedDispatchIdsRef.current.add(active.dispatchId);
      acknowledgeDesktopSendIds([active.dispatchId, active.userMessageId]);
      active.abort.abort();
      setMessages((m) =>
        m.map((msg) =>
          msg.id === active.replyId ? { ...msg, stopped: true } : msg,
        ),
      );
      activeDispatchRef.current = null;
    }
    closeDesktopBridgeSendBatch(desktopSendBatchRef.current);
    desktopSendBatchRef.current = null;
    markSending(false);
    setWorkingActivity(IDLE_WORKING_ACTIVITY);
  }, [acknowledgeDesktopSendIds, markSending]);

  const rewindToMessage = useCallback(
    (messageId: string) => {
      if (transport.kind !== "cloud") return;
      if (!storageLoaded) return;

      if (sendingRef.current) return;
      const current = messagesRef.current;
      const index = current.findIndex((m) => m.id === messageId);
      if (index < 0) return;
      const target = current[index];
      if (target.role !== "user") return;
      LayoutAnimation.configureNext({
        duration: 250,
        update: { type: LayoutAnimation.Types.easeInEaseOut },
      });

      setMessages(current.slice(0, index));

      const restoredText =
        target.hasImage && target.text === "Photo" ? "" : target.text;
      setDraft(restoredText);
      setAttachments([]);
      setQuotes([]);
      void restoreRewoundAttachments(target).then((assets) => {
        if (assets.length > 0) setAttachments(assets);
      });
    },
    [storageLoaded, transport.kind],
  );

  const workingIndicator = useMemo(
    () => buildWorkingIndicatorState({ sending, activity: workingActivity }),
    [sending, workingActivity],
  );

  const conversationArtifacts = useMemo(() => {
    return collectActivityHubArtifacts(messages);
  }, [messages]);

  const conversationTasks = useMemo(() => {
    return overlayDesktopThreadTasks(
      collectConversationTasks(messages),
      desktopThreadTasks,
      desktopTaskDecoration,
    );
  }, [desktopTaskDecoration, desktopThreadTasks, messages]);

  const displayMessages = useMemo(
    () => applyLiveAgentWorkState(messages, conversationTasks),
    [conversationTasks, messages],
  );

  const activityArtifactGroups = useMemo(
    () => groupActivityArtifacts(messages, conversationArtifacts),
    [conversationArtifacts, messages],
  );

  const hasRunningConversationTask = conversationTasks.some(
    (task) => task.status === "running",
  );

  useEffect(() => {

    if (
      !shouldArmDesktopTaskPoll({
        isDesktopTransport: Boolean(desktopAccess),
        storageLoaded,
        hasRunningConversationTask,
        sending,
        appActive,
      })
    ) {
      return;
    }
    const handle = setInterval(() => {
      void runDesktopSync({ trigger: "task-poll" });
    }, desktopTaskPollIntervalMs(livePushConnected));
    return () => clearInterval(handle);
  }, [
    desktopAccess,
    appActive,
    hasRunningConversationTask,
    livePushConnected,
    runDesktopSync,
    sending,
    storageLoaded,
  ]);

  return {
    conversationId,
    messages: displayMessages,
    draft,
    setDraft,
    attachments,
    setAttachments,
    quotes,
    addQuote,
    removeQuote,
    sending,
    workingIndicator,
    storageLoaded,
    conversationArtifacts,
    conversationTasks,
    activityArtifactsByTaskId: activityArtifactGroups.byTaskId,
    conversationOwnedArtifacts: activityArtifactGroups.conversation,
    send,
    sendPrompt,
    stop,
    rewindToMessage,
    runDesktopSync,
    catchingUp,
    livePushConnected,
  };
}
