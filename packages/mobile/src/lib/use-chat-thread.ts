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

/** What a `runDesktopSync` call actually did, so callers can be honest. */
export type DesktopSyncOutcome = {
  /** The desktop was confirmed unreachable. */
  offline: boolean;
  /** The mid-send gate deferred the pull to the post-send flush. */
  deferred?: boolean;
  /** Rows the desktop returned (pre-merge); present on a completed pull. */
  rows?: number;
  /** Canonical user identities observed in this pull. */
  acceptedUserMessageIds?: string[];
  /** Bridge/conversation/socket seed shared by a serialized replay batch. */
  preparedSend?: DesktopBridgeSendBatch;
  /** Failure message when the pull errored (offline or otherwise). */
  error?: string;
};

/** Cap on how many desktop messages we pull per sync. */
const HISTORY_MESSAGE_LIMIT = 100;
/** Cap on how many recent artifacts the Artifacts list sheet shows. */
/** Endpoint the offline (cloud) chat streams answers from. */
const OFFLINE_CHAT_STREAM_PATH = "/api/mobile/offline-chat/stream";
/**
 * Stable conversation id for offline-chat artifacts (map cards). The offline
 * chat is a single continuous thread, so one id keeps artifact ids stable.
 */
const OFFLINE_ARTIFACT_CONVERSATION_ID = "offline-chat";
/**
 * Native tool rounds are client-mediated because several tools create local
 * phone artifacts. The provider still receives real tool-call/tool-result
 * messages on every continuation round.
 */
const MAX_OFFLINE_TOOL_ROUNDS = 4;

/** Quiet period after the last `messages` change before the transcript is written. */
const PERSIST_DEBOUNCE_MS = 500;

let lastLocalIdOrder = 0;
const createId = () => {
  // Fixed-width logical time keeps same-timestamp mobile identities in compose
  // order when the desktop's canonical `(timestamp, id)` tie-breaker applies.
  lastLocalIdOrder = Math.max(Date.now(), lastLocalIdOrder + 1);
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `mobile:${String(lastLocalIdOrder).padStart(16, "0")}:${random}`;
};

/**
 * Fold composer quote chips into the outgoing message: each quote becomes a
 * markdown blockquote (every line prefixed with "> "), stacked ahead of the
 * user's typed text. Mirrors the desktop quote/reply convention so the quoted
 * context travels with the sent message. Returns just `typed` when there are no
 * quotes, and just the quotes when the user only quoted without typing.
 */
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

/**
 * Join composer quote chips into a single raw context blob (no `> ` prefixes)
 * delivered to the model as a dedicated `selectedText` field on a fresh turn.
 * The runtime wraps it as hidden context and the bubble shows it as a chip, so
 * the quote never folds into the visible/persisted user body.
 */
const composeRawQuotes = (quotes: ComposerQuote[]): string =>
  quotes
    .map((quote) => quote.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");

/** Bounded preview of quoted context stored on the sent message for its chip. */
const QUOTED_TEXT_PREVIEW_MAX_CHARS = 4_000;

// Run-level connection status shown before the desktop starts the run.
// `connecting` deliberately carries no copy: desktop has no "reaching" state,
// so mobile lets the indicator fall through to the same baseline
// "Thinking"/reasoning label desktop shows (see working-indicator-status).
// Only a genuine cold wake surfaces its own line.
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
    // Normalize to a provider-decodable format (iOS library picks and shared
    // photos are often HEIC, which desktop model providers can't decode).
    // Skip individual undecodable assets (matching the cloud path) rather
    // than dropping the whole batch.
    const sendable = await toSendableImage(asset);
    if (!sendable) continue;
    out.push({
      url: `data:${sendable.mimeType};base64,${sendable.base64}`,
      mimeType: sendable.mimeType,
    });
  }
  if (assets.length > 0 && out.length === 0) {
    // Every asset failed: fail the turn visibly instead of dispatching it
    // without the attachments the user just picked.
    throw new Error("Couldn't attach that photo. Try a different image.");
  }
  return out;
};

