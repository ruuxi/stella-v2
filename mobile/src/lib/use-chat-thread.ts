import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutAnimation } from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  loadChatMessages,
  saveChatMessages,
  loadChatSyncState,
  saveChatSyncState,
  type ChatThreadId,
} from "./offline-chat-storage";
import { postStream, postStreamAnonymous, StreamAbortError } from "./http";
import { hasAiConsent, requestAiConsent } from "./ai-consent";
import { getOrCreateMobileDeviceId, type StoredPhoneAccess } from "./phone-access";
import {
  DesktopOfflineError,
  sendDesktopBridgeChat,
  syncDesktopBridgeChatMessages,
  type DesktopBridgeActivity,
  type DesktopBridgeAttachment,
  type DesktopBridgeSendStatus,
} from "./desktop-bridge-chat";
import {
  buildWorkingIndicatorState,
  IDLE_WORKING_ACTIVITY,
  type WorkingActivity,
  type WorkingIndicatorState,
} from "../components/working-indicator-state";
import {
  collapseLinkedDuplicates,
  mergeMessagesById,
  reconcileSentDesktopTurn,
} from "./chat-merge";
import { openDesktopBridgeLive } from "./desktop-bridge-live";
import {
  desktopSyncPullPlan,
  desktopTaskPollIntervalMs,
  shouldArmDesktopTaskPoll,
  shouldDeferLocalChatPushDuringSend,
  shouldStartDesktopSyncRun,
  shouldSyncOnLocalChatPush,
} from "./desktop-sync-policy";
import { recordSyncDiagnostic } from "./sync-diagnostics";
import {
  agentWorkCardSections,
  isAgentWorkArtifact,
  isNoiseFileArtifact,
} from "./agent-artifact-consolidation";
import { collectConversationTasks } from "./mobile-task-merge";
import { toSendableImage } from "./image-attachments";
import { admitSend } from "./send-admission";
import { createStreamTextSmoother } from "./stream-text-smoother";
import { userFacingError } from "./user-facing-error";
import { notifySuccess } from "./haptics";
import { loadMemoryFacts, rememberFact, forgetFact } from "./chat-memory";
import {
  loadCheckpoint,
  runCompaction,
  buildCompactedContext,
} from "./chat-compaction";
import {
  buildToolPreamble,
  createToolBlockFilter,
  parseToolBlock,
} from "./chat-tools";
import { formatRecallResults } from "./chat-recall";
import {
  initMessageIndex,
  indexMessages,
  searchMessages,
} from "./chat-message-index";
import { resolveMap, mapArtifactFor } from "./chat-maps";
import type { ChatArtifact, ChatMessage, MobileTask } from "../types";

/** What a `runDesktopSync` call actually did, so callers can be honest. */
export type DesktopSyncOutcome = {
  /** The desktop was confirmed unreachable. */
  offline: boolean;
  /** The mid-send gate deferred the pull to the post-send flush. */
  deferred?: boolean;
  /** Rows the desktop returned (pre-merge); present on a completed pull. */
  rows?: number;
  /** Failure message when the pull errored (offline or otherwise). */
  error?: string;
};

/** Cap on how many desktop messages we pull per sync. */
const HISTORY_MESSAGE_LIMIT = 100;
/** Cap on how many recent artifacts the Artifacts list sheet shows. */
const MAX_LISTED_ARTIFACTS = 20;
/** Endpoint the offline (cloud) chat streams answers from. */
const OFFLINE_CHAT_STREAM_PATH = "/api/mobile/offline-chat/stream";
/**
 * Stable conversation id for offline-chat artifacts (map cards). The offline
 * chat is a single continuous thread, so one id keeps artifact ids stable.
 */
const OFFLINE_ARTIFACT_CONVERSATION_ID = "offline-chat";
/**
 * Max streamed rounds per turn in the offline tool loop: one answer round plus
 * at most one recall-continuation round. Keeps the client-side tool loop
 * bounded (there is no server-side agent loop for the offline responder).
 */
const MAX_OFFLINE_TOOL_ROUNDS = 2;

const createId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const WAKE_STATUS_COPY: Record<DesktopBridgeSendStatus, string | undefined> = {
  connecting: "Reaching your computer",
  waking: "Waking your computer",
  running: undefined,
};

const assetsToBridgeAttachments = async (
  assets: ImagePicker.ImagePickerAsset[],
): Promise<DesktopBridgeAttachment[] | null> => {
  const out: DesktopBridgeAttachment[] = [];
  for (const asset of assets) {
    // Normalize to a provider-decodable format (iOS library picks and shared
    // photos are often HEIC, which desktop model providers can't decode).
    const sendable = await toSendableImage(asset);
    if (!sendable) return null;
    out.push({
      url: `data:${sendable.mimeType};base64,${sendable.base64}`,
      mimeType: sendable.mimeType,
    });
  }
  return out;
};

/**
 * A locally-queued send. When the user submits while a reply is still
 * streaming, we eagerly add the user bubble (marked `queued: true`) and park
 * the dispatch payload here. As soon as the current stream finishes (or is
 * stopped), we drain the next queued item and dispatch it for real.
 */
type QueuedSend = {
  dispatchId: string;
  userMessageId: string;
  text: string;
  assets: ImagePicker.ImagePickerAsset[];
};

/**
 * Where a thread's turns go. `cloud` streams from the offline responder;
 * `desktop` routes to the paired computer's Stella agent over the bridge and
 * keeps the transcript in sync with the canonical desktop rows.
 */
