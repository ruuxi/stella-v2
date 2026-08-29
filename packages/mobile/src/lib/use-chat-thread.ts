import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, LayoutAnimation } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import {
  CHAT_TRANSCRIPT_MAX_LOADED,
  CHAT_TRANSCRIPT_PAGE_LIMIT,
  chatTranscriptCursorForMessage,
  clearChatMessages,
  findChatMessageCursor,
  loadNewerChatMessages,
  loadOldestChatMessages,
  loadOlderChatMessages,
  loadRecentChatMessages,
  saveChatMessages,
  subscribeChatStorageCleanup,
  truncateChatMessagesFrom,
  loadChatSyncState,
  saveChatSyncState,
  type ChatTranscriptCursor,
  type ChatThreadId,
} from "./offline-chat-storage";
import {
  acknowledgeDesktopChatOutbox,
  enqueueDesktopChatOutbox,
  loadDesktopChatOutbox,
  markDesktopChatOutboxCancellation,
  type DesktopChatOutboxAuthority,
} from "./desktop-chat-outbox";
import {
  restoreOutboxMessages,
  type DesktopChatOutboxRecord,
} from "./desktop-chat-outbox-state";
import { postStream, postStreamAnonymous, StreamAbortError } from "./http";
import { hasAiConsent, requestAiConsent } from "./ai-consent";
import {
  getOrCreateMobileDeviceId,
  getPreferredPhoneAccess,
  type StoredPhoneAccess,
} from "./phone-access";
import {
  AutomaticExecutionWaitAbortedError,
  automaticExecutionCancellationCommand,
  automaticExecutionResultText,
  bindAutomaticExecutionAdmission,
  cancelAutomaticExecution,
  ensureAutomaticExecutionConversation,
  isAutomaticExecutionPairCredentialRejection,
  requestAutomaticExecutionCancellation,
  submitAutomaticExecution,
  waitForAutomaticExecution,
  type AutomaticExecutionDispatch,
  type AutomaticExecutionTurnControl,
} from "./execution-placement";
import {
  closeDesktopBridgeSendBatch,
  DesktopOfflineError,
  fetchDesktopBridgeHistoryBefore,
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
import {
  drainDesktopSyncPages,
  shouldUseLegacySyncRecoverySnapshot,
} from "./desktop-sync-pagination";
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
} from "./offline-chat-request";
import { admitSend } from "./send-admission";
import { shouldReuseQueuedReplayBatch } from "./desktop-send-batch-policy";
import {
  createSerializedChatPersistenceQueue,
  enqueueSerializedChatPersistence,
  establishTranscriptRewindBarrier,
  persistBoundedTranscriptMerge,
  selectIncrementalPersistenceRows,
} from "./chat-persistence-policy";
import {
  mergeNewerTranscriptPage,
  mergeOlderTranscriptPage,
} from "./chat-transcript-window";
import { drainDesktopSteerAcceptanceQueue } from "./desktop-steer-pump";
import { userFacingError } from "./user-facing-error";
import { notifySuccess } from "./haptics";
import {
  canonicalAuthorityLeaseAllowsWork,
  cloudCanonicalClientPolicy,
} from "./cloud-canonical-client-policy";
import { loadMemoryFacts, rememberFact, forgetFact } from "./chat-memory";
import {
  clearCheckpoint,
  saveCheckpoint,
  loadCheckpoint,
  planCompaction,
  runCompaction,
  buildCompactedContext,
  uncoveredMessages,
} from "./chat-compaction";
import {
  buildToolPreamble,
  createToolBlockFilter,
  parseToolBlock,
} from "./chat-tools";
import { formatRecallResults } from "./chat-recall";
import {
  beginMessageIndexRebuild,
  initMessageIndex,
  indexMessages,
  rebuildMessageIndex,
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
type DesktopSourceCursor = { timestamp: number; id: string };

const desktopSourceCursorForMessage = (
  message: ChatMessage | undefined,
): DesktopSourceCursor | null => {
  if (!message) return null;
  const timestamp =
    message.sourceTimestamp ?? message.canonicalCreatedAt ?? message.createdAt;
  const id = message.sourceMessageId ?? message.canonicalId ?? message.id;
  return typeof timestamp === "number" && Number.isFinite(timestamp) && id
    ? { timestamp, id }
    : null;
};

/** Cap on how many recent artifacts the Artifacts list sheet shows. */
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

/** Quiet period after the last `messages` change before the transcript is written. */
const PERSIST_DEBOUNCE_MS = 500;

const AUTOMATIC_RETRY_MS = 1_500;
const waitForAutomaticRetry = (signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AutomaticExecutionWaitAbortedError());
      return;
    }
    const timer = setTimeout(resolve, AUTOMATIC_RETRY_MS);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AutomaticExecutionWaitAbortedError());
      },
      { once: true },
    );
  });

const isPermanentAutomaticAdmissionError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /authentication required|sign in|signed-in account|ownership_migrated|linked to (?:an|another) account|being linked|owner generation|account data is currently|invalid|unsupported|not found|conflict|payload|conversation|malformed|different (?:dispatch|message) identity/i.test(
    message,
  );
};

const automaticPlacementStatus = (dispatch: AutomaticExecutionDispatch) => {
  switch (dispatch.state) {
    case "queued":
    case "offering":
    case "computer_claimed":
      return "Choosing where to run";
    case "computer_accepted":
    case "computer_running":
      return "Running on your computer";
    case "cloud_committed":
    case "cloud_running":
      return "Running in Stella Cloud";
    case "cancel_pending":
      return "Stopping";
    case "reconciliation_required":
      return "Reconnecting to your computer";
    default:
      return undefined;
  }
};

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

// Run-level connection status shown before the desktop starts streaming.
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
  /** Mount-local lease preventing an old account hook from dispatching later. */
  canonicalAuthorityLease?: number;
  /** Durable server cancellation identity restored from the outbox. */
  cancelRequestId?: string;
};

/**
 * Where a thread's turns go. `cloud` streams from the offline responder;
 * `desktop` routes to the paired computer's Stella agent over the bridge and
 * keeps the transcript in sync with the canonical desktop rows.
 */
type AutomaticChatTransport = {
  kind: "automatic";
  /** Work subject only; the server still owns execution placement. */
  workspace?: "computer";
  access?: StoredPhoneAccess | null;
  /**
   * Signed-in cloud journal reconciliation seam. The placement service
   * allocates a server dispatch id distinct from the mobile optimistic id;
   * the DO echoes that server id as clientMsgId.
   */
  onAdmission?: (event: {
    localMessageId: string;
    dispatchId: string;
    conversationId: string;
  }) => void;
};

export type ChatTransport =
  | { kind: "guest" }
  | (AutomaticChatTransport & { canonicalJournal?: false })
  | (AutomaticChatTransport & {
      canonicalJournal: true;
      accountScope: string;
      ownerGeneration: string;
      conversationId: string;
      authorityReady: boolean;
    });

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
  /** False while signed-in cloud history has no verified DO authority. */
  authorityReady?: boolean;
  /** Named cloud-authority failure; local cache never hides this condition. */
  authorityIssue?: {
    message: string;
    retryable: boolean;
    retry: () => void;
  } | null;
  /** Whether durable history exists before/after the bounded loaded window. */
  hasOlderMessages: boolean;
  hasNewerMessages: boolean;
  historyPageLoading: boolean;
  /** Page the adjacent durable window without growing Hermes state unbounded. */
  loadOlderMessages: () => Promise<void>;
  loadNewerMessages: () => Promise<void>;
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
   * pulls preserve a valid durable cursor and drain bounded forward pages.
   * Invalid cursors receive one bounded recovery snapshot. The steady-state
   * task poll and send-path pulls use the same cheap delta path.
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
 * the optimistic send queue, streaming, stop, and — for the desktop transport
 * — sync/reconcile against the canonical desktop rows. Routing is fixed by
 * `transport`, so each surface (cloud Chat tab, computer Computer tab) gets a
 * one server-owned placement decision per durable message identity.
 */