/**
 * Rebuild composer attachments for a rewound user message. The transcript only
 * persists each image's on-device thumbnail uri (not its base64 bytes — those
 * would bloat AsyncStorage), so Rewind re-reads the bytes from disk to produce
 * fully sendable assets, mirroring the share-intent import path. Uris whose
 * backing file is gone (cache eviction) are skipped per-asset rather than
 * failing the whole rewind; the text still restores.
 */
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
      // The send path (`toSendableImage`) sniffs the real mime type from these
      // bytes and only reads `uri`/`base64`, so a minimal asset is sufficient
      // for both the composer thumbnail and a faithful resend.
      assets.push({
        uri,
        base64,
        width: 0,
        height: 0,
      } as ImagePicker.ImagePickerAsset);
    } catch {
      // Skip an image whose backing file is gone rather than failing the rewind.
    }
  }
  return assets;
};

/**
 * A durably ordered send awaiting transmission. Cloud chat holds it until the
 * current reply settles. Computer chat instead drains it through the
 * acceptance-only steer pump as soon as the active message is durable, so it
 * reaches the runtime during the same root turn without opening another reply
 * observer.
 */
type QueuedSend = {
  dispatchId: string;
  clientRequestId: string;
  userMessageId: string;
  /**
   * Message body for the steer/queued fallback path — keeps the folded quote
   * blockquote so a follow-up steer (which carries no separate context) still
   * delivers the quote to the model.
   */
  text: string;
  /**
   * Fresh-turn message body with quotes decoupled out: just the typed text.
   * The primary `sendDesktopBridgeChat` path sends this plus `selectedText`
   * so the quote reaches the model without leaking into the visible body.
   */
  promptText?: string;
  /** Raw quoted / "Ask Stella" context delivered as a dedicated model field. */
  selectedText?: string;
  assets: ImagePicker.ImagePickerAsset[];
  queueSequence?: number;
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
  /**
   * Stable attached-chat id. Computer chat exposes the paired desktop's
   * canonical conversation id once its first sync resolves.
   */
  conversationId?: string | null;
  messages: ChatMessage[];
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  attachments: ImagePicker.ImagePickerAsset[];
  setAttachments: React.Dispatch<
    React.SetStateAction<ImagePicker.ImagePickerAsset[]>
  >;
  /** Quoted-text chips pending in the composer (folded into the sent message). */
  quotes: ComposerQuote[];
  /** Add a quoted-text chip (message-menu Quote / assistant "Ask Stella"). */
  addQuote: (text: string) => void;
  /** Remove a pending quote chip by id. */
  removeQuote: (id: string) => void;
  sending: boolean;
  /** Live working-indicator props — active/label reflect the current step. */
  workingIndicator: WorkingIndicatorState;
  storageLoaded: boolean;
  /** All artifacts in the conversation, newest first and de-duplicated. */
  conversationArtifacts: ChatArtifact[];
  /** Background tasks for the activity pill + tray, running-first then newest. */
  conversationTasks: MobileTask[];
  /** Files grouped by their owning background task for the activity hub. */
  activityArtifactsByTaskId: ReadonlyMap<string, ChatArtifact[]>;
  /** Direct orchestrator files owned by the conversation rather than a task. */
  conversationOwnedArtifacts: ChatArtifact[];
  /**
   * Submit the current draft/attachments. Returns the optimistic user
   * bubble's local id when a turn was accepted (dispatched or queued) so
   * voice callers can locate the turn's reply precisely; null when the send
   * no-oped (not hydrated, empty draft, or AI consent pending).
   */
  send: () => { userMessageId: string } | null;
  /**
   * Submit a supplied prompt without routing it through React draft state.
   * Realtime voice uses this to hand an action to the exact active chat.
   */
  sendPrompt?: (prompt: string) => { userMessageId: string } | null;
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
  /**
   * Rewind to a user message: truncate the transcript at it (dropping it and
   * everything after) and restore its text + attachments to the composer.
   * A no-op unless the thread owns its transcript (the cloud chat) and is idle.
   */
  rewindToMessage: (messageId: string) => void;
};