export type ChatTransport =
  | { kind: "cloud"; guest: boolean }
  | { kind: "desktop"; access: StoredPhoneAccess };

export type ChatThread = {
  messages: ChatMessage[];
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  attachments: ImagePicker.ImagePickerAsset[];
  setAttachments: React.Dispatch<
    React.SetStateAction<ImagePicker.ImagePickerAsset[]>
  >;
  sending: boolean;
  /** Live working-indicator props — active/label reflect the current step. */
  workingIndicator: WorkingIndicatorState;
  storageLoaded: boolean;
  /** Recent artifacts in the conversation, newest first and de-duplicated. */
  conversationArtifacts: ChatArtifact[];
  /** Background tasks for the activity pill + tray, running-first then newest. */
  conversationTasks: MobileTask[];
  /**
   * Submit the current draft/attachments. Returns the optimistic user
   * bubble's local id when a turn was accepted (dispatched or queued) so
   * voice callers can locate the turn's reply precisely; null when the send
   * no-oped (not hydrated, empty draft, or AI consent pending).
   */
  send: () => { userMessageId: string } | null;
  stop: () => void;
  /**
   * Coalesced wake + pull + merge against the canonical desktop rows. A no-op
   * for the cloud transport; safe to call repeatedly (in-flight runs are
   * shared) so resume/focus catch-up syncs never stack.
   *
   * Pass `catchUp: true` from the call sites where the user could be looking
   * at stale content without knowing — landing sync, foreground/refocus
   * reconnect, manual Force Sync — so `catchingUp` reflects the pull. Catch-up
   * pulls re-pull the full message window instead of the delta cursor (see
   * `desktopSyncPullPlan`) so a cursor that got ahead of undelivered rows can
   * never make them silent no-ops. The steady-state task poll and the
   * send-path pulls stay unflagged and ride the cheap delta.
   */
  runDesktopSync: (options?: {
    catchUp?: boolean;
    trigger?: string;
  }) => Promise<DesktopSyncOutcome>;
  /**
   * True while the localChat push socket is connected: the desktop notifies
   * the phone of transcript changes in real time, so polling fallbacks (the
   * 5s task poll here, the 20s status poll on the surface) can stand down.
   */
  livePushConnected: boolean;
  /**
   * True while a catch-up-classified sync is in flight (see `runDesktopSync`).
   * If a catch-up call joins an in-flight steady-state run, that run is
   * promoted — a pull is genuinely happening either way. Cleared when the run
   * settles: the transcript is confirmed current (or confirmed unreachable,
   * which the offline affordances own).
   */
  catchingUp: boolean;
};

/**
 * Owns a single chat transcript end-to-end: persistence (keyed per thread),
 * the optimistic send queue, streaming, stop, and — for the desktop transport
 * — sync/reconcile against the canonical desktop rows. Routing is fixed by
 * `transport`, so each surface (cloud Chat tab, computer Computer tab) gets a
 * coherent, single-destination conversation with no cross-routing.
 */