export function useChatThread(opts: {
  threadId: ChatThreadId;
  transport: ChatTransport;
}): ChatThread {
  const { threadId, transport } = opts;
  const isDesktop =
    transport.kind === "automatic" && transport.workspace === "computer";
  const canonicalJournal =
    transport.kind === "automatic" && transport.canonicalJournal === true;
  const canonicalAccountScope =
    transport.kind === "automatic" && transport.canonicalJournal === true
      ? transport.accountScope
      : null;
  const canonicalOwnerGeneration =
    transport.kind === "automatic" && transport.canonicalJournal === true
      ? transport.ownerGeneration
      : null;
  const canonicalConversationId =
    transport.kind === "automatic" && transport.canonicalJournal === true
      ? transport.conversationId
      : null;
  const canonicalAuthorityReady =
    transport.kind === "automatic" && transport.canonicalJournal === true
      ? transport.authorityReady
      : true;
  const canonicalAuthorityKey = canonicalJournal
    ? JSON.stringify([
        canonicalAccountScope,
        canonicalOwnerGeneration,
        canonicalConversationId,
      ])
    : null;
  const canonicalOutboxAuthority = useMemo<
    DesktopChatOutboxAuthority | undefined
  >(
    () =>
      canonicalAccountScope &&
      canonicalOwnerGeneration &&
      canonicalConversationId
        ? {
            accountScope: canonicalAccountScope,
            ownerGeneration: canonicalOwnerGeneration,
            conversationId: canonicalConversationId,
          }
        : undefined,
    [canonicalAccountScope, canonicalConversationId, canonicalOwnerGeneration],
  );
  const canonicalPolicy = cloudCanonicalClientPolicy({
    canonicalJournal,
    authorityReady: canonicalAuthorityReady,
  });
  const hydrateLocalTranscript = canonicalPolicy.hydrateLocalTranscript;
  const persistLocalTranscript = canonicalPolicy.persistLocalTranscript;
  const drainOperationalOutbox = canonicalPolicy.drainOperationalOutbox;
  const admissionEnabledRef = useRef(drainOperationalOutbox);
  admissionEnabledRef.current = drainOperationalOutbox;
  const desktopAccess = isDesktop ? (transport.access ?? null) : null;
  const desktopDeviceId = desktopAccess?.desktopDeviceId ?? null;
  const desktopTransportEnabledRef = useRef(true);
  useEffect(() => {
    desktopTransportEnabledRef.current = true;
  }, [desktopAccess?.pairSecret, desktopDeviceId, threadId]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const updateMessages = useCallback(
    (update: React.SetStateAction<ChatMessage[]>) => {
      const next =
        typeof update === "function"
          ? (update as (current: ChatMessage[]) => ChatMessage[])(
              messagesRef.current,
            )
          : update;
      messagesRef.current = next;
      setMessages(next);
    },
    [],
  );
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [hydrationRetryGeneration, setHydrationRetryGeneration] = useState(0);
  const [hydrationAuthorityIssue, setHydrationAuthorityIssue] =
    useState<ChatThread["authorityIssue"]>(null);
  const retryHydration = useCallback(() => {
    setHydrationRetryGeneration((generation) => generation + 1);
  }, []);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [hasNewerMessages, setHasNewerMessages] = useState(false);
  const [historyPageLoading, setHistoryPageLoading] = useState(false);
  const oldestLoadedCursorRef = useRef<ChatTranscriptCursor | null>(null);
  const newestLoadedCursorRef = useRef<ChatTranscriptCursor | null>(null);
  const historyPageRunRef = useRef<Promise<void> | null>(null);
  const historyPageGenerationRef = useRef(0);
  const desktopHistoryExhaustedRef = useRef(false);
  const desktopLegacyHistoryLimitRef = useRef(HISTORY_MESSAGE_LIMIT);
  const desktopOldestSourceCursorRef = useRef<DesktopSourceCursor | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(
    canonicalConversationId ?? (isDesktop ? null : threadId),
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
  // (wake copy, compaction) and the bridge's tool/streaming signals patch in
  // independently, so callers only set the fields they own.
  const patchActivity = useCallback((patch: Partial<WorkingActivity>) => {
    setWorkingActivity((current) => {
      // Identity-stable bail-out: streaming patches per network delta, and a
      // fresh object here re-renders the whole chat surface for no change.
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
  // It carries the same bail-out, and needs it more: the desktop bridge
  // re-emits a settled snapshot on EVERY streamed chunk, so committing a fresh
  // object here re-rendered the whole chat surface at provider token rate —
  // on top of the smoother's own per-frame text commit — for a value that
  // stops changing after the first chunk of a run.
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
    automaticControl?: AutomaticExecutionTurnControl;
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
  const desktopMergeQueueRef = useRef(createSerializedChatPersistenceQueue());
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
  const canonicalAuthorityLeaseRef = useRef(1);
  const canonicalAuthorityKeyRef = useRef(canonicalAuthorityKey);
  const committedCanonicalAuthorityKeyRef = useRef(canonicalAuthorityKey);
  if (canonicalAuthorityKeyRef.current !== canonicalAuthorityKey) {
    canonicalAuthorityKeyRef.current = canonicalAuthorityKey;
    canonicalAuthorityLeaseRef.current += 1;
  }
  const canonicalAuthorityLeaseCurrent = useCallback(
    (lease: number | undefined) =>
      canonicalAuthorityLeaseAllowsWork({
        canonicalJournal,
        capturedLease: lease,
        activeLease: canonicalAuthorityLeaseRef.current,
      }),
    [canonicalJournal],
  );

  useEffect(() => {
    const authorityChanged =
      committedCanonicalAuthorityKeyRef.current !== canonicalAuthorityKey;
    committedCanonicalAuthorityKeyRef.current = canonicalAuthorityKey;
    if (authorityChanged) {
      acceptedDesktopSendIdsRef.current.clear();
      stoppedDispatchIdsRef.current.clear();
      syncConversationIdRef.current = canonicalConversationId;
      syncCursorRef.current = null;
      setStorageLoaded(false);
      setHydrationAuthorityIssue(null);
      setConversationId(
        canonicalConversationId ?? (isDesktop ? null : threadId),
      );
      setDraft("");
      setAttachments([]);
      setQuotes([]);
      setSending(false);
      setWorkingActivity(IDLE_WORKING_ACTIVITY);
      updateMessages([]);
    }
    if (!canonicalJournal) return;
    const lease = canonicalAuthorityLeaseRef.current;
    const pendingEnqueues = pendingEnqueueRef.current;
    return () => {
      if (canonicalAuthorityLeaseRef.current === lease) {
        canonicalAuthorityLeaseRef.current += 1;
      }
      admissionEnabledRef.current = false;
      queueRef.current = [];
      pendingEnqueues.clear();
      const active = activeDispatchRef.current;
      activeDispatchRef.current = null;
      active?.abort.abort();
    };
  }, [
    canonicalAuthorityKey,
    canonicalConversationId,
    canonicalJournal,
    isDesktop,
    threadId,
    updateMessages,
  ]);

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    if (sendingRef.current) return;
    if (historyPageRunRef.current) return historyPageRunRef.current;
    const before = oldestLoadedCursorRef.current;
    const generation = historyPageGenerationRef.current;
    const run = (async () => {
      setHistoryPageLoading(true);
      try {
        const page = before
          ? await loadOlderChatMessages(threadId, before)
          : null;
        if (generation !== historyPageGenerationRef.current) return;
        if (
          (!page || page.messages.length === 0) &&
          isDesktop &&
          desktopAccess &&
          desktopTransportEnabledRef.current
        ) {
          const oldest = messagesRef.current[0];
          const activeConversationId = syncConversationIdRef.current;
          if (!activeConversationId) {
            setHasOlderMessages(false);
            return;
          }
          let sourceBefore = desktopOldestSourceCursorRef.current ??
            desktopSourceCursorForMessage(oldest) ?? {
              timestamp: Number.MAX_SAFE_INTEGER,
              id: "\uffff",
            };
          let remote: Awaited<
            ReturnType<typeof fetchDesktopBridgeHistoryBefore>
          >;
          for (;;) {
            const legacyMaxMessages = Math.min(
              1_000,
              desktopLegacyHistoryLimitRef.current + CHAT_TRANSCRIPT_PAGE_LIMIT,
            );
            remote = await fetchDesktopBridgeHistoryBefore({
              access: desktopAccess,
              conversationId: activeConversationId,
              beforeTimestampMs: sourceBefore.timestamp,
              beforeId: sourceBefore.id,
              maxMessages: CHAT_TRANSCRIPT_PAGE_LIMIT,
              legacyMaxMessages,
            });
            if (generation !== historyPageGenerationRef.current) return;
            if (remote.usedLegacyFallback) {
              desktopLegacyHistoryLimitRef.current = legacyMaxMessages;
            }
            const oldestRemote = desktopSourceCursorForMessage(
              remote.messages[0],
            );
            const nextSourceCursor = remote.oldestSourceCursor ?? oldestRemote;
            const cursorAdvanced = Boolean(
              nextSourceCursor &&
                (nextSourceCursor.timestamp !== sourceBefore.timestamp ||
                  nextSourceCursor.id !== sourceBefore.id),
            );
            if (nextSourceCursor) {
              sourceBefore = nextSourceCursor;
              desktopOldestSourceCursorRef.current = nextSourceCursor;
            }
            if (
              remote.messages.length > 0 ||
              !remote.hasOlder ||
              (!cursorAdvanced &&
                (!remote.usedLegacyFallback || legacyMaxMessages >= 1_000))
            ) {
              break;
            }
          }
          desktopHistoryExhaustedRef.current = !remote.hasOlder;
          if (remote.messages.length === 0) {
            setHasOlderMessages(remote.hasOlder);
            return;
          }
          // Include the adjacent loaded anchor so a newly fetched prefix gets
          // a stable order key before the current window instead of looking
          // like an unrelated append-only batch.
          await saveChatMessages(threadId, [
            ...remote.messages,
            ...(oldest ? [oldest] : []),
          ]);
          if (generation !== historyPageGenerationRef.current) return;
          updateMessages((current) => {
            const merged = mergeMessagesById(remote.messages, current);
            const droppedNewer = merged.length > CHAT_TRANSCRIPT_MAX_LOADED;
            const next = droppedNewer
              ? merged.slice(0, CHAT_TRANSCRIPT_MAX_LOADED)
              : merged;
            oldestLoadedCursorRef.current = next[0]
              ? chatTranscriptCursorForMessage(threadId, next[0].id)
              : null;
            newestLoadedCursorRef.current = next[next.length - 1]
              ? chatTranscriptCursorForMessage(
                  threadId,
                  next[next.length - 1]!.id,
                )
              : null;
            setHasOlderMessages(remote.hasOlder);
            setHasNewerMessages((value) => value || droppedNewer);
            return next;
          });
          return;
        }
        if (!page || page.messages.length === 0) {
          setHasOlderMessages(false);
          return;
        }
        updateMessages((current) => {
          const window = mergeOlderTranscriptPage(
            current,
            page.messages,
            CHAT_TRANSCRIPT_MAX_LOADED,
          );
          const next = window.messages;
          oldestLoadedCursorRef.current = next[0]
            ? chatTranscriptCursorForMessage(threadId, next[0].id)
            : null;
          newestLoadedCursorRef.current = next[next.length - 1]
            ? chatTranscriptCursorForMessage(
                threadId,
                next[next.length - 1]!.id,
              )
            : null;
          if (isDesktop) {
            desktopOldestSourceCursorRef.current =
              desktopSourceCursorForMessage(next[0]);
          }
          setHasOlderMessages(
            page.hasOlder || (isDesktop && !desktopHistoryExhaustedRef.current),
          );
          setHasNewerMessages(
            (value) => value || page.hasNewer || window.droppedNewer,
          );
          return next;
        });
      } catch {
        // Keep the page available for retry after transient storage/bridge
        // failures; scroll callbacks must never surface an unhandled promise.
      } finally {
        setHistoryPageLoading(false);
      }
    })();
    historyPageRunRef.current = run;
    void run.finally(() => {
      if (historyPageRunRef.current === run) historyPageRunRef.current = null;
    });
    return run;
  }, [desktopAccess, isDesktop, threadId]);

  const loadNewerMessages = useCallback(async (): Promise<void> => {
    if (sendingRef.current) return;
    if (historyPageRunRef.current) return historyPageRunRef.current;
    const after = newestLoadedCursorRef.current;
    if (!after) {
      setHasNewerMessages(false);
      return;
    }
    const generation = historyPageGenerationRef.current;
    const run = (async () => {
      setHistoryPageLoading(true);
      try {
        const page = await loadNewerChatMessages(threadId, after);
        if (generation !== historyPageGenerationRef.current) return;
        if (page.messages.length === 0) {
          setHasNewerMessages(false);
          return;
        }
        updateMessages((current) => {
          const window = mergeNewerTranscriptPage(
            current,
            page.messages,
            CHAT_TRANSCRIPT_MAX_LOADED,
          );
          const next = window.messages;
          oldestLoadedCursorRef.current = next[0]
            ? chatTranscriptCursorForMessage(threadId, next[0].id)
            : null;
          newestLoadedCursorRef.current = next[next.length - 1]
            ? chatTranscriptCursorForMessage(
                threadId,
                next[next.length - 1]!.id,
              )
            : null;
          setHasOlderMessages(
            (value) => value || page.hasOlder || window.droppedOlder,
          );
          setHasNewerMessages(page.hasNewer);
          return next;
        });
      } catch {
        // Leave hasNewerMessages intact so the user can retry the page.
      } finally {
        setHistoryPageLoading(false);
      }
    })();
    historyPageRunRef.current = run;
    void run.finally(() => {
      if (historyPageRunRef.current === run) historyPageRunRef.current = null;
    });
    return run;
  }, [threadId]);

  // ─── Hydration & persistence ─────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    const generation = historyPageGenerationRef.current;
    setHydrationAuthorityIssue(null);
    const transcript = hydrateLocalTranscript
      ? loadRecentChatMessages(threadId)
      : Promise.resolve({
          messages: [] as ChatMessage[],
          oldestCursor: null,
          newestCursor: null,
          hasOlder: false,
          hasNewer: false,
        });
    const sync = hydrateLocalTranscript
      ? loadChatSyncState(threadId)
      : Promise.resolve({
          conversationId: canonicalConversationId,
          cursor: null,
        });
    void Promise.all([
      transcript,
      sync,
      loadDesktopChatOutbox(threadId, canonicalOutboxAuthority),
    ]).then(
      ([page, syncState, storedOutbox]) => {
        if (!active || generation !== historyPageGenerationRef.current) return;
        syncConversationIdRef.current = syncState.conversationId;
        setConversationId(
          canonicalConversationId ??
            (isDesktop ? (syncState.conversationId ?? null) : threadId),
        );
        syncCursorRef.current = syncState.cursor;
        // Heal any linked-row/unlinked-twin duplicates persisted by builds that
        // could pull mid-send (see `collapseLinkedDuplicates`) — the damaged
        // transcript would otherwise render the duplicate until a delta arrives.
        const healed = restoreOutboxMessages(
          collapseLinkedDuplicates(page.messages),
          storedOutbox,
        );
        oldestLoadedCursorRef.current = page.oldestCursor;
        newestLoadedCursorRef.current = page.newestCursor;
        desktopOldestSourceCursorRef.current = isDesktop
          ? desktopSourceCursorForMessage(healed[0])
          : null;
        setHasOlderMessages(page.hasOlder || isDesktop);
        setHasNewerMessages(page.hasNewer);
        updateMessages(healed);
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
            ...(canonicalJournal
              ? {
                  canonicalAuthorityLease: canonicalAuthorityLeaseRef.current,
                }
              : {}),
            ...(stored?.cancelRequestId
              ? { cancelRequestId: stored.cancelRequestId }
              : {}),
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
        if (pendingSends.length > 0 && admissionEnabledRef.current) {
          drainQueueRef.current?.();
        }
      },
      () => {
        if (!active || generation !== historyPageGenerationRef.current) return;
        setStorageLoaded(false);
        if (canonicalJournal) {
          setHydrationAuthorityIssue({
            message:
              "Stella could not verify pending cloud messages on this device. Try again.",
            retryable: true,
            retry: retryHydration,
          });
        }
      },
    );
    return () => {
      active = false;
      historyPageGenerationRef.current += 1;
    };
  }, [
    canonicalJournal,
    canonicalConversationId,
    canonicalOutboxAuthority,
    hydrationRetryGeneration,
    hydrateLocalTranscript,
    isDesktop,
    retryHydration,
    threadId,
    updateMessages,
  ]);

  const refreshLoadedCursors = useCallback(
    (snapshot: ChatMessage[]) => {
      const first = snapshot[0];
      const last = snapshot[snapshot.length - 1];
      if (first) {
        oldestLoadedCursorRef.current = chatTranscriptCursorForMessage(
          threadId,
          first.id,
        );
        if (isDesktop) {
          desktopOldestSourceCursorRef.current =
            desktopSourceCursorForMessage(first);
        }
      }
      if (last) {
        newestLoadedCursorRef.current = chatTranscriptCursorForMessage(
          threadId,
          last.id,
        );
      }
    },
    [isDesktop, threadId],
  );

  const refreshLoadedCursorsIfCurrent = useCallback(
    (snapshot: ChatMessage[]) => {
      const current = messagesRef.current;
      if (
        current[0]?.id !== snapshot[0]?.id ||
        current[current.length - 1]?.id !== snapshot[snapshot.length - 1]?.id
      ) {
        return;
      }
      refreshLoadedCursors(snapshot);
    },
    [refreshLoadedCursors],
  );

  // Debounce persistence so streaming (which mutates one row many times a
  // second) doesn't write on every chunk. Referentially changed rows plus one
  // ordering anchor on each side form the batch; a streaming frame therefore
  // serializes about three rows, not the rendered window or durable history.
  const pendingSaveRef = useRef<ChatMessage[] | null>(null);
  const pendingSaveIdsRef = useRef(new Set<string>());
  const observedMessagesRef = useRef(new Map<string, ChatMessage>());
  const persistenceThreadRef = useRef(threadId);
  const persistenceGenerationRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMessageChangeAtRef = useRef(0);
  useEffect(() => {
    if (!storageLoaded || !persistLocalTranscript) return;
    if (persistenceThreadRef.current !== threadId) {
      persistenceThreadRef.current = threadId;
      persistenceGenerationRef.current += 1;
      rewindInProgressRef.current = false;
      pendingSaveIdsRef.current.clear();
      observedMessagesRef.current.clear();
    }
    const observed = observedMessagesRef.current;
    for (const message of messages) {
      if (observed.get(message.id) !== message) {
        pendingSaveIdsRef.current.add(message.id);
      }
    }
    observedMessagesRef.current = new Map(
      messages.map((message) => [message.id, message]),
    );
    pendingSaveRef.current = messages;
    lastMessageChangeAtRef.current = Date.now();
    // Arm once instead of re-arming per frame. If more text lands while the
    // timer is out, re-sleep the remainder rather than writing early.
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
        const changedIds = new Set(pendingSaveIdsRef.current);
        for (const id of changedIds) pendingSaveIdsRef.current.delete(id);
        const changed = selectIncrementalPersistenceRows(snapshot, changedIds);
        if (changed.length === 0) return;
        const persistenceGeneration = persistenceGenerationRef.current;
        void saveChatMessages(threadId, changed)
          .then(async () => {
            if (persistenceGeneration !== persistenceGenerationRef.current) {
              return;
            }
            if (threadId === "cloud") await indexMessages(changed);
            refreshLoadedCursorsIfCurrent(snapshot);
          })
          .catch(() => {
            if (
              persistenceThreadRef.current !== threadId ||
              persistenceGeneration !== persistenceGenerationRef.current
            ) {
              return;
            }
            for (const id of changedIds) pendingSaveIdsRef.current.add(id);
            pendingSaveRef.current ??= snapshot;
            lastMessageChangeAtRef.current = Date.now();
            if (saveTimerRef.current === null) arm(PERSIST_DEBOUNCE_MS);
          });
      }, delayMs);
    };
    arm(PERSIST_DEBOUNCE_MS);
  }, [
    messages,
    persistLocalTranscript,
    refreshLoadedCursorsIfCurrent,
    storageLoaded,
    threadId,
  ]);

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
    if (threadId !== "cloud" || !persistLocalTranscript) return;
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const initialize = () => {
      void initMessageIndex().catch(() => {
        if (!active) return;
        retryTimer = setTimeout(initialize, 5_000);
      });
    };
    initialize();
    return () => {
      active = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [persistLocalTranscript, threadId]);

  // Flush the debounced write on unmount/thread change — dropping it loses
  // the whole in-flight turn for threads with no other source of truth
  // (CarPlay remounts the hook whenever the voice target flips).
  useEffect(() => {
    const pendingSaveIds = pendingSaveIdsRef.current;
    return () => {
      if (!persistLocalTranscript) return;
      const pending = pendingSaveRef.current;
      if (pending) {
        pendingSaveRef.current = null;
        const changedIds = new Set(pendingSaveIds);
        for (const id of changedIds) pendingSaveIds.delete(id);
        const changed = selectIncrementalPersistenceRows(pending, changedIds);
        const persistenceGeneration = persistenceGenerationRef.current;
        void saveChatMessages(threadId, changed)
          .then(async () => {
            if (persistenceGeneration !== persistenceGenerationRef.current) {
              return;
            }
            if (threadId === "cloud") await indexMessages(changed);
            refreshLoadedCursorsIfCurrent(pending);
          })
          .catch(() => {});
      }
    };
  }, [persistLocalTranscript, refreshLoadedCursorsIfCurrent, threadId]);

  // Mirror of `sending` for reads outside render — notably the mid-send gate
  // in `runDesktopSync` and the push handler below. The ref is written
  // SYNCHRONOUSLY by `markSending` at every transition (the effect below is
  // only a belt-and-braces reconciler): the gate is consulted by imperative
  // callers (focus/AppState resume, Force Sync) that can run in the gap
  // between `setSending(true)` and its commit, and a ref updated only by an
  // effect would let those slip a mid-send pull through.
  const sendingRef = useRef(false);
  const rewindInProgressRef = useRef(false);
  const indexRebuildRetryTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const markSending = useCallback((next: boolean) => {
    sendingRef.current = next;
    setSending(next);
  }, []);
  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);
  useEffect(
    () => () => {
      if (indexRebuildRetryTimerRef.current !== null) {
        clearTimeout(indexRebuildRetryTimerRef.current);
        indexRebuildRetryTimerRef.current = null;
      }
    },
    [],
  );
  const scheduleMessageIndexRecovery = useCallback(() => {
    if (indexRebuildRetryTimerRef.current !== null) return;
    const retry = () => {
      indexRebuildRetryTimerRef.current = setTimeout(() => {
        indexRebuildRetryTimerRef.current = null;
        void initMessageIndex().catch(retry);
      }, 5_000);
    };
    retry();
  }, []);

  // A pull blocked by the mid-send gate is remembered here — never dropped —
  // and flushed once the send settles (the effect below the push socket).
  const pendingPushSyncRef = useRef<{ catchUp: boolean } | null>(null);
  const deferDesktopSync = useCallback((catchUp: boolean) => {
    pendingPushSyncRef.current = mergeDeferredDesktopSyncIntent(
      pendingPushSyncRef.current,
      catchUp,
    );
  }, []);

  useEffect(
    () =>
      subscribeChatStorageCleanup(() => {
        // Account cleanup may run while tab routes remain mounted. Invalidate
        // every producer before storage deletes so an old hydration, page,
        // stream, debounce, or desktop sync cannot repopulate cleared data.
        persistenceGenerationRef.current += 1;
        historyPageGenerationRef.current += 1;
        syncGenerationRef.current += 1;
        dispatchGenerationRef.current += 1;
        steerPumpGenerationRef.current += 1;
        if (saveTimerRef.current !== null) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        pendingSaveRef.current = null;
        pendingSaveIdsRef.current.clear();
        observedMessagesRef.current.clear();
        historyPageRunRef.current = null;
        pendingPushSyncRef.current = null;
        pendingReconcileRef.current = null;
        queueRef.current = [];
        for (const id of pendingEnqueueRef.current) {
          stoppedDispatchIdsRef.current.add(id);
        }
        pendingEnqueueRef.current.clear();
        const activeDispatch = activeDispatchRef.current;
        if (activeDispatch) {
          stoppedDispatchIdsRef.current.add(activeDispatch.dispatchId);
          activeDispatch.abort.abort();
        }
        activeDispatchRef.current = null;
        acceptedDesktopSendIdsRef.current.clear();
        closeDesktopBridgeSendBatch(desktopSendBatchRef.current);
        desktopSendBatchRef.current = null;
        oldestLoadedCursorRef.current = null;
        newestLoadedCursorRef.current = null;
        desktopOldestSourceCursorRef.current = null;
        desktopHistoryExhaustedRef.current = false;
        desktopLegacyHistoryLimitRef.current = HISTORY_MESSAGE_LIMIT;
        syncCursorRef.current = null;
        syncConversationIdRef.current = null;
        messagesRef.current = [];
        rewindInProgressRef.current = false;
        if (isDesktop) desktopTransportEnabledRef.current = false;
        markSending(false);
        setHistoryPageLoading(false);
        setHasOlderMessages(false);
        setHasNewerMessages(false);
        updateMessages([]);
        setConversationId(isDesktop ? null : threadId);
        setDraft("");
        setAttachments([]);
        setQuotes([]);
        setWorkingActivity(IDLE_WORKING_ACTIVITY);
        setDesktopThreadTasks(null);
        setDesktopTaskDecoration(null);
        setLivePushConnected(false);
      }),
    [isDesktop, markSending, threadId],
  );

  const persistSyncState = useCallback(
    async (state: {
      conversationId?: string | null;
      cursor?: string | null;
    }): Promise<void> => {
      const conversationId =
        canonicalConversationId ?? state.conversationId?.trim() ?? null;
      const cursor = state.cursor?.trim() || null;
      syncConversationIdRef.current = conversationId;
      setConversationId(conversationId);
      syncCursorRef.current = cursor;
      if (!persistLocalTranscript) return;
      await saveChatSyncState(threadId, { conversationId, cursor });
    },
    [canonicalConversationId, persistLocalTranscript, threadId],
  );

  const persistDesktopMerge = useCallback(
    (merge: (current: ChatMessage[]) => ChatMessage[]) => {
      const persistenceGeneration = persistenceGenerationRef.current;
      return enqueueSerializedChatPersistence(
        desktopMergeQueueRef.current,
        async () => {
          // A cleanup/thread reset can invalidate work while an earlier merge
          // owns the queue. Do not let this queued closure republish its stale
          // desktop page after the reset has synchronously emptied refs/UI.
          if (persistenceGeneration !== persistenceGenerationRef.current) {
            return { messages: messagesRef.current, droppedOlder: false };
          }
          return persistBoundedTranscriptMerge({
            getCurrent: () => messagesRef.current,
            setCurrent: (messages) => {
              messagesRef.current = messages;
            },
            getPending: () => pendingSaveRef.current,
            setPending: (messages) => {
              pendingSaveRef.current = messages;
            },
            merge,
            maxLoaded: CHAT_TRANSCRIPT_MAX_LOADED,
            saveChanged: (messages) => saveChatMessages(threadId, messages),
            isCurrent: () =>
              persistenceGeneration === persistenceGenerationRef.current,
          });
        },
      );
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
      void acknowledgeDesktopChatOutbox(
        threadId,
        ids,
        canonicalOutboxAuthority,
      ).catch(() => {});
    },
    [canonicalOutboxAuthority, threadId],
  );

  // ─── Desktop transcript sync ─────────────────────────────────────────────
  // Coalesced wake + pull + merge. Concurrent callers (the landing sync and a
  // send) share one in-flight run so the desktop is woken and the existing
  // transcript reconciled exactly once, never twice racing each other. A send
  // awaits this before it streams, giving a strict wake → sync → send order so
  // a landing sync can't land its merge in the middle of an active turn.
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
      if (!desktopTransportEnabledRef.current) {
        return Promise.resolve({ offline: true });
      }
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
      const staleGeneration = Symbol("stale desktop sync generation");
      let continueAfterRun = false;
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
          // Catch-up pulls keep a valid durable cursor. The desktop validates
          // it and either serves the missing suffix in bounded forward pages or
          // returns one bounded recovery snapshot for an invalid cursor.
          plan = desktopSyncPullPlan({
            catchUp,
            expectedConversationId,
            cursor: syncCursorRef.current,
          });
          let persistedMessages = messagesRef.current;
          let droppedOlder = false;
          let preparedSend: DesktopBridgeSendBatch | undefined;
          const acceptedUserMessageIds = new Set<string>();
          let resetApplied = false;
          let legacyRecoverySnapshot = false;
          const pullDesktopPage = (pageCursor: string | null) =>
            syncDesktopBridgeChatMessages({
              access: desktopAccess,
              expectedConversationId,
              sinceCursor: pageCursor,
              maxMessages: HISTORY_MESSAGE_LIMIT,
            });
          const consumeDesktopPage = async (
            next: Awaited<ReturnType<typeof pullDesktopPage>>,
          ) => {
            if (generation !== syncGenerationRef.current) {
              throw staleGeneration;
            }
            const resetRequired =
              !resetApplied &&
              (next.conversationChanged || next.cursorStatus === "invalid");
            if (resetRequired) {
              // The cursor no longer names durable desktop history (rewind,
              // conversation replacement, or malformed local state). Drop
              // the stale mobile projection before committing the desktop's
              // bounded recovery snapshot. Older rows remain pageable from
              // the desktop source of truth.
              resetApplied = true;
              persistenceGenerationRef.current += 1;
              if (saveTimerRef.current !== null) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
              }
              pendingSaveRef.current = null;
              pendingSaveIdsRef.current.clear();
              observedMessagesRef.current.clear();
              messagesRef.current = [];
              await clearChatMessages(threadId);
              oldestLoadedCursorRef.current = null;
              newestLoadedCursorRef.current = null;
              desktopOldestSourceCursorRef.current = null;
              desktopHistoryExhaustedRef.current = false;
            }
            const persistedMerge = await persistDesktopMerge((current) =>
              mergeMessagesById(current, next.messages),
            );
            if (generation !== syncGenerationRef.current) {
              throw staleGeneration;
            }
            persistedMessages = persistedMerge.messages;
            droppedOlder ||= persistedMerge.droppedOlder;
            refreshLoadedCursors(persistedMessages);
            await persistSyncState({
              conversationId: next.conversationId,
              cursor: next.cursor,
            });
            if (generation !== syncGenerationRef.current) {
              throw staleGeneration;
            }
            closeDesktopBridgeSendBatch(desktopSendBatchRef.current);
            desktopSendBatchRef.current = next.preparedSend;
            preparedSend = next.preparedSend;
            for (const message of next.messages) {
              if (message.role === "user") {
                acceptedUserMessageIds.add(message.id);
              }
            }
            acknowledgeDesktopSendIds(acceptedUserMessageIds);
            if (
              (plan.fullWindow || legacyRecoverySnapshot || resetRequired) &&
              next.messages.length >= HISTORY_MESSAGE_LIMIT
            ) {
              setHasOlderMessages(true);
            }
          };
          let pageRun = await drainDesktopSyncPages({
            initialCursor: plan.sinceCursor,
            pageSize: HISTORY_MESSAGE_LIMIT,
            pull: pullDesktopPage,
            consume: consumeDesktopPage,
          });
          let totalPages = pageRun.pages;
          let totalRows = pageRun.rows;
          if (
            shouldUseLegacySyncRecoverySnapshot({
              catchUp,
              initialCursor: plan.sinceCursor,
              cursorStatus: pageRun.lastPage.cursorStatus,
              rows: pageRun.rows,
            })
          ) {
            // Pre-pagination desktops cannot validate old timestamp cursors.
            // Preserve their poisoned-cursor healing as a compatibility path,
            // but only after the cursor delta came back empty. Any actual
            // missing suffix therefore stays on the one-request fast path.
            legacyRecoverySnapshot = true;
            pageRun = await drainDesktopSyncPages({
              initialCursor: null,
              pageSize: HISTORY_MESSAGE_LIMIT,
              pull: pullDesktopPage,
              consume: consumeDesktopPage,
            });
            totalPages += pageRun.pages;
            totalRows += pageRun.rows;
          }
          continueAfterRun = pageRun.continuationNeeded;
          updateMessages(() => {
            const bounded = persistedMessages;
            desktopOldestSourceCursorRef.current =
              desktopSourceCursorForMessage(bounded[0]);
            if (droppedOlder) {
              setHasOlderMessages(true);
              setHasNewerMessages(false);
            }
            return bounded;
          });
          if (!sendingRef.current && queueRef.current.length > 0) {
            queueMicrotask(() => drainQueueRef.current?.());
          }
          recordSyncDiagnostic({
            at: Date.now(),
            trigger,
            catchUp,
            sinceCursor: plan.sinceCursor,
            fullWindow: plan.fullWindow || legacyRecoverySnapshot,
            outcome: "ok",
            rows: totalRows,
            pages: totalPages,
            cursorOut: pageRun.lastPage.cursor,
            conversationChanged: pageRun.lastPage.conversationChanged,
            cursorStatus: pageRun.lastPage.cursorStatus,
            continuationNeeded: pageRun.continuationNeeded,
            durationMs: Date.now() - startedAt,
          });
          return {
            offline: false,
            rows: totalRows,
            acceptedUserMessageIds: [...acceptedUserMessageIds],
            preparedSend,
          };
        } catch (error) {
          if (error === staleGeneration) {
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
            if (continueAfterRun) {
              queueMicrotask(() => {
                if (
                  generation === syncGenerationRef.current &&
                  desktopTransportEnabledRef.current
                ) {
                  void runDesktopSyncRef.current({
                    catchUp: true,
                    trigger: `${trigger}-continue`,
                  });
                }
              });
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
      persistDesktopMerge,
      persistSyncState,
      refreshLoadedCursors,
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
    // Catch-up: the phone may have been away arbitrarily long. Preserve its
    // durable cursor and drain bounded suffix pages while the pill covers it.
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
    if (!desktopAccess || !desktopTransportEnabledRef.current) return;
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
        if (
          threadTasksFetchRef.current !== state ||
          !desktopTransportEnabledRef.current
        ) {
          return;
        }
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
        if (!desktopTransportEnabledRef.current) return;
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
        if (!desktopTransportEnabledRef.current) return;
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
      onTaskDecorationUpdated: (decoration) => {
        if (desktopTransportEnabledRef.current) {
          setDesktopTaskDecoration(decoration);
        }
      },
      onConnectedChange: (connected, details) => {
        if (!desktopTransportEnabledRef.current) return;
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
  // the redundant empty delta that previously followed every streamed reply.
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
   * Append one whole assistant text block to the optimistic reply. Assistant
   * text is never streamed, so each call carries a complete segment; separate
   * segments of the same turn (preamble → tool → answer) read as paragraphs.
   */
  const appendAssistantSegment = useCallback(
    (replyId: string, segment: string) => {
      if (!segment) return;
      updateMessages((m) =>
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
          updateMessages((current) =>
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
    if (!persistLocalTranscript) return;
    updateMessages((current) => {
      const observed = observedMessagesRef.current;
      for (const message of current) {
        if (observed.get(message.id) !== message) {
          pendingSaveIdsRef.current.add(message.id);
        }
      }
      const changedIds = new Set(pendingSaveIdsRef.current);
      for (const id of changedIds) pendingSaveIdsRef.current.delete(id);
      const changed = selectIncrementalPersistenceRows(current, changedIds);
      const persistenceGeneration = persistenceGenerationRef.current;
      void saveChatMessages(threadId, changed)
        .then(async () => {
          if (persistenceGeneration !== persistenceGenerationRef.current) {
            return;
          }
          if (threadId === "cloud") await indexMessages(changed);
          refreshLoadedCursorsIfCurrent(current);
        })
        .catch(() => {});
      return current;
    });
  }, [persistLocalTranscript, refreshLoadedCursorsIfCurrent, threadId]);

  // ─── Cloud dispatch ───────────────────────────────────────────────────────
  const dispatchCloud = useCallback(
    async (item: QueuedSend, replyId: string, abort: AbortController) => {
      const guest = transport.kind === "guest";
      // The offline tool + memory + compaction layer is scoped to the plain
      // offline chat (the "cloud" Chat tab, guest or signed-in). Other cloud
      // surfaces that ride the same send pipeline (the CarPlay voice loop)
      // keep the lean text-only behaviour.
      const toolsEnabled = threadId === "cloud" && guest;
      const queuedIds = new Set(queueRef.current.map((q) => q.userMessageId));
      // Paging may leave the rendered window on an older slice. Context must
      // always come from the canonical durable recent tail, with current
      // optimistic rows overlaid, rather than whichever slice is on screen.
      const durableRecent = toolsEnabled
        ? await loadRecentChatMessages(
            threadId,
            CHAT_TRANSCRIPT_MAX_LOADED,
          ).catch(() => null)
        : null;
      const contextRows = durableRecent
        ? mergeMessagesById(durableRecent.messages, messagesRef.current).slice(
            -CHAT_TRANSCRIPT_MAX_LOADED,
          )
        : messagesRef.current;
      const priorMessages = contextRows.filter(
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
        updateMessages((messages) =>
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
        updateMessages((m) =>
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
        operationId: string,
      ): Promise<string> => {
        let acc = "";
        await streamFn(
          OFFLINE_CHAT_STREAM_PATH,
          buildOfflineChatRequest({
            turnId: item.userMessageId,
            operationId,
            message: prompt,
            history,
            images: [],
          }),
          (delta) => {
            acc += delta;
          },
          streamOptions,
        );
        return acc;
      };

      // Map- and PDF-tool failures, surfaced on the reply after the answer
      // finishes streaming so the note lands after the streamed text (below).
      const mapErrors: string[] = [];
      const pdfErrors: string[] = [];
      const upsertToolStep = (
        step: NonNullable<ChatMessage["toolSteps"]>[number],
      ) => {
        updateMessages((current) =>
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
        updateMessages((current) =>
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
        updateMessages((current) =>
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
      ) => {
        const outcome = await resolveMap(call);
        if (!outcome.ok) {
          // Don't drop the failure silently: the model already told the user a
          // map was coming, so a missing card with no explanation is confusing.
          mapErrors.push(outcome.error);
          upsertToolStep({
            id: toolCallId,
            toolName: "map",
            status: "error",
            args: { title: call.title ?? "Map" },
            textOffset,
          });
          return;
        }
        const artifact = mapArtifactFor(
          outcome.result.payload,
          OFFLINE_ARTIFACT_CONVERSATION_ID,
          0,
        );
        removeToolStep(toolCallId);
        upsertArtifact({ ...artifact, id: toolCallId, textOffset });
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
      ) => {
        const outcome = await generatePdf(call);
        if (!outcome.ok) {
          // The model already told the user a PDF was coming, so a missing file
          // with no explanation is confusing — surface the failure.
          pdfErrors.push(outcome.error);
          upsertToolStep({
            id: toolCallId,
            toolName: "pdf",
            status: "error",
            args: { title: call.title ?? "PDF" },
            textOffset,
          });
          return;
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
      };

      const applyImageTool = async (
        call: { prompt: string; aspectRatio?: string; numImages?: number },
        toolCallId: string,
        textOffset: number,
      ) => {
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
        }
      };

      try {
        if (!toolsEnabled) {
          // Lean path: whole reply blocks, no memory/tools/compaction.
          await streamFn(
            OFFLINE_CHAT_STREAM_PATH,
            buildOfflineChatRequest({
              turnId: item.userMessageId,
              operationId: "answer:0",
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
        // is over budget, then build the primed context turn.
        const [memoryFacts, existingCheckpoint] = await Promise.all([
          loadMemoryFacts(),
          loadCheckpoint(),
        ]);
        let checkpoint = existingCheckpoint;
        try {
          // The old AsyncStorage format could contain 1,000 rows while normal
          // hydration deliberately loads only the recent window. Seed a
          // missing checkpoint oldest-first in bounded batches so migration
          // never silently skips the prefix. A pending marker means the app
          // was killed mid-bootstrap; resume after its durable watermark.
          if (durableRecent?.hasOlder) {
            let bootstrapPending = checkpoint?.bootstrapPending === true;
            let page = null as Awaited<
              ReturnType<typeof loadOldestChatMessages>
            > | null;
            const checkpointWatermark = checkpoint
              ? (checkpoint.coveredThroughId ??
                checkpoint.coveredIds[checkpoint.coveredIds.length - 1])
              : undefined;
            if (!checkpoint) {
              bootstrapPending = true;
              page = await loadOldestChatMessages(
                threadId,
                CHAT_TRANSCRIPT_MAX_LOADED,
              );
            } else if (
              checkpointWatermark &&
              (bootstrapPending ||
                !priorMessages.some(
                  (message) => message.id === checkpointWatermark,
                ))
            ) {
              // More than one rendered window can arrive after an existing
              // checkpoint. Resume exactly after its durable watermark rather
              // than summarizing only the recent window and silently skipping
              // the intervening rows. A missing watermark makes the checkpoint
              // unverifiable, so restart the crash-safe oldest-first bootstrap.
              const coveredCursor = await findChatMessageCursor(
                threadId,
                checkpointWatermark,
              );
              if (coveredCursor) {
                page = await loadNewerChatMessages(
                  threadId,
                  coveredCursor,
                  CHAT_TRANSCRIPT_PAGE_LIMIT * 4,
                );
              } else {
                await clearCheckpoint();
                checkpoint = null;
                bootstrapPending = true;
                page = await loadOldestChatMessages(
                  threadId,
                  CHAT_TRANSCRIPT_MAX_LOADED,
                );
              }
            } else if (bootstrapPending) {
              await clearCheckpoint();
              checkpoint = null;
              page = await loadOldestChatMessages(
                threadId,
                CHAT_TRANSCRIPT_MAX_LOADED,
              );
            }
            if (page) {
              let rolling = page.messages.filter(
                (message) => !message.queued && message.text.trim().length > 0,
              );
              while (true) {
                while (planCompaction(rolling, checkpoint)) {
                  const priorWatermark = checkpoint?.coveredThroughId;
                  const updated = await runCompaction({
                    messages: rolling,
                    checkpoint,
                    summarize: (prompt) =>
                      complete(
                        prompt,
                        [],
                        `compact:bootstrap:${rolling[0]?.id ?? "empty"}:${rolling[rolling.length - 1]?.id ?? "empty"}:${priorWatermark ?? "root"}`,
                      ),
                    bootstrapPending,
                  });
                  if (!updated || updated.coveredThroughId === priorWatermark) {
                    throw new Error(
                      "Could not finish durable history compaction",
                    );
                  }
                  checkpoint = updated;
                }
                if (!page.hasNewer || !page.newestCursor) break;
                rolling = uncoveredMessages(rolling, checkpoint);
                page = await loadNewerChatMessages(
                  threadId,
                  page.newestCursor,
                  CHAT_TRANSCRIPT_PAGE_LIMIT * 4,
                );
                rolling.push(
                  ...page.messages.filter(
                    (message) =>
                      !message.queued && message.text.trim().length > 0,
                  ),
                );
              }
              if (checkpoint && bootstrapPending) {
                const { bootstrapPending: _pending, ...completed } = checkpoint;
                checkpoint = { ...completed, updatedAt: Date.now() };
                await saveCheckpoint(checkpoint);
              }
            }
          }
          const updated = await runCompaction({
            messages: priorMessages,
            checkpoint,
            summarize: (prompt) =>
              complete(
                prompt,
                [],
                `compact:recent:${priorMessages[0]?.id ?? "empty"}:${priorMessages[priorMessages.length - 1]?.id ?? "empty"}:${checkpoint?.coveredThroughId ?? "root"}`,
              ),
          });
          if (updated) checkpoint = updated;
        } catch {
          // A partial checkpoint remains a durable contiguous prefix and can
          // resume from its watermark on the next send. Do not use it for this
          // request, though: the unsummarized gap before the recent window is
          // not yet represented, so fall back to bounded recent context.
          checkpoint = null;
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
        let toolTimelineOffset = 0;
        for (let round = 0; round < MAX_OFFLINE_TOOL_ROUNDS; round += 1) {
          const filter = createToolBlockFilter();
          // The filter holds back a few characters that could still open the
          // trailing tool block, so it splits one whole reply across `feed`
          // and `finalize`. Buffer the round and append it once: the round IS
          // the assistant text block, and appending twice would insert a
          // paragraph break inside it.
          let roundText = "";
          await streamFn(
            OFFLINE_CHAT_STREAM_PATH,
            buildOfflineChatRequest({
              turnId: item.userMessageId,
              operationId: `answer:${round}`,
              message,
              history: primedHistory,
              images: roundImages,
            }),
            (segment) => {
              // Keep the trailing tool block out of the visible reply.
              roundText += filter.feed(segment);
            },
            streamOptions,
          );
          roundText += filter.finalize();
          const roundVisibleChars = roundText.length;
          if (roundText) {
            appendAssistantSegment(replyId, roundText);
            if (/\S/.test(roundText)) patchActivity({ answerLanded: true });
          }

          const { calls } = parseToolBlock(filter.raw());
          const textOffset = toolTimelineOffset + roundVisibleChars;
          toolTimelineOffset = textOffset;
          const recalls: { query: string }[] = [];
          const webResults: string[] = [];
          const indexedCalls = calls.map((call, index) => ({
            call,
            toolCallId: `${replyId}:tool:${round}:${index}`,
          }));
          for (const { call, toolCallId } of indexedCalls) {
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
          for (const { call, toolCallId } of indexedCalls) {
            if (call.tool === "remember") {
              try {
                await rememberFact(call.key, call.value);
                upsertToolStep({
                  id: toolCallId,
                  toolName: "remember",
                  status: "completed",
                  args: { title: call.key },
                  textOffset,
                });
              } catch {
                upsertToolStep({
                  id: toolCallId,
                  toolName: "remember",
                  status: "error",
                  args: { title: call.key },
                  textOffset,
                });
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
              } catch {
                upsertToolStep({
                  id: toolCallId,
                  toolName: "forget",
                  status: "error",
                  textOffset,
                });
              }
            } else if (call.tool === "map") {
              await applyMapTool(call, toolCallId, textOffset);
            } else if (call.tool === "pdf") {
              await applyPdfTool(call, toolCallId, textOffset);
            } else if (call.tool === "recall") {
              recalls.push({ query: call.query });
              upsertToolStep({
                id: toolCallId,
                toolName: "recall",
                status: "completed",
                args: { query: call.query },
                textOffset,
              });
            } else if (call.tool === "web") {
              const webArgs = {
                ...(call.query ? { query: call.query } : {}),
                ...(call.url ? { url: call.url } : {}),
                ...(call.category ? { category: call.category } : {}),
                ...(call.prompt ? { prompt: call.prompt } : {}),
                ...(call.format ? { format: call.format } : {}),
              };
              try {
                const result = await searchChatWeb(webArgs);
                webResults.push(result.text);
                upsertToolStep({
                  id: toolCallId,
                  toolName: "web",
                  status: "completed",
                  args: webArgs,
                  textOffset,
                });
              } catch {
                upsertToolStep({
                  id: toolCallId,
                  toolName: "web",
                  status: "error",
                  args: webArgs,
                  textOffset,
                });
              }
            } else if (call.tool === "image_gen") {
              await applyImageTool(call, toolCallId, textOffset);
            }
          }

          if (
            (recalls.length === 0 && webResults.length === 0) ||
            round === MAX_OFFLINE_TOOL_ROUNDS - 1
          ) {
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
          const resultsText = [...resultParts, ...webResults].join("\n\n");
          message = `Tool results for the user's latest request:\n${resultsText}\n\nUsing these results, answer the user's latest message: "${item.text}". Do not call web or recall again.`;
          roundImages = [];
        }

        ensureFallbackReply();
        const toolErrors = [...mapErrors, ...pdfErrors];
        if (toolErrors.length > 0) {
          const note = toolErrors.join("\n");
          updateMessages((m) =>
            m.map((msg) => {
              if (msg.id !== replyId || msg.text.includes(note)) return msg;
              return {
                ...msg,
                text: msg.text ? `${msg.text}\n\n${note}` : note,
              };
            }),
          );
        }
        notifySuccess();
      } catch (e) {
        if (e instanceof StreamAbortError) {
          updateMessages((m) =>
            m.map((msg) =>
              msg.id === replyId ? { ...msg, stopped: true } : msg,
            ),
          );
        } else {
          updateMessages((m) =>
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
      updateMessages,
    ],
  );

  // ─── Server-owned automatic placement ───────────────────────────────────
  const dispatchAutomatic = useCallback(
    async (item: QueuedSend, replyId: string, abort: AbortController) => {
      const assertAuthorityLease = () => {
        if (!canonicalAuthorityLeaseCurrent(item.canonicalAuthorityLease)) {
          throw new AutomaticExecutionWaitAbortedError();
        }
      };
      const isCurrent = () =>
        canonicalAuthorityLeaseCurrent(item.canonicalAuthorityLease) &&
        (activeDispatchRef.current?.replyId === replyId ||
          stoppedDispatchIdsRef.current.has(item.dispatchId));
      const renderReply = (text: string, stopped = false) => {
        if (!isCurrent()) return;
        updateMessages((current) =>
          current.map((message) =>
            message.id === replyId
              ? { ...message, text, ...(stopped ? { stopped: true } : {}) }
              : message,
          ),
        );
      };

      // The v1 placement envelope is intentionally text-only. Never strip an
      // attachment and silently execute a materially different request.
      if (item.assets.length > 0) {
        renderReply(
          "Automatic computer/cloud execution does not support photo attachments yet. Remove the photo and try again.",
        );
        acknowledgeDesktopSendIds([item.dispatchId, item.userMessageId]);
        finishDispatch();
        flushPersistNow();
        return;
      }

      try {
        assertAuthorityLease();
        patchActivity({ statusText: "Choosing where to run" });
        let admitted: AutomaticExecutionDispatch | null = null;
        let placementConversationId = canonicalConversationId ?? "";
        let ignoreStoredAccess = false;
        while (!admitted) {
          assertAuthorityLease();
          try {
            if (!placementConversationId) {
              placementConversationId =
                await ensureAutomaticExecutionConversation({
                  threadId,
                  title: isDesktop ? "Computer" : "Chat",
                });
              assertAuthorityLease();
            }
            await persistSyncState({
              conversationId: placementConversationId,
              cursor: syncCursorRef.current,
            });
            assertAuthorityLease();
            const access =
              !ignoreStoredAccess && transport.kind === "automatic"
                ? (transport.access ??
                  (await getPreferredPhoneAccess()) ??
                  undefined)
                : undefined;
            assertAuthorityLease();
            if (canonicalJournal && !admissionEnabledRef.current) {
              patchActivity({ statusText: "Waiting for cloud history" });
              await waitForAutomaticRetry(abort.signal);
              assertAuthorityLease();
              continue;
            }
            admitted = await submitAutomaticExecution({
              idempotencyKey: item.dispatchId,
              conversationId: placementConversationId,
              kind: "chat",
              prompt: item.text,
              ...(isDesktop ? { workspace: "computer" } : {}),
              requiredCapabilities: isDesktop
                ? ["chat", "computer-use"]
                : ["chat"],
              ...(access ? { access } : {}),
            });
            assertAuthorityLease();
          } catch (error) {
            if (
              error instanceof AutomaticExecutionWaitAbortedError ||
              abort.signal.aborted
            ) {
              throw error;
            }
            if (
              !ignoreStoredAccess &&
              isAutomaticExecutionPairCredentialRejection(error)
            ) {
              // No placement was committed: retry without the invalid grant
              // so server policy can choose cloud for portable work or return
              // an explicit computer-required failure for computer-only work.
              ignoreStoredAccess = true;
              continue;
            }
            if (isPermanentAutomaticAdmissionError(error)) throw error;
            patchActivity({ statusText: "Waiting for connection" });
            await waitForAutomaticRetry(abort.signal);
            assertAuthorityLease();
          }
        }

        assertAuthorityLease();
        const active = activeDispatchRef.current;
        if (transport.kind === "automatic") {
          transport.onAdmission?.({
            localMessageId: item.userMessageId,
            dispatchId: admitted.dispatchId,
            conversationId: placementConversationId,
          });
        }
        if (active?.replyId === replyId) {
          active.primaryAccepted = true;
          active.automaticControl = bindAutomaticExecutionAdmission(
            active.automaticControl ?? {
              clientIdempotencyKey: item.dispatchId,
            },
            admitted,
          );
        }
        let control =
          active?.automaticControl ??
          bindAutomaticExecutionAdmission(
            { clientIdempotencyKey: item.dispatchId },
            admitted,
          );
        if (
          item.cancelRequestId ||
          stoppedDispatchIdsRef.current.has(item.dispatchId)
        ) {
          control = requestAutomaticExecutionCancellation({
            ...control,
            ...(item.cancelRequestId
              ? { cancelRequestId: item.cancelRequestId }
              : {}),
          });
          if (active?.replyId === replyId) active.automaticControl = control;
        }
        const cancellation = automaticExecutionCancellationCommand(control);
        if (cancellation) {
          for (;;) {
            try {
              admitted = await cancelAutomaticExecution({
                ...cancellation,
                reason: "Stopped from the mobile conversation.",
                signal: abort.signal,
              });
              assertAuthorityLease();
              break;
            } catch (error) {
              if (
                error instanceof AutomaticExecutionWaitAbortedError ||
                abort.signal.aborted
              ) {
                throw error;
              }
              if (isPermanentAutomaticAdmissionError(error)) throw error;
              patchActivity({ statusText: "Stopping" });
              await waitForAutomaticRetry(abort.signal);
            }
          }
        }

        const terminal = await waitForAutomaticExecution({
          dispatchId: admitted.dispatchId,
          signal: abort.signal,
          beforeRead: async () => {
            const current = activeDispatchRef.current;
            if (current?.replyId !== replyId) return;
            const pendingCancellation = automaticExecutionCancellationCommand(
              current.automaticControl ?? {
                clientIdempotencyKey: item.dispatchId,
              },
            );
            if (!pendingCancellation) return;
            await cancelAutomaticExecution({
              ...pendingCancellation,
              reason: "Stopped from the mobile conversation.",
              signal: abort.signal,
            });
            assertAuthorityLease();
          },
          onUpdate: (dispatch) => {
            if (!canonicalAuthorityLeaseCurrent(item.canonicalAuthorityLease)) {
              return;
            }
            const statusText = automaticPlacementStatus(dispatch);
            if (statusText) patchActivity({ statusText });
          },
        });
        assertAuthorityLease();
        renderReply(
          automaticExecutionResultText(terminal),
          terminal.state === "canceled",
        );
        acknowledgeDesktopSendIds([item.dispatchId, item.userMessageId]);
        if (terminal.state === "completed") notifySuccess();
        finishDispatch();
        flushPersistNow();
      } catch (error) {
        if (
          error instanceof AutomaticExecutionWaitAbortedError ||
          abort.signal.aborted
        ) {
          return;
        }
        renderReply(userFacingError(error));
        // Authentication/migration/validation failures cannot become valid by
        // replaying this old account-bound outbox row after every launch.
        if (isPermanentAutomaticAdmissionError(error)) {
          acknowledgeDesktopSendIds([item.dispatchId, item.userMessageId]);
        }
        finishDispatch();
        flushPersistNow();
      }
    },
    [
      acknowledgeDesktopSendIds,
      canonicalAuthorityLeaseCurrent,
      canonicalConversationId,
      canonicalJournal,
      finishDispatch,
      flushPersistNow,
      isDesktop,
      patchActivity,
      persistSyncState,
      threadId,
      transport,
      updateMessages,
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
          updateMessages((messages) =>
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
            updateMessages((m) =>
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
            updateMessages((current) =>
              retargetOptimisticReplyToUser(current, {
                replyId,
                userMessageId: boundary.userMessageId,
              }),
            );
          },
          onStatus: (status) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            // Connection/wake copy is a run-level status; merge it without
            // disturbing the live tool flags.
            patchActivity({ statusText: WAKE_STATUS_COPY[status] });
          },
          onActivity: (activity: DesktopBridgeActivity) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            // The bridge already folded the tool/message events into a settled
            // snapshot; adopt it wholesale so the indicator tracks the run.
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
            updateMessages((m) =>
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
          updateMessages((m) =>
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
        updateMessages((m) => {
          let changed = false;
          const next = m.map((msg) => {
            if (msg.id === replyId) {
              // Finalize IN PLACE: keep the streamed text (same string
              // reference) whenever it already covers the turn's final text,
              // so the reply that just streamed doesn't get rewritten — and
              // its markdown re-rendered/re-animated — at end of turn.
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
          .then(async (delta) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            if (reconcileGeneration !== syncGenerationRef.current) return;
            const mergeReconciled = (current: ChatMessage[]) =>
              responseUserMessageId === item.userMessageId
                ? reconcileSentDesktopTurn({
                    current,
                    userMessageId: item.userMessageId,
                    replyId,
                    sentText: item.promptText ?? item.text,
                    canonicalMessages: delta.messages,
                    ...(canonicalUserMessageId
                      ? { canonicalUserMessageId }
                      : {}),
                  })
                : mergeMessagesById(current, delta.messages);
            const persistedMerge = await persistDesktopMerge(mergeReconciled);
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            if (reconcileGeneration !== syncGenerationRef.current) return;
            refreshLoadedCursors(persistedMerge.messages);
            await persistSyncState({
              conversationId: delta.conversationId,
              cursor: delta.cursor,
            });
            if (reconcileGeneration !== syncGenerationRef.current) return;
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
            updateMessages(persistedMerge.messages);
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
          updateMessages((m) =>
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
        updateMessages((m) =>
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
      persistDesktopMerge,
      replaceActivity,
      persistSyncState,
      refreshLoadedCursors,
      runDesktopSync,
    ],
  );

  // ─── Queue & dispatch ─────────────────────────────────────────────────────
  const parkQueuedSend = useCallback(
    (item: QueuedSend) => {
      if (
        !queueRef.current.some(
          (queued) => queued.dispatchId === item.dispatchId,
        )
      ) {
        queueRef.current.push(item);
        queueRef.current.sort(
          (a, b) =>
            (a.queueSequence ?? Number.MAX_SAFE_INTEGER) -
            (b.queueSequence ?? Number.MAX_SAFE_INTEGER),
        );
      }
      updateMessages((current) =>
        current.map((message) =>
          message.id === item.userMessageId
            ? { ...message, queued: true }
            : message,
        ),
      );
    },
    [updateMessages],
  );

  const dispatch = useCallback(
    async (item: QueuedSend) => {
      if (!canonicalAuthorityLeaseCurrent(item.canonicalAuthorityLease)) {
        return;
      }
      if (canonicalJournal && !admissionEnabledRef.current) {
        parkQueuedSend(item);
        markSending(false);
        setWorkingActivity(IDLE_WORKING_ACTIVITY);
        return;
      }
      const replyId = createId();
      const abort = new AbortController();
      dispatchGenerationRef.current += 1;
      activeDispatchRef.current = {
        dispatchId: item.dispatchId,
        ...(transport.kind === "automatic"
          ? {
              automaticControl: {
                clientIdempotencyKey: item.dispatchId,
                ...(item.cancelRequestId
                  ? { cancelRequestId: item.cancelRequestId }
                  : {}),
              },
            }
          : {}),
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
      updateMessages((m) => {
        const next = [
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
            requestId: item.userMessageId,
            text: "",
            createdAt: dispatchedAt,
          },
        ];
        if (next.length <= CHAT_TRANSCRIPT_MAX_LOADED) return next;
        setHasOlderMessages(true);
        setHasNewerMessages(false);
        return next.slice(-CHAT_TRANSCRIPT_MAX_LOADED);
      });

      if (transport.kind === "guest") {
        await dispatchCloud(item, replyId, abort);
      } else {
        await dispatchAutomatic(item, replyId, abort);
      }
    },
    [
      canonicalAuthorityLeaseCurrent,
      canonicalJournal,
      dispatchAutomatic,
      dispatchCloud,
      markSending,
      parkQueuedSend,
      transport.kind,
      updateMessages,
    ],
  );

  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  const drainQueue = useCallback(() => {
    const next = queueRef.current[0];
    if (!next) return;
    if (!canonicalAuthorityLeaseCurrent(next.canonicalAuthorityLease)) {
      queueRef.current.shift();
      return;
    }
    if (canonicalJournal && !admissionEnabledRef.current) return;
    queueRef.current.shift();
    markSending(true);
    void dispatchRef.current?.(next);
  }, [canonicalAuthorityLeaseCurrent, canonicalJournal, markSending]);

  useEffect(() => {
    drainQueueRef.current = drainQueue;
  }, [drainQueue]);

  useEffect(() => {
    if (!storageLoaded || !drainOperationalOutbox || sendingRef.current) return;
    drainQueueRef.current?.();
  }, [drainOperationalOutbox, storageLoaded]);

  const submit = useCallback(
    (suppliedPrompt?: string): { userMessageId: string } | null => {
      // Don't dispatch until hydration has restored the persisted transcript and
      // sync cursor: sending earlier lets the async load overwrite the optimistic
      // bubble, and lets the landing sync fire mid-stream against a fresh cursor.
      // The draft is left intact so the queued tap lands once we're loaded.
      if (
        !storageLoaded ||
        rewindInProgressRef.current ||
        (canonicalJournal && !admissionEnabledRef.current)
      ) {
        return null;
      }
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
      updateMessages((m) => {
        const next = [...m, userMsg];
        if (next.length <= CHAT_TRANSCRIPT_MAX_LOADED) return next;
        setHasOlderMessages(true);
        setHasNewerMessages(false);
        return next.slice(-CHAT_TRANSCRIPT_MAX_LOADED);
      });
      if (hasNewerMessages) {
        // Sending from a historical slice must return the rendered window to
        // the canonical tail. Keep the optimistic row(s) from the functional
        // state update above, but do not leave them visually inserted ahead of
        // newer durable turns that were temporarily evicted by backward paging.
        const historyGeneration = historyPageGenerationRef.current;
        void loadRecentChatMessages(threadId, CHAT_TRANSCRIPT_MAX_LOADED)
          .then((page) => {
            if (historyGeneration !== historyPageGenerationRef.current) return;
            updateMessages((current) => {
              const merged = mergeMessagesById(page.messages, current);
              const next = merged.slice(-CHAT_TRANSCRIPT_MAX_LOADED);
              oldestLoadedCursorRef.current = next[0]
                ? chatTranscriptCursorForMessage(threadId, next[0].id)
                : page.oldestCursor;
              newestLoadedCursorRef.current =
                (next[next.length - 1]
                  ? chatTranscriptCursorForMessage(
                      threadId,
                      next[next.length - 1]!.id,
                    )
                  : null) ?? page.newestCursor;
              setHasOlderMessages(
                page.hasOlder || merged.length > CHAT_TRANSCRIPT_MAX_LOADED,
              );
              setHasNewerMessages(false);
              return next;
            });
          })
          .catch(() => {});
      }

      const item: QueuedSend = {
        dispatchId: userMessageId,
        clientRequestId: userMessageId,
        userMessageId,
        text,
        ...(decoupleQuotes ? { promptText, selectedText: rawQuotes } : {}),
        assets,
        ...(canonicalJournal
          ? {
              canonicalAuthorityLease: canonicalAuthorityLeaseRef.current,
            }
          : {}),
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
        ...(canonicalOutboxAuthority
          ? { authority: canonicalOutboxAuthority }
          : {}),
      };
      // Both transports gate transmission on this write. If iOS kills the
      // process while AsyncStorage is committing, either no transport happened
      // or hydration finds this exact stable identity and replays it, including
      // the image bytes.
      void enqueueDesktopChatOutbox(threadId, durableRecord)
        .then((stored) => {
          pendingEnqueueRef.current.delete(userMessageId);
          if (!canonicalAuthorityLeaseCurrent(item.canonicalAuthorityLease)) {
            return;
          }
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
          if (
            admission === "queue" ||
            (canonicalJournal && !admissionEnabledRef.current)
          ) {
            parkQueuedSend(item);
            if (admission === "dispatch") markSending(false);
            if (!sendingRef.current && admissionEnabledRef.current) {
              drainQueueRef.current?.();
            }
            return;
          }
          void dispatch(item);
        })
        .catch(() => {
          pendingEnqueueRef.current.delete(userMessageId);
          if (!canonicalAuthorityLeaseCurrent(item.canonicalAuthorityLease)) {
            return;
          }
          if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
          if (admission === "dispatch") markSending(false);
          updateMessages((current) =>
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
      canonicalAuthorityLeaseCurrent,
      canonicalJournal,
      canonicalOutboxAuthority,
      dispatch,
      draft,
      hasNewerMessages,
      quotes,
      markSending,
      parkQueuedSend,
      storageLoaded,
      threadId,
      updateMessages,
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
      updateMessages((m) =>
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
      if (transport.kind === "automatic") {
        const control = requestAutomaticExecutionCancellation(
          active.automaticControl ?? {
            clientIdempotencyKey: active.dispatchId,
          },
        );
        active.automaticControl = control;
        const cancelRequestId = control.cancelRequestId!;
        const cancellation = automaticExecutionCancellationCommand(control);
        const authorityLease = canonicalJournal
          ? canonicalAuthorityLeaseRef.current
          : undefined;
        patchActivity({ statusText: "Stopping" });
        updateMessages((m) =>
          m.map((msg) =>
            msg.id === active.replyId
              ? { ...msg, text: msg.text || "Stopping…", stopped: true }
              : msg,
          ),
        );
        // Persist intent before the server call. If iOS kills the app between
        // these operations, hydration replays the same idempotency key and
        // cancels that exact dispatch instead of starting an alternate run.
        void markDesktopChatOutboxCancellation(
          threadId,
          active.dispatchId,
          cancelRequestId,
          Date.now(),
          canonicalOutboxAuthority,
        )
          .then(() =>
            canonicalAuthorityLeaseCurrent(authorityLease) && cancellation
              ? cancelAutomaticExecution({
                  ...cancellation,
                  reason: "Stopped from the mobile conversation.",
                })
              : undefined,
          )
          .catch(() => {
            // The active placement observer retries from the durable intent;
            // a relaunch does the same if this process is interrupted.
          });
        return;
      }
      acknowledgeDesktopSendIds([active.dispatchId, active.userMessageId]);
      active.abort.abort();
      updateMessages((m) =>
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
  }, [
    acknowledgeDesktopSendIds,
    canonicalAuthorityLeaseCurrent,
    canonicalJournal,
    canonicalOutboxAuthority,
    markSending,
    patchActivity,
    threadId,
    transport.kind,
    updateMessages,
  ]);

  // Rewind (destructive): drop a user message and everything after it, then
  // load its text + attachments back into the composer so it can be edited and
  // resent. Only the cloud chat owns its transcript outright — the computer
  // chat mirrors the paired desktop's canonical rows, so a local truncate there
  // would just be re-pulled on the next sync. The two-step confirm lives in the
  // UI (ChatPane's message menu); this performs the committed action.
  const rewindToMessage = useCallback(
    (messageId: string) => {
      if (isDesktop || canonicalJournal) return;
      if (!storageLoaded) return;
      // Never truncate under an in-flight turn — the streaming reply writes into
      // the very rows we would be dropping.
      if (sendingRef.current || rewindInProgressRef.current) return;
      const current = messagesRef.current;
      const index = current.findIndex((m) => m.id === messageId);
      if (index < 0) return;
      const target = current[index];
      if (target.role !== "user") return;
      // SQLite, not the loaded JS window, owns the transcript. Delete from the
      // durable anchor so rows outside this window cannot reappear later.
      persistenceGenerationRef.current += 1;
      const rewindGeneration = persistenceGenerationRef.current;
      rewindInProgressRef.current = true;
      void (async () => {
        // Disarm the old snapshot, then establish a transcript-queue barrier
        // before truncation. Otherwise a debounce armed before the menu action
        // can run after DELETE and upsert the rewound suffix back into SQLite.
        // Rewind is rare and destructive, so flushing the bounded UI window is
        // preferable to attempting to infer which pending rows own the edge.
        await establishTranscriptRewindBarrier(
          () => {
            if (saveTimerRef.current !== null) {
              clearTimeout(saveTimerRef.current);
              saveTimerRef.current = null;
            }
            pendingSaveRef.current = null;
            pendingSaveIdsRef.current.clear();
          },
          () => saveChatMessages(threadId, current),
        );
        if (rewindGeneration !== persistenceGenerationRef.current) return;
        let truncated = false;
        if (threadId === "cloud") {
          // Invalidate the derived store before mutating its canonical source.
          // A durable rebuild marker spans the canonical truncate, so a kill
          // at either boundary rebuilds from the surviving transcript instead
          // of recalling rows that rewind deleted.
          let rebuildStarted = false;
          try {
            await beginMessageIndexRebuild();
            rebuildStarted = true;
            // A stale checkpoint can also reintroduce deleted turns into model
            // context, so its durable removal is part of the rewind commit.
            await clearCheckpoint();
            await truncateChatMessagesFrom(threadId, messageId);
            truncated = true;
          } finally {
            if (rebuildStarted) {
              await rebuildMessageIndex().catch(() => {
                scheduleMessageIndexRecovery();
              });
            }
          }
        } else {
          await truncateChatMessagesFrom(threadId, messageId);
          truncated = true;
        }
        if (
          !truncated ||
          rewindGeneration !== persistenceGenerationRef.current
        ) {
          return;
        }
        LayoutAnimation.configureNext({
          duration: 250,
          update: { type: LayoutAnimation.Types.easeInEaseOut },
        });
        const retained = current.slice(0, index);
        pendingSaveRef.current = retained;
        const retainedIds = new Set(retained.map((message) => message.id));
        pendingSaveIdsRef.current.forEach((id) => {
          if (!retainedIds.has(id)) pendingSaveIdsRef.current.delete(id);
        });
        updateMessages(retained);
        setHasNewerMessages(false);
        newestLoadedCursorRef.current =
          index > 0
            ? chatTranscriptCursorForMessage(threadId, current[index - 1]!.id)
            : null;
        // `text` holds the "Photo" placeholder for an image-only send (see
        // `submit`), so restore empty text in that case rather than the literal.
        const restoredText =
          target.hasImage && target.text === "Photo" ? "" : target.text;
        setDraft(restoredText);
        setAttachments([]);
        setQuotes([]);
        const assets = await restoreRewoundAttachments(target);
        if (
          assets.length > 0 &&
          rewindGeneration === persistenceGenerationRef.current
        ) {
          setAttachments(assets);
        }
      })()
        .catch(() => {})
        .finally(() => {
          if (rewindGeneration === persistenceGenerationRef.current) {
            rewindInProgressRef.current = false;
          }
        });
    },
    [
      canonicalJournal,
      isDesktop,
      scheduleMessageIndexRecovery,
      storageLoaded,
      threadId,
    ],
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
    authorityReady:
      canonicalJournal && !hydrationAuthorityIssue
        ? canonicalAuthorityReady
        : undefined,
    authorityIssue: hydrationAuthorityIssue,
    hasOlderMessages,
    hasNewerMessages,
    historyPageLoading,
    loadOlderMessages,
    loadNewerMessages,
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