/**
 * Owns a single chat transcript end-to-end: persistence (keyed per thread),
 * the optimistic send queue, delivery, stop, and — for the desktop transport
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
  const [conversationId, setConversationId] = useState<string | null>(
    isDesktop ? null : threadId,
  );
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);
  // Quoted-text chips pending in the composer (from the message menu's "Quote"
  // or an assistant selection's "Ask Stella"). Kept out of `draft` so the input
  // isn't stuffed with a paragraph; folded into the outgoing text on send.
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

  // Merge a partial activity update onto the live snapshot. Run-level status
  // (wake copy, compaction) and the bridge's tool/message signals patch in
  // independently, so callers only set the fields they own.
  const patchActivity = useCallback((patch: Partial<WorkingActivity>) => {
    setWorkingActivity((current) => {
      // Identity-stable bail-out: several events can patch the same settled
      // value, and a fresh object here re-renders the chat surface for nothing.
      for (const key of Object.keys(patch) as (keyof WorkingActivity)[]) {
        if (!Object.is(current[key], patch[key])) {
          return { ...current, ...patch };
        }
      }
      return current;
    });
  }, []);

  // Adopt a whole activity snapshot. `patchActivity` only merges the fields a
  // caller owns, so it can't clear one the snapshot dropped (a tool ending
  // would leave its label pinned); this replaces every field instead.
  //
  // It carries the same bail-out: the desktop bridge re-emits a settled
  // snapshot on every tool/status/message event, and committing a fresh object
  // for an unchanged snapshot would re-render the whole chat surface.
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
  // The in-flight desktop sync, shared so a send can await the same wake+pull
  // instead of racing a second one (see `runDesktopSync`). Resolves with
  // whether the desktop was unreachable so the send can skip a second wake.
  const desktopSyncRef = useRef<{
    promise: Promise<DesktopSyncOutcome>;
    catchUp: boolean;
  } | null>(null);
  const desktopSendBatchRef = useRef<DesktopBridgeSendBatch | null>(null);
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
      loadDesktopChatOutbox(threadId),
    ]).then(([loaded, syncState, storedOutbox]) => {
      syncConversationIdRef.current = syncState.conversationId;
      setConversationId(
        isDesktop ? (syncState.conversationId ?? null) : threadId,
      );
      syncCursorRef.current = syncState.cursor;
      // Heal any linked-row/unlinked-twin duplicates persisted by builds that
      // could pull mid-send (see `collapseLinkedDuplicates`) — the damaged
      // transcript would otherwise render the duplicate until a delta arrives.
      const healed = restoreOutboxMessages(
        collapseLinkedDuplicates(loaded),
        storedOutbox,
      );
      setMessages(healed);
      setStorageLoaded(true);
      // Re-enqueue any queued-but-unsent messages. The optimistic bubbles were
      // persisted (marked `queued`), but the in-memory dispatch queue was lost
      // on relaunch — so without this they'd render forever as "sent" yet never
      // deliver. Rebuild a dispatch for each from its bubble and drain, so a
      // restart actually sends them. New outbox rows include their attachment
      // payload; legacy image rows did not, so they remain visible but are not
      // silently replayed as a text-only "Photo" turn.
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
      // Nothing can be dispatching yet on a fresh mount (send() no-ops until
      // hydration completes), so draining here just kicks off the first
      // re-send; the rest drain as each turn settles.
      if (pendingSends.length > 0) {
        drainQueueRef.current?.();
      }
    });
  }, [isDesktop, threadId]);

  // Debounce persistence so a busy turn (tool steps and artifacts mutate
  // `messages` repeatedly) doesn't rewrite the whole history to disk each
  // time. The
  // offline (cloud) chat also mirrors its messages into the SQLite FTS index
  // that backs recall (upserts are no-ops for unchanged rows).
  const pendingSaveRef = useRef<ChatMessage[] | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMessageChangeAtRef = useRef(0);
  useEffect(() => {
    if (!storageLoaded) return;
    pendingSaveRef.current = messages;
    lastMessageChangeAtRef.current = Date.now();
    // Still a trailing debounce — the write must stay off the hot path, since
    // `saveChatMessages` JSON-stringifies the whole transcript — but armed
    // once instead of re-armed per change. `messages` gets a new identity on
    // every landed segment / tool step / artifact, so the old clear/re-arm
    // pair re-armed far more often than the write needed.
    // If more content lands while the timer is out, it re-sleeps the
    // remainder rather than writing early.
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

  // Drop the armed timer when the thread changes or the hook unmounts. The
  // effect below flushes whatever it was going to write, so cancelling here
  // loses nothing.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current === null) return;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    };
  }, [threadId]);

  // Open the SQLite recall index once for the offline chat and backfill any
  // pre-existing AsyncStorage transcript so old messages are searchable.
  useEffect(() => {
    if (threadId !== "cloud") return;
    void initMessageIndex();
  }, [threadId]);

  // Flush the debounced write on unmount/thread change — dropping it loses
  // the whole in-flight turn for threads with no other source of truth
  // (CarPlay remounts the hook whenever the voice target flips).
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
      // Snapshot the generation so results from a now-stale computer (switched or
      // unmounted mid-flight) are dropped instead of clobbering the current one.
      const generation = syncGenerationRef.current;
      let run: Promise<DesktopSyncOutcome> = Promise.resolve({
        offline: false,
      });
      run = (async (): Promise<DesktopSyncOutcome> => {
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
    closeDesktopBridgeSendBatch(desktopSendBatchRef.current);
    desktopSendBatchRef.current = null;
    return () => {
      syncGenerationRef.current += 1;
      closeDesktopBridgeSendBatch(desktopSendBatchRef.current);
      desktopSendBatchRef.current = null;
    };
  }, [desktopDeviceId, threadId]);

  // Once per surface landing, pull new desktop turns and merge them in.
  useEffect(() => {
    if (!desktopAccess || !appActive) return;
    if (didMountSyncRef.current) return;
    if (!storageLoaded) return;
    didMountSyncRef.current = true;
    // Catch-up: the phone may have been away arbitrarily long; full-window
    // pull, and the "Catching up" pill covers it.
    void runDesktopSync({ catchUp: true, trigger: "landing" });
  }, [appActive, desktopAccess, runDesktopSync, storageLoaded]);

  // ─── Authoritative thread activity (runtime_agents projection) ──────────
  // The synced-message task fold only learns about a running agent from its
  // persisted spawn/terminal rows; mid-run state (progress ticks) is never
  // persisted. These two slices carry the live picture instead: the desktop's
  // authoritative task rows (fetched on `localChat:threadActivityUpdated`
  // pushes) and the renderer's ephemeral decoration snapshot (statusText +
  // reasoning phrases, carried on `localChat:taskDecorationUpdated` pushes).
  // Both stay null against older desktops — the fold is then the only source,
  // matching pre-push behavior.
  const [desktopThreadTasks, setDesktopThreadTasks] = useState<
    MobileTask[] | null
  >(null);
  const [desktopTaskDecoration, setDesktopTaskDecoration] =
    useState<DesktopTaskDecoration | null>(null);
  // Single-flight with a trailing rerun: transition bursts (a fan-out spawning
  // five agents) collapse into at most one in-flight fetch plus one follow-up.
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
  // Scope changes must invalidate an old request during render, before its
  // promise can commit results into the newly-selected thread. A new scope
  // gets its own single-flight state, so it also never queues behind (or gets
  // fetched through) the previous computer's `desktopAccess` closure.
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
        // The user may switch threads or computers while the bridge request is
        // in flight. Only the still-current scope may publish its result.
        if (threadTasksFetchRef.current !== state) return;
        if (tasks) setDesktopThreadTasks(tasks);
      } while (state.queued);
    } finally {
      state.inFlight = false;
    }
  }, [desktopAccess, threadTasksScopeKey]);

  // The activity overlay is per-computer, per-conversation state.
  useEffect(() => {
    setDesktopThreadTasks(null);
    setDesktopTaskDecoration(null);
  }, [desktopDeviceId, threadId]);

  // Landing fetch: the conversation id hydrates from disk with the sync
  // state, so returning threads get the authoritative running set without
  // waiting for the next thread transition to push one.
  useEffect(() => {
    if (!desktopAccess || !storageLoaded || !appActive) return;
    void refreshDesktopThreadTasks();
  }, [appActive, desktopAccess, refreshDesktopThreadTasks, storageLoaded]);

  // ─── localChat push (capability-gated, poll fallback stays) ─────────────
  // While mounted with a desktop transport, hold a push socket: the desktop
  // broadcasts `localChat:updated` on every persisted chat event, and each
  // notification triggers the same coalesced, cursor-scoped `runDesktopSync`
  // the polls use. Delivery is at-least-once, so durable event ids are deduped
  // before scheduling a pull. Tool/agent events can legitimately advance the
  // source cursor without projecting a visible message; a zero-row delta is
  // therefore a successful no-op, not a reason to fetch the full 100-row
  // window. The 05e5bf6 mid-send gate is enforced here too.
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
        // Debounce bursts (a turn persists several events back-to-back).
        if (pushDebounce) clearTimeout(pushDebounce);
        pushDebounce = setTimeout(() => {
          pushDebounce = null;
          if (sendingRef.current) {
            // The send started inside the debounce window — defer, don't drop.
            deferDesktopSync(false);
            return;
          }
          void runDesktopSync({ trigger: "push" });
        }, 400);
      },
      // Authoritative task rows: a thread transition (spawn, retitle,
      // terminal) pushes the signal; the coalesced fetch pulls the projection.
      // No mid-send gate — the fetch reads a side table, never the transcript
      // cursor, so it can't interleave with optimistic-row linking.
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
      // Decoration pushes carry the snapshot itself — store and render.
      onTaskDecorationUpdated: setDesktopTaskDecoration,
      onConnectedChange: (connected, details) => {
        setLivePushConnected(connected);
        // (Re)connect: pull the current running set — any transitions that
        // broadcast while the socket was down are already folded into it.
        if (connected) void refreshDesktopThreadTasks();
        // The first socket connection only closes the subscribe-vs-sync race
        // and therefore rides the saved cursor; a real socket drop uses the
        // bounded recent-window healer.
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

  // Flush push notifications the mid-send gate deferred. First await the
  // turn's reconcile: it can satisfy an ordinary push intent itself, avoiding
  // the redundant empty delta that previously followed every reply.
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

  /**
   * Append one COMPLETED assistant message segment to the turn's reply row.
   *
   * Assistant text is no longer streamed: each segment (preamble, post-tool
   * answer, …) arrives whole, exactly once. A turn keeps ONE optimistic reply
   * row — artifacts and tool steps are keyed to it by text offset, and the
   * merge machinery (`retargetOptimisticReplyToUser`,
   * `reconcileSentDesktopTurn`) links exactly one reply per turn — so a
   * multi-segment turn concatenates into that row with a paragraph break. The
   * background reconcile then splits it into its canonical desktop rows in one
   * atomic merge.
   */
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
      // A root terminal can race the lightweight durable-acceptance pump. Let
      // the current ACK finish before deciding whether the queue still needs a
      // fresh turn; stable ids prevent duplicate persistence, but without this
      // gate the UI could attach two observers to the same logical send.
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
          // A failed head stays parked for the post-root fresh-turn drain.
          // Successful/raced additions may start another acceptance pass.
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

      // Aggregate a full completion without touching the UI — used to generate
      // compaction summaries through the same offline responder.
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
      // Resolve a map tool call and hang the interactive card off the reply.
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

      // Generate a PDF on-device and hang the tappable file card off the reply.
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
          // Lean path: plain text segments, no memory/tools/compaction.
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

        // Durable memory + rolling checkpoint; compact if the running context
        // is over budget, then pass that context separately from native tools.
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

          // The round handed off to tools: this text was a preamble, not the
          // answer, so bring the working indicator back up for the tool work.
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
        // Persist + index the settled turn immediately so it survives an
        // unmount inside the debounce window (offline chat has no server copy).
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

  // ─── Desktop dispatch ─────────────────────────────────────────────────────
  const dispatchDesktop = useCallback(
    async (
      item: QueuedSend,
      replyId: string,
      abort: AbortController,
      access: StoredPhoneAccess,
    ) => {
      let sawAssistantSegment = false;
      // Canonical desktop id of the submitted user message, reported by the
      // bridge as soon as the desktop persists the row (before the run
      // settles). Captured so the error path below can link the optimistic
      // bubble even when the turn times out or disconnects before returning.
      let canonicalUserMessageIdSeen = "";

      try {
        // wake → sync → send: reconcile the existing transcript first (this
        // also wakes the desktop) so the landing sync's merge can't interleave
        // with this turn's stream. If that wake already proved the desktop is
        // offline, surface it now rather than spending a second wake budget.
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
            // Link the turn's optimistic rows to their canonical identity NOW,
            // not just when the turn settles: if the app is killed/suspended or
            // the bridge drops mid-stream, the persisted partial reply row
            // would otherwise carry no `requestId`, so no later merge could
            // ever fold the canonical reply into it (or sweep it as a
            // superseded snapshot) — it would render forever as a stale
            // partial duplicate above the full reply.
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
            // Connection/wake copy is a run-level status; merge it without
            // disturbing the live tool/answer flags.
            patchActivity({ statusText: WAKE_STATUS_COPY[status] });
          },
          onActivity: (activity: DesktopBridgeActivity) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            // The bridge already folded the tool/message events into a
            // settled snapshot; adopt it wholesale so the indicator tracks the
            // run.
            // Falsy fields collapse to `undefined` so an absent tool compares
            // equal across snapshots and the bail-out can hold.
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
          // The user stopped as the turn settled. The desktop has already
          // persisted the canonical user row, so link the optimistic bubble to
          // it now — otherwise the next send's wake→sync re-merges that row as
          // a duplicate of this user message (see linkOptimisticTurnToCanonical).
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
        // Link the turn to its canonical desktop ids immediately (not just in
        // the background reconcile below, whose delta may race the desktop
        // persisting the rows): the user bubble adopts the canonical id the
        // bridge reported for the submitted message, and the reply adopts it
        // as `requestId` — the key canonical assistant rows carry — so any
        // later sync updates these rows in place instead of duplicating them.
        const canonicalUserMessageId = result.userMessageId.trim();
        const responseUserMessageId =
          activeDispatchRef.current?.latestResponseUserMessageId ||
          canonicalUserMessageId ||
          item.userMessageId;
        setMessages((m) => {
          let changed = false;
          const next = m.map((msg) => {
            if (msg.id === replyId) {
              // Finalize IN PLACE: keep the delivered segments (same string
              // reference) whenever they already cover the turn's final text,
              // so the reply the user is reading isn't rewritten — and its
              // markdown re-rendered — at end of turn.
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
        // Reconcile with canonical desktop rows in the background so ids line
        // up with future syncs. Snapshot the sync generation so a reconcile that
        // resolves after the paired computer/thread changed (or the surface
        // unmounted) can't persist a stale cursor or merge the old transcript.
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
            // The reconcile read every event through its returned cursor. If
            // the only deferred request is the ordinary push intent that was
            // already pending when this read began, it is satisfied now. A
            // newer push has a different object identity and a catch-up intent
            // still needs its full-window healer, so neither is cleared here.
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
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          activeDispatchRef.current = null;
          // The user stopped this turn mid-run (the abort surfaced here).
          // The desktop persisted the turn's canonical user row at run start,
          // so link the optimistic bubble to it now — otherwise the next send's
          // wake→sync re-merges that canonical row as a duplicate of this user
          // message (see linkOptimisticTurnToCanonical).
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
        // Deterministic routing: the computer thread never silently falls back
        // to the cloud. Surface an offline reply the user can act on (wake the
        // computer and retry).
        const message =
          e instanceof DesktopOfflineError && !sawAssistantSegment
            ? "Your computer is offline. Wake it from the menu, then try again."
            : userFacingError(e);
        // The desktop persists the turn's canonical user row (and, if it got
        // far enough, the reply) the moment the run starts — even though this
        // turn errored/timed out locally. If the bridge reported that row's id
        // before failing, link the optimistic bubble to it now (and stamp the
        // reply's requestId) so a later poll/catch-up reconciles the turn in
        // place instead of appending the canonical user row as a duplicate.
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
          // No canonical identity means the desktop never accepted this send.
          // Keep the durable item at the head of the compose-order queue, but
          // do not spin immediately while offline. The next successful
          // foreground/push/manual sync drains it; relaunch hydration does too.
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

  // ─── Queue & dispatch ─────────────────────────────────────────────────────
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
          // user tapped send while the prior turn was still running), which
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
      // Don't dispatch until hydration has restored the persisted transcript and
      // sync cursor: sending earlier lets the async load overwrite the optimistic
      // bubble, and lets the landing sync fire mid-run against a fresh cursor.
      // The draft is left intact so the queued tap lands once we're loaded.
      if (!storageLoaded) return null;
      const supplied = suppliedPrompt !== undefined;
      const typed = (suppliedPrompt ?? draft).trim();
      // Composer quote chips fold into the outgoing text as markdown
      // blockquotes ahead of the typed message; supplied (voice) prompts skip
      // them since they bypass composer state entirely.
      const pendingQuotes = supplied ? [] : quotes;
      // `text` is the steer/queued fallback body (folded blockquote so a
      // follow-up steer still carries the quote). A fresh turn with both typed
      // text and quotes decouples instead: the quote rides as `selectedText`
      // and shows as a chip, so it never leaks into the visible body. Quote-only
      // sends keep the folded form (there is no separate body to attach a chip
      // to) — matching the desktop behaviour for an empty prompt.
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

      // Queue-vs-primary-dispatch is decided on the synchronously-written ref,
      // NOT the
      // render-state `sending`: a second imperative send in the same
      // render/effect gap would otherwise dispatch a second full response
      // observer. `admitSend` claims that singleton observer atomically; a
      // queued desktop item is still transmitted promptly by the durable-ACK
      // steer pump above, while cloud keeps its serial next-turn behavior.
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
      // Both transports gate transmission on this write. If iOS kills the
      // process while AsyncStorage is committing, either no transport happened
      // or hydration finds this exact stable identity and replays it, including
      // the image bytes.
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
    // Cancel queued messages first so the in-flight finally-handler doesn't
    // pick them up after the abort.
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
      // A canceled queued send is still part of the user's transcript. Keep
      // the bubble and mark it honestly instead of making text the user just
      // saw disappear from the conversation.
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

  // Rewind (destructive): drop a user message and everything after it, then
  // load its text + attachments back into the composer so it can be edited and
  // resent. Only the cloud chat owns its transcript outright — the computer
  // chat mirrors the paired desktop's canonical rows, so a local truncate there
  // would just be re-pulled on the next sync. The two-step confirm lives in the
  // UI (ChatPane's message menu); this performs the committed action.
  const rewindToMessage = useCallback(
    (messageId: string) => {
      if (transport.kind !== "cloud") return;
      if (!storageLoaded) return;
      // Never truncate under an in-flight turn — the in-flight reply writes into
      // the very rows we would be dropping.
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
      // Drop the target and everything after it. The debounced persist effect
      // writes the truncated transcript back to storage.
      setMessages(current.slice(0, index));
      // `text` holds the "Photo" placeholder for an image-only send (see
      // `submit`), so restore empty text in that case rather than the literal.
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

  // Every background task across the conversation, newest first, running ones
  // pinned to the top — the data behind the activity pill + tray. The synced
  // message fold provides durable history; the desktop's authoritative thread
  // rows override status/title for tasks they cover (and surface running
  // threads the loaded window missed), and the live decoration snapshot
  // supplies mid-run statusText/reasoning that is never persisted.
  const conversationTasks = useMemo(() => {
    return overlayDesktopThreadTasks(
      collectConversationTasks(messages),
      desktopThreadTasks,
      desktopTaskDecoration,
    );
  }, [desktopTaskDecoration, desktopThreadTasks, messages]);

  // The transcript's agent-work cards must agree with the pill above: their
  // synced `state` was settled desktop-side (where elapsed time counts as
  // completion), so re-derive it from the same live task fold. A `send_input`
  // follow-up steering a still-running thread renders as in-progress instead
  // of a false "Finished". Render-only — the raw fold stays what persists.
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