export function useChatThread(opts: {
  threadId: ChatThreadId;
  transport: ChatTransport;
}): ChatThread {
  const { threadId, transport } = opts;
  const isDesktop = transport.kind === "desktop";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);
  const [sending, setSending] = useState(false);
  const [workingActivity, setWorkingActivity] = useState<WorkingActivity>(
    IDLE_WORKING_ACTIVITY,
  );

  // Merge a partial activity update onto the live snapshot. Run-level status
  // (wake copy, compaction) and the bridge's tool/streaming signals patch in
  // independently, so callers only set the fields they own.
  const patchActivity = useCallback((patch: Partial<WorkingActivity>) => {
    setWorkingActivity((current) => ({ ...current, ...patch }));
  }, []);

  const queueRef = useRef<QueuedSend[]>([]);
  const stoppedDispatchIdsRef = useRef<Set<string>>(new Set());
  const activeDispatchRef = useRef<{
    dispatchId: string;
    replyId: string;
    abort: AbortController;
  } | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const syncCursorRef = useRef<string | null>(null);
  const syncConversationIdRef = useRef<string | null>(null);
  const didMountSyncRef = useRef(false);
  // The in-flight desktop sync, shared so a send can await the same wake+pull
  // instead of racing a second one (see `runDesktopSync`). Resolves with
  // whether the desktop was unreachable so the send can skip a second wake.
  const desktopSyncRef = useRef<Promise<DesktopSyncOutcome> | null>(null);
  // Bumped whenever the paired computer changes or the surface unmounts, so an
  // in-flight sync started for the previous computer can't persist its cursor
  // or merge its transcript into the new one.
  const syncGenerationRef = useRef(0);
  // The just-completed desktop turn's background reconcile (optimistic rows →
  // canonical ids + cursor advance). It runs fire-and-forget after a turn, but
  // the next sync MUST wait for it: when a queued send drains immediately on
  // turn completion, the next turn's wake→sync would otherwise re-pull the
  // previous turn's rows before they were linked, and `mergeMessagesById` —
  // matching only by id/`canonicalId` — would append them as duplicates of the
  // previous user+assistant messages. Resolves (never rejects) when settled.
  const pendingReconcileRef = useRef<Promise<void> | null>(null);
  const drainQueueRef = useRef<(() => void) | null>(null);
  // The dispatch fn closes over `transport`; keep the latest in a ref so the
  // stable queue/drain machinery never dispatches against a stale destination.
  const dispatchRef = useRef<((item: QueuedSend) => Promise<void>) | null>(
    null,
  );

  // ─── Hydration & persistence ─────────────────────────────────────────────
  useEffect(() => {
    void Promise.all([
      loadChatMessages(threadId),
      loadChatSyncState(threadId),
    ]).then(([loaded, syncState]) => {
      syncConversationIdRef.current = syncState.conversationId;
      syncCursorRef.current = syncState.cursor;
      // Heal any linked-row/unlinked-twin duplicates persisted by builds that
      // could pull mid-send (see `collapseLinkedDuplicates`) — the damaged
      // transcript would otherwise render the duplicate until a delta arrives.
      setMessages(collapseLinkedDuplicates(loaded));
      setStorageLoaded(true);
    });
  }, [threadId]);

  // Debounce persistence so streaming (which mutates `messages` many times a
  // second) doesn't rewrite the whole history to disk on every chunk. The
  // offline (cloud) chat also mirrors its messages into the SQLite FTS index
  // that backs recall (upserts are no-ops for unchanged rows).
  useEffect(() => {
    if (!storageLoaded) return;
    const handle = setTimeout(() => {
      void saveChatMessages(threadId, messages);
      if (threadId === "cloud") void indexMessages(messages);
    }, 500);
    return () => clearTimeout(handle);
  }, [messages, storageLoaded, threadId]);

  // Open the SQLite recall index once for the offline chat and backfill any
  // pre-existing AsyncStorage transcript so old messages are searchable.
  useEffect(() => {
    if (threadId !== "cloud") return;
    void initMessageIndex();
  }, [threadId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Mirror of `sending` for reads outside render — notably the mid-send gate
  // in `runDesktopSync` and the push handler below. The ref is written
  // SYNCHRONOUSLY by `markSending` at every transition (the effect below is
  // only a belt-and-braces reconciler): the gate is consulted by imperative
  // callers (focus/AppState resume, Force Sync) that can run in the gap
  // between `setSending(true)` and its commit, and a ref updated only by an
  // effect would let those slip a mid-send pull through.
  const sendingRef = useRef(false);
  const markSending = useCallback((next: boolean) => {
    sendingRef.current = next;
    setSending(next);
  }, []);
  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  // A pull blocked by the mid-send gate is remembered here — never dropped —
  // and flushed once the send settles (the effect below the push socket).
  const pendingPushSyncRef = useRef(false);

  const persistSyncState = useCallback(
    (state: { conversationId?: string | null; cursor?: string | null }) => {
      const conversationId = state.conversationId?.trim() || null;
      const cursor = state.cursor?.trim() || null;
      syncConversationIdRef.current = conversationId;
      syncCursorRef.current = cursor;
      void saveChatSyncState(threadId, { conversationId, cursor });
    },
    [threadId],
  );

  // ─── Desktop transcript sync ─────────────────────────────────────────────
  // Coalesced wake + pull + merge. Concurrent callers (the landing sync and a
  // send) share one in-flight run so the desktop is woken and the existing
  // transcript reconciled exactly once, never twice racing each other. A send
  // awaits this before it streams, giving a strict wake → sync → send order so
  // a landing sync can't land its merge in the middle of an active turn.
  const desktopAccess = isDesktop ? transport.access : null;
  const desktopDeviceId = desktopAccess?.desktopDeviceId ?? null;

  // Catch-up accounting: how many catch-up-classified callers are currently
  // riding an in-flight run. A depth (not a flag) because coalescing lets
  // several catch-up callers attach to the same run — each attach balances
  // with one settle.
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
      /**
       * Internal: set only by the send pipeline's own wake → sync → send
       * step, which legitimately runs while `sending` is true. Every other
       * caller is deferred by the mid-send gate below.
       */
      duringSend?: boolean;
      /** Diagnostic label for the sync log (landing, resume, force-sync…). */
      trigger?: string;
    }): Promise<DesktopSyncOutcome> => {
      const catchUp = options?.catchUp === true;
      const trigger = options?.trigger ?? "unlabelled";
      if (!desktopAccess) return Promise.resolve({ offline: false });
      const existing = desktopSyncRef.current;
      if (existing) {
        // A steady-state caller just rides the in-flight run. A catch-up
        // caller must not: the in-flight run may be a cursor delta, and a
        // poisoned (ahead-of-undelivered-rows) cursor makes that delta an
        // empty no-op — Force Sync would "succeed" with nothing. Chain a real
        // catch-up pull after the in-flight run settles; the indicator covers
        // the whole wait.
        if (!catchUp) return existing;
        const chained = existing.then(() =>
          runDesktopSyncRef.current({ catchUp: true, trigger }),
        );
        trackCatchUpRun(chained);
        return chained;
      }
      // NEVER pull mid-send (05e5bf6) — enforced here, at the coalescing
      // point, so callers that don't check `sending` themselves (the Computer
      // tab's focus/AppState-resume handler, Force Sync) can't start one. The
      // desktop persists the turn's user row the moment the turn starts; a
      // mid-send pull would merge that canonical row before the optimistic
      // bubble is linked — rendering the user's message twice (the twin sorts
      // onto the desktop clock, below the reply) — while also advancing the
      // cursor past the turn so the post-turn reconcile can't heal it. Defer
      // to the post-send flush instead of dropping the request. `sendingRef`
      // is written synchronously by `markSending`, so this holds even for
      // callers racing the `setSending(true)` commit. The outcome is reported
      // as `deferred` so Force Sync can say so instead of claiming success.
      if (
        !shouldStartDesktopSyncRun({
          sending: sendingRef.current,
          duringSend: options?.duringSend === true,
        })
      ) {
        pendingPushSyncRef.current = true;
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
    // Snapshot the generation so results from a now-stale computer (switched or
    // unmounted mid-flight) are dropped instead of clobbering the current one.
    const generation = syncGenerationRef.current;
    const run = (async (): Promise<DesktopSyncOutcome> => {
      const startedAt = Date.now();
      let plan = { sinceCursor: null as string | null, fullWindow: true };
      try {
        // Let the previous turn's reconcile settle first so its canonical ids
        // are linked onto the optimistic rows and its cursor is persisted.
        // Otherwise this pull (e.g. the next, queued turn's wake→sync firing
        // the instant the prior turn finished) would re-fetch the previous
        // turn's rows against a stale cursor and duplicate them.
        const pendingReconcile = pendingReconcileRef.current;
        if (pendingReconcile) await pendingReconcile;
        const expectedConversationId = syncConversationIdRef.current;
        // Catch-up pulls ignore the delta cursor and re-pull the full window
        // (see `desktopSyncPullPlan`): a cursor that got ahead of undelivered
        // rows turns every delta — including Force Sync — into a silent empty
        // no-op, permanently. The full pull merges by id and returns a fresh
        // cursor, healing the poisoned state.
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
        setMessages((current) => mergeMessagesById(current, next.messages));
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
        return { offline: false, rows: next.messages.length };
      } catch (error) {
        // Best-effort: the device-status poll drives the connection badge, and
        // the next send/landing retries the sync. Report a confirmed offline so
        // the send can surface it without spending a second wake budget, and
        // carry the message so Force Sync can show a real error instead of a
        // silent no-op.
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
        // Only release the shared handle if a newer run hasn't claimed it.
        if (generation === syncGenerationRef.current) {
          desktopSyncRef.current = null;
        }
      }
    })();
      desktopSyncRef.current = run;
      if (catchUp) trackCatchUpRun(run);
      return run;
    },
    [desktopAccess, persistSyncState, trackCatchUpRun],
  );
  // Self-reference for the coalesce-chained catch-up pull above; a direct
  // recursive reference inside its own useCallback isn't possible.
  const runDesktopSyncRef = useRef(runDesktopSync);
  useEffect(() => {
    runDesktopSyncRef.current = runDesktopSync;
  }, [runDesktopSync]);

  // Re-arm the landing sync and invalidate any in-flight one whenever the
  // paired computer changes (or the surface unmounts), so the new computer
  // syncs on landing and a stale sync never persists the old cursor or merges
  // the old transcript. Declared before the landing effect so it re-arms first.
  useEffect(() => {
    didMountSyncRef.current = false;
    desktopSyncRef.current = null;
    pendingReconcileRef.current = null;
    return () => {
      syncGenerationRef.current += 1;
    };
  }, [desktopDeviceId, threadId]);

  // Once per surface landing, pull new desktop turns and merge them in.
  useEffect(() => {
    if (!desktopAccess) return;
    if (didMountSyncRef.current) return;
    if (!storageLoaded) return;
    didMountSyncRef.current = true;
    // Catch-up: the phone may have been away arbitrarily long; full-window
    // pull, and the "Catching up" pill covers it.
    void runDesktopSync({ catchUp: true, trigger: "landing" });
  }, [desktopAccess, runDesktopSync, storageLoaded]);

  // ─── localChat push (capability-gated, poll fallback stays) ─────────────
  // While mounted with a desktop transport, hold a push socket: the desktop
  // broadcasts `localChat:updated` on every persisted chat event, and each
  // notification triggers the same coalesced, cursor-scoped `runDesktopSync`
  // the polls use — so double delivery is harmless even mid-handoff, and the
  // 05e5bf6 mid-send gate is enforced here too (no pulls while `sending`).
  const [livePushConnected, setLivePushConnected] = useState(false);
  const storageLoadedRef = useRef(storageLoaded);
  useEffect(() => {
    storageLoadedRef.current = storageLoaded;
  }, [storageLoaded]);

  // A push that lands while `sending` is true can't pull right away (mid-send
  // gate), but it must not be dropped either: the turn's own agent-started /
  // task lifecycle events broadcast mid-send, and if the post-turn reconcile
  // races the desktop persisting those rows the running-task snapshot behind
  // the activity pill is never re-delivered. Remembered in
  // `pendingPushSyncRef` (declared above `runDesktopSync`) and flushed
  // post-send.
  useEffect(() => {
    if (!desktopAccess) return;
    let pushDebounce: ReturnType<typeof setTimeout> | null = null;
    const handle = openDesktopBridgeLive({
      access: desktopAccess,
      onLocalChatUpdated: () => {
        const gates = {
          storageLoaded: storageLoadedRef.current,
          sending: sendingRef.current,
        };
        if (!shouldSyncOnLocalChatPush(gates)) {
          if (shouldDeferLocalChatPushDuringSend(gates)) {
            pendingPushSyncRef.current = true;
          }
          return;
        }
        // Debounce bursts (a turn persists several events back-to-back).
        if (pushDebounce) clearTimeout(pushDebounce);
        pushDebounce = setTimeout(() => {
          pushDebounce = null;
          if (sendingRef.current) {
            // The send started inside the debounce window — defer, don't drop.
            pendingPushSyncRef.current = true;
            return;
          }
          void runDesktopSync({ trigger: "push" });
        }, 400);
      },
      onConnectedChange: setLivePushConnected,
    });
    return () => {
      if (pushDebounce) clearTimeout(pushDebounce);
      handle.close();
      setLivePushConnected(false);
    };
  }, [desktopAccess, runDesktopSync]);

  // Flush push notifications the mid-send gate deferred. `runDesktopSync`
  // awaits the turn's pending reconcile before reading the cursor, so this
  // pull can't interleave with the optimistic-row linking it was gated for.
  useEffect(() => {
    if (sending) return;
    if (!storageLoaded) return;
    if (!pendingPushSyncRef.current) return;
    pendingPushSyncRef.current = false;
    void runDesktopSync({ trigger: "post-send-flush" });
  }, [sending, storageLoaded, runDesktopSync]);

  const appendAssistantText = useCallback((replyId: string, chunk: string) => {
    setMessages((m) =>
      m.map((msg) =>
        msg.id === replyId ? { ...msg, text: msg.text + chunk } : msg,
      ),
    );
  }, []);

  const finishDispatch = useCallback(() => {
    markSending(false);
    setWorkingActivity(IDLE_WORKING_ACTIVITY);
    drainQueueRef.current?.();
  }, [markSending]);

  // Non-cancelable final flush for a settled turn. The debounced writer above
  // is cancelable (its cleanup clears the timeout on unmount), so a turn that
  // finishes right before the tab unmounts could be lost with no server copy.
  // Reading through a state updater captures the freshest committed transcript
  // (later than `messagesRef`, which only catches up in an effect), then
  // persists it and mirrors it into the recall index immediately.
  const flushPersistNow = useCallback(() => {
    setMessages((current) => {
      void saveChatMessages(threadId, current).catch(() => {});
      if (threadId === "cloud") void indexMessages(current);
      return current;
    });
  }, [threadId]);

  // ─── Cloud dispatch ───────────────────────────────────────────────────────
  const dispatchCloud = useCallback(
    async (item: QueuedSend, replyId: string, abort: AbortController) => {
      const guest = transport.kind === "cloud" ? transport.guest : false;
      // The offline tool + memory + compaction layer is scoped to the plain
      // offline chat (the "cloud" Chat tab, guest or signed-in). Other cloud
      // surfaces that ride the same send pipeline (the CarPlay voice loop)
      // keep the lean text-only behaviour.
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

      const imagesPayload: { base64: string; mimeType: string }[] = [];
      for (const a of item.assets) {
        const sendable = await toSendableImage(a);
        if (!sendable) continue;
        imagesPayload.push(sendable);
      }

      const textSmoother = createStreamTextSmoother({
        appendText: (chunk) => appendAssistantText(replyId, chunk),
      });

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

      // Aggregate a full completion without touching the UI — used to generate
      // compaction summaries through the same offline responder.
      const complete = async (
        prompt: string,
        history: { role: ChatMessage["role"]; text: string }[],
      ): Promise<string> => {
        let acc = "";
        await streamFn(
          OFFLINE_CHAT_STREAM_PATH,
          { message: prompt, history, images: [] },
          (delta) => {
            acc += delta;
          },
          streamOptions,
        );
        return acc;
      };

      // Map-tool failures, surfaced on the reply after the answer finishes
      // streaming so the note lands after the streamed text (see below).
      const mapErrors: string[] = [];
      // Resolve a map tool call and hang the interactive card off the reply.
      const applyMapTool = async (call: {
        places?: string[];
        origin?: string;
        destination?: string;
        mode?: string;
        title?: string;
      }) => {
        const outcome = await resolveMap(call);
        if (!outcome.ok) {
          // Don't drop the failure silently: the model already told the user a
          // map was coming, so a missing card with no explanation is confusing.
          mapErrors.push(outcome.error);
          return;
        }
        setMessages((m) =>
          m.map((msg) => {
            if (msg.id !== replyId) return msg;
            const existing = msg.artifacts ?? [];
            const artifact = mapArtifactFor(
              outcome.result.payload,
              OFFLINE_ARTIFACT_CONVERSATION_ID,
              existing.length,
            );
            if (existing.some((a) => a.id === artifact.id)) return msg;
            return { ...msg, artifacts: [...existing, artifact] };
          }),
        );
      };

      try {
        if (!toolsEnabled) {
          // Lean path: plain streamed text, no memory/tools/compaction.
          await streamFn(
            OFFLINE_CHAT_STREAM_PATH,
            { message: item.text, history: baseHistory, images: imagesPayload },
            (delta) => {
              if (/\S/.test(delta)) patchActivity({ isStreamingText: true });
              textSmoother.push(delta);
            },
            streamOptions,
          );
          await textSmoother.drain();
          ensureFallbackReply();
          notifySuccess();
          return;
        }

        // Durable memory + rolling checkpoint; compact if the running context
        // is over budget, then build the primed context turn.
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
          // Best-effort: a failed compaction just leaves context uncompacted.
        }
        const context = buildCompactedContext(priorMessages, checkpoint);
        const preamble = buildToolPreamble({
          memoryFacts,
          summary: context.summary,
        });
        const primedHistory: { role: ChatMessage["role"]; text: string }[] = [
          { role: "user", text: preamble },
          { role: "assistant", text: "Understood." },
          ...context.history,
        ];

        // One answer round, plus at most one recall-continuation round.
        let message = item.text;
        let roundImages = imagesPayload;
        for (let round = 0; round < MAX_OFFLINE_TOOL_ROUNDS; round += 1) {
          const filter = createToolBlockFilter();
          await streamFn(
            OFFLINE_CHAT_STREAM_PATH,
            { message, history: primedHistory, images: roundImages },
            (delta) => {
              // Hide the trailing tool block while the answer streams.
              const visible = filter.feed(delta);
              if (!visible) return;
              if (/\S/.test(visible)) patchActivity({ isStreamingText: true });
              textSmoother.push(visible);
            },
            streamOptions,
          );
          const tail = filter.finalize();
          if (tail) {
            if (/\S/.test(tail)) patchActivity({ isStreamingText: true });
            textSmoother.push(tail);
          }

          const { calls } = parseToolBlock(filter.raw());
          const recalls: { query: string }[] = [];
          for (const call of calls) {
            if (call.tool === "remember") {
              await rememberFact(call.key, call.value);
            } else if (call.tool === "forget") {
              await forgetFact(call.key);
            } else if (call.tool === "map") {
              await applyMapTool(call);
            } else if (call.tool === "recall") {
              recalls.push({ query: call.query });
            }
          }

          if (recalls.length === 0 || round === MAX_OFFLINE_TOOL_ROUNDS - 1) {
            break;
          }
          // Feed the recall results back so the model answers next round.
          const excludeIds = new Set([item.userMessageId, replyId]);
          const resultParts = await Promise.all(
            recalls.map(async (r) =>
              formatRecallResults(
                await searchMessages(r.query, { excludeIds }),
                r.query,
              ),
            ),
          );
          const resultsText = resultParts.join("\n\n");
          message = `Recall results (from your earlier messages in this conversation):\n${resultsText}\n\nUsing these where relevant, answer the user's latest message: "${item.text}". Do not use the recall tool again.`;
          roundImages = [];
        }

        await textSmoother.drain();
        ensureFallbackReply();
        if (mapErrors.length > 0) {
          // Append after the drain so the note follows the streamed answer.
          const note = mapErrors.join("\n");
          setMessages((m) =>
            m.map((msg) => {
              if (msg.id !== replyId || msg.text.includes(note)) return msg;
              return { ...msg, text: msg.text ? `${msg.text}\n\n${note}` : note };
            }),
          );
        }
        notifySuccess();
      } catch (e) {
        if (e instanceof StreamAbortError) {
          textSmoother.cancel();
          setMessages((m) =>
            m.map((msg) =>
              msg.id === replyId ? { ...msg, stopped: true } : msg,
            ),
          );
        } else {
          textSmoother.flushNow();
          setMessages((m) =>
            m.map((msg) =>
              msg.id === replyId
                ? { ...msg, text: msg.text || userFacingError(e) }
                : msg,
            ),
          );
        }
      } finally {
        textSmoother.cancel();
        if (activeDispatchRef.current?.replyId === replyId) {
          activeDispatchRef.current = null;
        }
        finishDispatch();
        // Persist + index the settled turn immediately so it survives an
        // unmount inside the debounce window (offline chat has no server copy).
        flushPersistNow();
      }
    },
    [
      appendAssistantText,
      finishDispatch,
      flushPersistNow,
      patchActivity,
      threadId,
      transport,
    ],
  );

  // ─── Desktop dispatch ─────────────────────────────────────────────────────
  const dispatchDesktop = useCallback(
    async (
      item: QueuedSend,
      replyId: string,
      abort: AbortController,
      access: StoredPhoneAccess,
    ) => {
      const textSmoother = createStreamTextSmoother({
        appendText: (chunk) => appendAssistantText(replyId, chunk),
      });
      let sawDelta = false;

      try {
        // wake → sync → send: reconcile the existing transcript first (this
        // also wakes the desktop) so the landing sync's merge can't interleave
        // with this turn's stream. If that wake already proved the desktop is
        // offline, surface it now rather than spending a second wake budget.
        patchActivity({ statusText: WAKE_STATUS_COPY.connecting });
        const synced = await runDesktopSync({
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
        const result = await sendDesktopBridgeChat({
          access,
          message: item.text,
          attachments: (await assetsToBridgeAttachments(item.assets)) ?? undefined,
          signal: abort.signal,
          onStatus: (status) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            // Connection/wake copy is a run-level status; merge it without
            // disturbing the live tool/streaming flags.
            patchActivity({ statusText: WAKE_STATUS_COPY[status] });
          },
          onActivity: (activity: DesktopBridgeActivity) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            // The bridge already folded the tool/stream events into a settled
            // snapshot; adopt it wholesale so the indicator tracks the run.
            setWorkingActivity({
              ...(activity.toolName ? { toolName: activity.toolName } : {}),
              ...(activity.toolCallId
                ? { toolCallId: activity.toolCallId }
                : {}),
              ...(activity.statusText
                ? { statusText: activity.statusText }
                : {}),
              isStreamingText: activity.isStreamingText,
              hasToolActivity: activity.hasToolActivity,
            });
          },
          onTextDelta: (delta) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            sawDelta = true;
            textSmoother.push(delta);
          },
          onArtifacts: (artifacts) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            setMessages((m) =>
              m.map((msg) => (msg.id === replyId ? { ...msg, artifacts } : msg)),
            );
          },
        });
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          activeDispatchRef.current = null;
          markSending(false);
          return;
        }
        await textSmoother.drain();
        activeDispatchRef.current = null;
        // Link the turn to its canonical desktop ids immediately (not just in
        // the background reconcile below, whose delta may race the desktop
        // persisting the rows): the user bubble adopts the canonical id the
        // bridge reported for the submitted message, and the reply adopts it
        // as `requestId` — the key canonical assistant rows carry — so any
        // later sync updates these rows in place instead of duplicating them.
        const canonicalUserMessageId = result.userMessageId.trim();
        setMessages((m) =>
          m.map((msg) => {
            if (msg.id === replyId) {
              return {
                ...msg,
                text: result.text,
                ...(canonicalUserMessageId
                  ? { requestId: canonicalUserMessageId }
                  : {}),
                ...(result.artifacts.length > 0
                  ? { artifacts: result.artifacts }
                  : {}),
              };
            }
            if (msg.id === item.userMessageId && canonicalUserMessageId) {
              return { ...msg, canonicalId: canonicalUserMessageId };
            }
            return msg;
          }),
        );
        // Reconcile with canonical desktop rows in the background so ids line
        // up with future syncs. Snapshot the sync generation so a reconcile that
        // resolves after the paired computer/thread changed (or the surface
        // unmounted) can't persist a stale cursor or merge the old transcript.
        const reconcileGeneration = syncGenerationRef.current;
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
            const hasCanonicalAssistant = delta.messages.some(
              (message) => message.role === "assistant",
            );
            if (!hasCanonicalAssistant) return;
            setMessages((m) =>
              reconcileSentDesktopTurn({
                current: m,
                userMessageId: item.userMessageId,
                replyId,
                sentText: item.text,
                canonicalMessages: delta.messages,
                ...(canonicalUserMessageId
                  ? { canonicalUserMessageId }
                  : {}),
              }),
            );
          })
          .catch(() => {
            // The optimistic local turn is already rendered; the next sync
            // will reconcile with canonical desktop message ids.
          });
        // Publish the reconcile so the next sync (notably a queued send
        // draining right now) waits for these rows to be linked + the cursor
        // advanced before it pulls, instead of re-fetching and duplicating
        // them. Clear it once settled so it never blocks later syncs.
        pendingReconcileRef.current = reconcilePromise;
        void reconcilePromise.finally(() => {
          if (pendingReconcileRef.current === reconcilePromise) {
            pendingReconcileRef.current = null;
          }
        });
        notifySuccess();
        finishDispatch();
      } catch (e) {
        textSmoother.cancel();
        activeDispatchRef.current = null;
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          markSending(false);
          return;
        }
        // Deterministic routing: the computer thread never silently falls back
        // to the cloud. Surface an offline reply the user can act on (wake the
        // computer and retry).
        const message =
          e instanceof DesktopOfflineError && !sawDelta
            ? "Your computer is offline. Wake it from the menu, then try again."
            : userFacingError(e);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId ? { ...msg, text: msg.text || message } : msg,
          ),
        );
        finishDispatch();
      } finally {
        textSmoother.cancel();
      }
    },
    [
      appendAssistantText,
      finishDispatch,
      markSending,
      patchActivity,
      persistSyncState,
      runDesktopSync,
    ],
  );

  // ─── Queue & dispatch ─────────────────────────────────────────────────────
  const dispatch = useCallback(
    async (item: QueuedSend) => {
      const replyId = createId();
      const abort = new AbortController();
      activeDispatchRef.current = {
        dispatchId: item.dispatchId,
        replyId,
        abort,
      };
      // Fresh turn — clear any activity left over from the previous reply so
      // the indicator starts from the pre-tool "thinking" state.
      setWorkingActivity(IDLE_WORKING_ACTIVITY);
      // Promote the queued bubble out of the dimmed state and add an empty
      // assistant placeholder beside it.
      const dispatchedAt = Date.now();
      setMessages((m) => [
        ...m.map((msg) => {
          if (msg.id !== item.userMessageId) return msg;
          // Re-stamp a *queued* bubble's display time to its real dispatch
          // moment. Its original `createdAt` is the enqueue moment (when the
          // user tapped send while the prior turn was still streaming), which
          // would read as sent before any messages that landed during the
          // wait. Ordering converges via the canonical desktop stamp once the
          // turn reconciles (`canonicalCreatedAt` — see `sortCanonically` in
          // chat-merge); this local `createdAt` stays the display anchor and
          // is preserved by both the merge and the post-turn reconcile.
          return msg.queued
            ? { ...msg, queued: false, createdAt: dispatchedAt }
            : { ...msg, queued: false };
        }),
        {
          id: replyId,
          role: "assistant" as const,
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

  const send = useCallback((): { userMessageId: string } | null => {
    // Don't dispatch until hydration has restored the persisted transcript and
    // sync cursor: sending earlier lets the async load overwrite the optimistic
    // bubble, and lets the landing sync fire mid-stream against a fresh cursor.
    // The draft is left intact so the queued tap lands once we're loaded.
    if (!storageLoaded) return null;
    const text = draft.trim();
    if (!text && attachments.length === 0) return null;

    if (!hasAiConsent()) {
      requestAiConsent();
      return null;
    }

    const assets = attachments.slice();
    setDraft("");
    setAttachments([]);

    // Queue-vs-dispatch is decided on the synchronously-written ref, NOT the
    // render-state `sending`: a second imperative send in the same
    // render/effect gap would read a stale `sending === false` from the
    // closure and dispatch a concurrent turn instead of queueing. `admitSend`
    // claims the dispatch slot atomically (ref write) when it answers
    // "dispatch"; `markSending` below mirrors the claim into render state.
    const admission = admitSend(sendingRef);

    const userMessageId = createId();
    const displayText = text || (assets.length ? "Photo" : "");
    const thumbs = assets.slice(0, 3).map((a) => a.uri);
    const userMsg: ChatMessage = {
      id: userMessageId,
      role: "user",
      text: displayText,
      createdAt: Date.now(),
      hasImage: assets.length > 0,
      ...(thumbs.length > 0 ? { thumbnailUris: thumbs } : {}),
      ...(admission === "queue" ? { queued: true } : {}),
    };

    LayoutAnimation.configureNext({
      duration: 350,
      update: { type: LayoutAnimation.Types.spring, springDamping: 1 },
    });
    setMessages((m) => [...m, userMsg]);

    const item: QueuedSend = {
      dispatchId: createId(),
      userMessageId,
      text,
      assets,
    };
    if (admission === "queue") {
      queueRef.current.push(item);
    } else {
      markSending(true);
      void dispatch(item);
    }
    return { userMessageId };
  }, [attachments, dispatch, draft, markSending, storageLoaded]);

  const stop = useCallback(() => {
    // Drop queued follow-ups first so the in-flight finally-handler doesn't
    // pick them up after the abort.
    const cancelledIds = queueRef.current.map((q) => q.userMessageId);
    queueRef.current = [];
    if (cancelledIds.length > 0) {
      setMessages((m) => m.filter((msg) => !cancelledIds.includes(msg.id)));
    }
    if (activeDispatchRef.current) {
      const active = activeDispatchRef.current;
      stoppedDispatchIdsRef.current.add(active.dispatchId);
      active.abort.abort();
      setMessages((m) =>
        m.map((msg) =>
          msg.id === active.replyId ? { ...msg, stopped: true } : msg,
        ),
      );
      activeDispatchRef.current = null;
    }
    markSending(false);
    setWorkingActivity(IDLE_WORKING_ACTIVITY);
  }, [markSending]);

  const workingIndicator = useMemo(
    () => buildWorkingIndicatorState({ sending, activity: workingActivity }),
    [sending, workingActivity],
  );

  const conversationArtifacts = useMemo(() => {
    const seen = new Set<string>();
    const out: ChatArtifact[] = [];
    const push = (artifact: ChatArtifact): boolean => {
      // Incidental writes (caches, profiles, scratch) stay out of the
      // browser — mirrors the desktop noise filter on every user-facing
      // produced-file surface.
      if (isNoiseFileArtifact(artifact)) return false;
      if (seen.has(artifact.id)) return false;
      seen.add(artifact.id);
      out.push(artifact);
      return out.length >= MAX_LISTED_ARTIFACTS;
    };
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      for (const artifact of messages[i].artifacts ?? []) {
        // Agent-work cards are inline-chat only — not openable files, so the
        // card itself doesn't belong in the artifacts browser — but the files
        // riding its per-agent sections do (consolidating bridges no longer
        // ship them loose).
        if (isAgentWorkArtifact(artifact)) {
          for (const section of agentWorkCardSections(artifact) ?? []) {
            for (const file of section.files) {
              if (push(file)) return out;
            }
          }
          continue;
        }
        if (push(artifact)) return out;
      }
    }
    return out;
  }, [messages]);

  // Every background task across the conversation, newest first, running ones
  // pinned to the top — the data behind the activity pill + tray. Tasks ride on
  // their spawning message and task-update sync rows; dedupe by id while
  // letting terminal updates beat older running snapshots so zombie tasks do
  // not stay pinned in the pill/tray.
  const conversationTasks = useMemo(() => {
    return collectConversationTasks(messages);
  }, [messages]);

  const hasRunningConversationTask = conversationTasks.some(
    (task) => task.status === "running",
  );

  useEffect(() => {
    // Never poll while a send is in flight (05e5bf6): the desktop persists
    // the turn's user row the moment it starts, and a mid-turn pull would
    // merge that canonical row before `reconcileSentDesktopTurn` links the
    // optimistic bubble — duplicating it — while also advancing the cursor
    // past the turn so the post-turn reconcile can't find its rows. Mid-turn
    // activity already streams over the bridge; polling only matters between
    // turns. While the localChat push socket is live the poll stays armed at
    // a slow verification cadence (push owns freshness, the poll guarantees
    // the running-task snapshot behind the activity pill can't freeze if the
    // socket silently stops delivering).
    if (
      !shouldArmDesktopTaskPoll({
        isDesktopTransport: Boolean(desktopAccess),
        storageLoaded,
        hasRunningConversationTask,
        sending,
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
    hasRunningConversationTask,
    livePushConnected,
    runDesktopSync,
    sending,
    storageLoaded,
  ]);

  return {
    messages,
    draft,
    setDraft,
    attachments,
    setAttachments,
    sending,
    workingIndicator,
    storageLoaded,
    conversationArtifacts,
    conversationTasks,
    send,
    stop,
    runDesktopSync,
    catchingUp,
    livePushConnected,
  };
}
