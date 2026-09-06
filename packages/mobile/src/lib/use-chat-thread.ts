import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, LayoutAnimation } from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  CHAT_TRANSCRIPT_MAX_LOADED,
  subscribeChatStorageCleanup,
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
  desktopChatOutboxPrompt,
  type DesktopChatOutboxAttachment,
  type DesktopChatOutboxRecord,
} from "./desktop-chat-outbox-state";
import {
  appendAttachments,
  attachmentsSettled,
  isAttachmentReady,
  uploadChatAttachment,
  withAttachmentStatus,
  CHAT_ATTACHMENT_MAX_COUNT,
  type ComposerAttachment,
  type PickedAttachment,
} from "./chat-attachments";
import { getConvexClient } from "./convex";
import { File } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import { useT } from "../i18n/I18nProvider";
import { hasAiConsent, requestAiConsent } from "./ai-consent";
import {
  getPreferredPhoneAccess,
  listStoredPairedPhoneAccess,
  type StoredPhoneAccess,
} from "./phone-access";
import {
  AUTOMATIC_EXECUTION_TARGET,
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
  type AutomaticExecutionTarget,
} from "./execution-placement";
import {
  unifiedChatPlacementAdmission,
  unifiedChatPlacementStatusText,
} from "./unified-chat-placement";
import {
  fetchDesktopBridgeThreadTasks,
  type DesktopTaskDecoration,
} from "./desktop-bridge-chat";
import {
  buildWorkingIndicatorState,
  IDLE_WORKING_ACTIVITY,
  type WorkingActivity,
  type WorkingIndicatorState,
} from "../components/working-indicator-state";
import { openDesktopBridgeLive } from "./desktop-bridge-live";
import {
  desktopTaskPollIntervalMs,
  shouldArmDesktopTaskPoll,
} from "./desktop-sync-policy";
import { applyLiveAgentWorkState } from "./agent-work-live-state";
import {
  collectConversationTasks,
  overlayDesktopThreadTasks,
} from "./mobile-task-merge";
import {
  collectActivityHubArtifacts,
  groupActivityArtifacts,
} from "./activity-hub-model";
import { admitSend } from "./send-admission";
import { userFacingError } from "./user-facing-error";
import {
  clearComposerNotices,
  showComposerNoticeForError,
} from "./composer-notice";
import { notifySuccess } from "./haptics";
import type {
  ChatArtifact,
  ChatMessage,
  ComposerQuote,
  MobileTask,
} from "../types";

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
  const code =
    error && typeof error === "object" ? Reflect.get(error, "code") : null;
  if (code === "sign_in_required" || code === "owner_suspended") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /authentication required|sign in|signed-in account|ownership_migrated|linked to (?:an|another) account|being linked|owner generation|account data is currently|invalid|unsupported|not found|not paired|conflict|payload|conversation|malformed|different (?:dispatch|message) identity/i.test(
    message,
  );
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

/**
 * A durably ordered send awaiting transmission. Cloud chat holds it until the
 * current reply settles. Computer chat instead drains it through the
 * acceptance-only steer pump as soon as the active message is durable, so it
 * reaches the runtime during the same root turn without opening another reply
 * observer.
 */
type QueuedSend = {
  structuredAttachments?: true;
  userMessageEventId?: string;
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
  /**
   * Drive references for this turn's attachments. Uploaded at pick time, so by
   * the time a send exists the bytes are already server-side and this is the
   * whole payload — placement carries paths, never pixels.
   */
  attachments: DesktopChatOutboxAttachment[];
  queueSequence?: number;
  /** Mount-local lease preventing an old account hook from dispatching later. */
  canonicalAuthorityLease?: number;
  /** Durable server cancellation identity restored from the outbox. */
  cancelRequestId?: string;
  executionTarget?: AutomaticExecutionTarget;
  execution?: CloudExecutionSelection;
};

/**
 * The one signed-in chat authority. Reads come from the cloud journal; writes
 * go through server-owned execution placement, which prefers the paired
 * computer and otherwise commits the turn to cloud.
 */
export type ChatTransport = {
  accountScope: string;
  ownerGeneration: string;
  conversationId: string;
  authorityReady: boolean;
  /** Paired desktop credentials, when one is paired, for live activity reads. */
  access?: StoredPhoneAccess | null;
  executionTarget?: AutomaticExecutionTarget;
  execution?: CloudExecutionSelection;
  /**
   * Cloud journal reconciliation seam. The placement service allocates a
   * server dispatch id distinct from the mobile optimistic id; the DO echoes
   * that server id as clientMsgId.
   */
  onAdmission?: (event: {
    localMessageId: string;
    dispatchId: string;
    conversationId: string;
  }) => void;
};

/**
 * The composer, the optimistic send queue, and the live activity overlay: the
 * half of a chat surface that does not depend on transcript authority.
 */
export type ChatComposerThread = {
  /** The optimistic overlay of turns this device has in flight. */
  messages: ChatMessage[];
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  /** Composer chips, each carrying its own upload state. */
  attachments: ComposerAttachment[];
  /** Adds picks and starts their uploads. Reports picks over the turn budget. */
  addAttachments: (picked: readonly PickedAttachment[]) => { rejected: number };
  removeAttachment: (id: string) => void;
  /** Re-runs a failed upload for one chip, leaving the draft untouched. */
  retryAttachment: (id: string) => void;
  /** How many files one turn may carry. */
  maxAttachments: number;
  /** Quoted-text chips pending in the composer (folded into the sent message). */
  quotes: ComposerQuote[];
  /** Add a quoted-text chip (message-menu Quote / assistant "Ask Stella"). */
  addQuote: (text: string) => void;
  /** Remove a pending quote chip by id. */
  removeQuote: (id: string) => void;
  sending: boolean;
  /** Prompt owned by the active placement waiter, for canonical reconciliation. */
  activeSendMessageId?: string | null;
  /** Live working-indicator props — active/label reflect the current step. */
  workingIndicator: WorkingIndicatorState;
  storageLoaded: boolean;
  /** Named cloud-authority failure; local cache never hides this condition. */
  authorityIssue?: {
    message: string;
    retryable: boolean;
    retry: () => void;
  } | null;
  /** Background tasks for the activity pill + tray, running-first then newest. */
  conversationTasks: MobileTask[];
  /** Files grouped by their owning background task for the activity hub. */
  activityArtifactsByTaskId: ReadonlyMap<string, ChatArtifact[]>;
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
  /** Whether the paired computer's activity push socket is attached. */
  livePushConnected: boolean;
};

/** A full chat surface: the composer half plus the journal-owned transcript. */
export type ChatThread = ChatComposerThread & {
  /** The cloud conversation this transcript belongs to. */
  conversationId?: string | null;
  /** False while signed-in cloud history has no verified DO authority. */
  authorityReady?: boolean;
  /** Whether durable history exists before/after the bounded loaded window. */
  hasOlderMessages: boolean;
  hasNewerMessages: boolean;
  historyPageLoading: boolean;
  /** Page the adjacent durable window without growing Hermes state unbounded. */
  loadOlderMessages: () => Promise<void>;
  loadNewerMessages: () => Promise<void>;
  /** All artifacts in the conversation, newest first and de-duplicated. */
  conversationArtifacts: ChatArtifact[];
  /** Direct orchestrator files owned by the conversation rather than a task. */
  conversationOwnedArtifacts: ChatArtifact[];
  /**
   * True while the journal socket is still catching up to the head sequence,
   * so the surface can say so instead of rendering a partial transcript as
   * though it were complete.
   */
  catchingUp: boolean;
};

/**
 * Owns the composer, the optimistic send queue with its durable outbox, and
 * one server-owned placement decision per durable message identity. The DO
 * journal owns every visible transcript row, so the local rows here are an
 * optimistic overlay and never historical authority.
 */
export function useChatThread(opts: {
  threadId: ChatThreadId;
  transport: ChatTransport;
}): ChatComposerThread {
  const { threadId, transport } = opts;
  const canonicalAccountScope = transport.accountScope;
  const canonicalOwnerGeneration = transport.ownerGeneration;
  const canonicalConversationId = transport.conversationId;
  const canonicalAuthorityReady = transport.authorityReady;
  const canonicalAuthorityKey = JSON.stringify([
    canonicalAccountScope,
    canonicalOwnerGeneration,
    canonicalConversationId,
  ]);
  const canonicalOutboxAuthority = useMemo<DesktopChatOutboxAuthority>(
    () => ({
      accountScope: canonicalAccountScope,
      ownerGeneration: canonicalOwnerGeneration,
      conversationId: canonicalConversationId,
    }),
    [canonicalAccountScope, canonicalConversationId, canonicalOwnerGeneration],
  );
  // The separately durable outbox stays inert until this exact authority has
  // connected and caught up.
  const drainOperationalOutbox = canonicalAuthorityReady;
  const admissionEnabledRef = useRef(drainOperationalOutbox);
  admissionEnabledRef.current = drainOperationalOutbox;
  const desktopAccess = transport.access ?? null;
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
    useState<ChatComposerThread["authorityIssue"]>(null);
  const retryHydration = useCallback(() => {
    setHydrationRetryGeneration((generation) => generation + 1);
  }, []);
  const historyPageGenerationRef = useRef(0);
  const [draft, setDraft] = useState("");
  const t = useT();
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  /**
   * Uploads a pick immediately rather than at send time. A failure therefore
   * lands while the composer still holds the draft and the chip, so there is
   * nothing to restore: the user retries the one file that broke.
   */
  const startAttachmentUpload = useCallback(
    (picked: PickedAttachment) => {
      const taken = new Set(
        attachmentsRef.current
          .map((entry) => (entry.status === "ready" ? entry.drivePath : ""))
          .filter(Boolean),
      );
      void uploadChatAttachment(picked, taken, {
        client: getConvexClient(),
        readFile: async (uri) => await new File(uri).bytes(),
        fetch: expoFetch,
      })
        .then((drivePath) => {
          setAttachments((current) =>
            withAttachmentStatus(current, picked.id, {
              status: "ready",
              drivePath,
            }),
          );
        })
        .catch((error: unknown) => {
          setAttachments((current) =>
            withAttachmentStatus(current, picked.id, {
              status: "failed",
              message:
                error instanceof Error && error.message
                  ? error.message
                  : t("chat.attachments.uploadFailed"),
            }),
          );
        });
    },
    [t],
  );
  const addAttachments = useCallback(
    (picked: readonly PickedAttachment[]): { rejected: number } => {
      const pending: ComposerAttachment[] = picked.map((entry) => ({
        ...entry,
        status: "uploading",
      }));
      const merged = appendAttachments(attachmentsRef.current, pending);
      const accepted = merged.attachments.filter((entry) =>
        pending.some((candidate) => candidate.id === entry.id),
      );
      setAttachments(merged.attachments);
      for (const entry of accepted) startAttachmentUpload(entry);
      return { rejected: merged.rejected };
    },
    [startAttachmentUpload],
  );
  const retryAttachment = useCallback(
    (id: string) => {
      const target = attachmentsRef.current.find((entry) => entry.id === id);
      if (!target || target.status !== "failed") return;
      setAttachments((current) =>
        withAttachmentStatus(current, id, { status: "uploading" }),
      );
      startAttachmentUpload(target);
    },
    [startAttachmentUpload],
  );
  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((entry) => entry.id !== id));
  }, []);
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
    latestResponseUserMessageId: string;
  } | null>(null);
  const dispatchGenerationRef = useRef(0);
  const pendingEnqueueRef = useRef<Set<string>>(new Set());
  // The conversation the paired computer's activity pushes must match before
  // they are folded in, so a push for another conversation is ignored.
  const syncConversationIdRef = useRef<string | null>(null);
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
  // A callback from a retired account/session mount can never mutate its
  // successor.
  const canonicalAuthorityLeaseCurrent = useCallback(
    (lease: number | undefined) => lease === canonicalAuthorityLeaseRef.current,
    [],
  );

  useEffect(() => {
    const authorityChanged =
      committedCanonicalAuthorityKeyRef.current !== canonicalAuthorityKey;
    committedCanonicalAuthorityKeyRef.current = canonicalAuthorityKey;
    if (authorityChanged) {
      acceptedDesktopSendIdsRef.current.clear();
      stoppedDispatchIdsRef.current.clear();
      syncConversationIdRef.current = canonicalConversationId;
      setStorageLoaded(false);
      setHydrationAuthorityIssue(null);
      setDraft("");
      setAttachments([]);
      setQuotes([]);
      setSending(false);
      setWorkingActivity(IDLE_WORKING_ACTIVITY);
      updateMessages([]);
    }
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
  }, [canonicalAuthorityKey, canonicalConversationId, updateMessages]);

  // ─── Durable outbox hydration ────────────────────────────────────────────
  // The DO journal owns history, so nothing is read back from SQLite here.
  // The only durable client state is the outbox of sends this device has not
  // yet had admitted.
  useEffect(() => {
    let active = true;
    const generation = historyPageGenerationRef.current;
    setHydrationAuthorityIssue(null);
    void loadDesktopChatOutbox(threadId, canonicalOutboxAuthority).then(
      (storedOutbox) => {
        if (!active || generation !== historyPageGenerationRef.current) return;
        syncConversationIdRef.current = canonicalConversationId;
        const restored = restoreOutboxMessages([], storedOutbox);
        updateMessages(restored);
        setStorageLoaded(true);
        // Re-enqueue any queued-but-unsent messages. The optimistic bubbles were
        // persisted (marked `queued`), but the in-memory dispatch queue was lost
        // on relaunch — so without this they'd render forever as "sent" yet never
        // deliver. Rebuild a dispatch for each from its bubble and drain, so a
        // restart actually sends them. An outbox row's attachments are drive
        // paths whose bytes already landed, so a replay carries them intact
        // without the phone holding a single byte across the restart.
        const outboxByUserMessageId = new Map(
          storedOutbox.map((record) => [record.userMessageId, record]),
        );
        const pendingSends = restored.filter(
          (m) =>
            m.role === "user" &&
            (outboxByUserMessageId.has(m.id) || m.queued === true) &&
            m.text.trim().length > 0,
        );
        for (const row of pendingSends) {
          const stored = outboxByUserMessageId.get(row.id);
          queueRef.current.push({
            dispatchId: stored?.sendId ?? row.id,
            clientRequestId: stored?.sendId ?? row.id,
            userMessageId: row.id,
            ...(stored?.userMessageEventId ? { userMessageEventId: stored.userMessageEventId } : {}),
            ...(stored?.structuredAttachments === true ? { structuredAttachments: true } : {}),
            text: stored?.text ?? row.text,
            attachments: stored?.attachments ?? [],
            executionTarget:
              stored?.executionTarget ?? AUTOMATIC_EXECUTION_TARGET,
            ...(stored?.execution ? { execution: stored.execution } : {}),
            ...(stored ? { queueSequence: stored.sequence } : {}),
            canonicalAuthorityLease: canonicalAuthorityLeaseRef.current,
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
        setHydrationAuthorityIssue({
          message:
            "Stella could not verify pending cloud messages on this device. Try again.",
          retryable: true,
          retry: retryHydration,
        });
      },
    );
    return () => {
      active = false;
      historyPageGenerationRef.current += 1;
    };
  }, [
    canonicalConversationId,
    canonicalOutboxAuthority,
    hydrationRetryGeneration,
    retryHydration,
    threadId,
    updateMessages,
  ]);

  // Mirror of `sending` for reads outside render. The ref is written
  // SYNCHRONOUSLY by `markSending` at every transition (the effect below is
  // only a belt-and-braces reconciler), so imperative callers racing the
  // `setSending(true)` commit still observe the in-flight turn.
  const sendingRef = useRef(false);
  const markSending = useCallback((next: boolean) => {
    sendingRef.current = next;
    setSending(next);
  }, []);
  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);
  useEffect(
    () =>
      subscribeChatStorageCleanup(() => {
        // Account cleanup may run while tab routes remain mounted. Invalidate
        // every producer before storage deletes so an old hydration or
        // in-flight dispatch cannot repopulate cleared data.
        historyPageGenerationRef.current += 1;
        dispatchGenerationRef.current += 1;
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
        syncConversationIdRef.current = null;
        messagesRef.current = [];
        desktopTransportEnabledRef.current = false;
        markSending(false);
        updateMessages([]);
        setDraft("");
        setAttachments([]);
        setQuotes([]);
        setWorkingActivity(IDLE_WORKING_ACTIVITY);
        setDesktopThreadTasks(null);
        setDesktopTaskDecoration(null);
        setLivePushConnected(false);
      }),
    [markSending, updateMessages],
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

  // ─── localChat push (activity only) ─────────────────────────────────────
  // While a computer is paired, hold a push socket so the phone learns about
  // mid-run desktop activity the transcript journal does not carry: live task
  // rows and the renderer's ephemeral decoration snapshot. Transcript rows
  // arrive through the cloud journal instead, so no push ever pulls history.
  const [livePushConnected, setLivePushConnected] = useState(false);
  useEffect(() => {
    if (!desktopAccess) return;
    const handle = openDesktopBridgeLive({
      access: desktopAccess,
      // Authoritative task rows: a thread transition (spawn, retitle,
      // terminal) pushes the signal; the coalesced fetch pulls the projection.
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
      },
    });
    return () => {
      handle.close();
      setLivePushConnected(false);
    };
  }, [desktopAccess, refreshDesktopThreadTasks]);

  const finishDispatch = useCallback(() => {
    activeDispatchRef.current = null;
    markSending(false);
    setWorkingActivity(IDLE_WORKING_ACTIVITY);
    if (queueRef.current.length > 0 && appActive) {
      drainQueueRef.current?.();
    }
  }, [appActive, markSending]);

  // ─── Server-owned automatic placement ───────────────────────────────────
  const dispatchAutomatic = useCallback(
    async (item: QueuedSend, replyId: string, abort: AbortController) => {
      // A fresh send supersedes any pinned sign-in / limit notice; if the
      // problem persists this dispatch raises a new one.
      clearComposerNotices(canonicalConversationId);
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

      const placementAttachments = item.attachments.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
      }));

      try {
        assertAuthorityLease();
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
                  title: "Chat",
                });
              assertAuthorityLease();
            }
            syncConversationIdRef.current = placementConversationId;
            const target = item.executionTarget ?? AUTOMATIC_EXECUTION_TARGET;
            let access: StoredPhoneAccess | undefined;
            if (!ignoreStoredAccess && target.mode === "device") {
              access =
                transport.access?.desktopDeviceId === target.deviceId
                  ? transport.access
                  : (await listStoredPairedPhoneAccess()).find(
                      (candidate) =>
                        candidate.desktopDeviceId === target.deviceId,
                    );
            } else if (!ignoreStoredAccess && target.mode !== "cloud") {
              access =
                transport.access ??
                (await getPreferredPhoneAccess()) ??
                undefined;
            }
            assertAuthorityLease();
            if (!admissionEnabledRef.current) {
              await waitForAutomaticRetry(abort.signal);
              assertAuthorityLease();
              continue;
            }
            admitted = await submitAutomaticExecution({
              ...unifiedChatPlacementAdmission({
                dispatchId: item.dispatchId,
                ...(item.userMessageEventId ? { userMessageEventId: item.userMessageEventId } : {}),
                conversationId: placementConversationId,
                prompt: desktopChatOutboxPrompt(item),
                attachments: placementAttachments,
              }),
              ...(access ? { access } : {}),
              ...(item.execution && target.mode !== "device" ? { execution: item.execution } : {}),
              target,
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
              (item.executionTarget?.mode ?? "automatic") !== "device" &&
              isAutomaticExecutionPairCredentialRejection(error)
            ) {
              // No placement was committed: retry without the invalid grant
              // so server policy can choose cloud for portable work or return
              // an explicit computer-required failure for computer-only work.
              ignoreStoredAccess = true;
              continue;
            }
            if (isPermanentAutomaticAdmissionError(error)) throw error;
            await waitForAutomaticRetry(abort.signal);
            assertAuthorityLease();
          }
        }

        assertAuthorityLease();
        const active = activeDispatchRef.current;
        transport.onAdmission?.({
          localMessageId: item.userMessageId,
          dispatchId: admitted.dispatchId,
          conversationId: placementConversationId,
        });
        if (active?.replyId === replyId) {
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
            const statusText = unifiedChatPlacementStatusText(dispatch);
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
      } catch (error) {
        if (
          error instanceof AutomaticExecutionWaitAbortedError ||
          abort.signal.aborted
        ) {
          return;
        }
        renderReply(userFacingError(error));
        // Sign-in / plan-limit failures also pin an actionable notice above
        // the composer, matching desktop; transient ones stay in the bubble.
        showComposerNoticeForError(error, canonicalConversationId);
        // Authentication/migration/validation failures cannot become valid by
        // replaying this old account-bound outbox row after every launch.
        if (isPermanentAutomaticAdmissionError(error)) {
          acknowledgeDesktopSendIds([item.dispatchId, item.userMessageId]);
        }
        finishDispatch();
      }
    },
    [
      acknowledgeDesktopSendIds,
      canonicalAuthorityLeaseCurrent,
      canonicalConversationId,
      finishDispatch,
      patchActivity,
      threadId,
      transport,
      updateMessages,
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
      if (!admissionEnabledRef.current) {
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
        automaticControl: {
          clientIdempotencyKey: item.dispatchId,
          ...(item.cancelRequestId
            ? { cancelRequestId: item.cancelRequestId }
            : {}),
        },
        userMessageId: item.userMessageId,
        replyId,
        abort,
        generation: dispatchGenerationRef.current,
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
        return next.slice(-CHAT_TRANSCRIPT_MAX_LOADED);
      });

      await dispatchAutomatic(item, replyId, abort);
    },
    [
      canonicalAuthorityLeaseCurrent,
      dispatchAutomatic,
      markSending,
      parkQueuedSend,
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
    if (!admissionEnabledRef.current) return;
    queueRef.current.shift();
    markSending(true);
    void dispatchRef.current?.(next);
  }, [canonicalAuthorityLeaseCurrent, markSending]);

  useEffect(() => {
    drainQueueRef.current = drainQueue;
  }, [drainQueue]);

  useEffect(() => {
    if (!storageLoaded || !drainOperationalOutbox || sendingRef.current) return;
    drainQueueRef.current?.();
  }, [drainOperationalOutbox, storageLoaded]);

  const submit = useCallback(
    (suppliedPrompt?: string): { userMessageId: string } | null => {
      // Don't dispatch until the durable outbox has hydrated and the journal
      // authority has caught up: sending earlier would admit a turn this mount
      // cannot reconcile. The draft is left intact so the queued tap lands once
      // we're ready.
      if (!storageLoaded || !admissionEnabledRef.current) return null;
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
      // A send only ever carries settled attachments. An in-flight or failed
      // upload has no drive path, and admitting the turn without it would
      // execute a materially different request than the one on screen.
      const composerAttachments = supplied ? [] : attachments;
      if (!text && composerAttachments.length === 0) return null;
      if (!attachmentsSettled(composerAttachments)) return null;
      const picked = composerAttachments.filter(isAttachmentReady);
      const sendAttachments: DesktopChatOutboxAttachment[] = picked.map(
        (entry) => ({
          path: entry.drivePath,
          name: entry.name,
          kind: entry.kind,
          ...(entry.kind === "image" ? { previewUri: entry.uri } : {}),
        }),
      );

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
      const images = picked.filter((entry) => entry.kind === "image");
      const documents = picked.filter((entry) => entry.kind === "file");
      const displayText =
        promptText ||
        (images.length ? t("chat.attachments.photoLabel") : "") ||
        documents.map((entry) => entry.name).join(", ");
      const quotedPreview = rawQuotes
        ? rawQuotes.slice(0, QUOTED_TEXT_PREVIEW_MAX_CHARS)
        : undefined;
      const thumbs = images.slice(0, 3).map((entry) => entry.uri);
      const createdAt = Date.now();
      const userMsg: ChatMessage = {
        id: userMessageId,
        role: "user",
        text: displayText,
        createdAt,
        hasImage: images.length > 0,
        ...(sendAttachments.length ? {
          attachmentPaths: sendAttachments.map(entry => entry.path),
          attachmentPreviews: sendAttachments.map(entry => ({
            path: entry.path, name: entry.name,
            ...(entry.previewUri ? { imageUri: entry.previewUri } : {}),
          })),
        } : {}),
        ...(thumbs.length > 0 ? { thumbnailUris: thumbs } : {}),
        ...(documents.length > 0
          ? { documentNames: documents.map((entry) => entry.name) }
          : {}),
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
        return next.slice(-CHAT_TRANSCRIPT_MAX_LOADED);
      });

      const item: QueuedSend = {
        structuredAttachments: true,
        dispatchId: userMessageId,
        clientRequestId: userMessageId,
        userMessageId,
        userMessageEventId: userMessageId,
        text,
        ...(decoupleQuotes ? { promptText, selectedText: rawQuotes } : {}),
        attachments: sendAttachments,
        executionTarget:
          transport.executionTarget ?? AUTOMATIC_EXECUTION_TARGET,
        ...(transport.execution && transport.executionTarget?.mode !== "device"
          ? { execution: { ...transport.execution } }
          : {}),
        canonicalAuthorityLease: canonicalAuthorityLeaseRef.current,
      };
      pendingEnqueueRef.current.add(userMessageId);
      if (admission === "dispatch") markSending(true);
      const durableRecord: Omit<DesktopChatOutboxRecord, "sequence"> = {
        structuredAttachments: true,
        sendId: userMessageId,
        userMessageId,
        userMessageEventId: userMessageId,
        text,
        displayText,
        createdAt,
        attachments: sendAttachments,
        executionTarget:
          transport.executionTarget ?? AUTOMATIC_EXECUTION_TARGET,
        ...(transport.execution && transport.executionTarget?.mode !== "device"
          ? { execution: { ...transport.execution } }
          : {}),
        authority: canonicalOutboxAuthority,
      };
      // Transmission gates on this write. If iOS kills the process while
      // AsyncStorage is committing, either no transport happened or hydration
      // finds this exact stable identity and replays it, attachments included.
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
          if (admission === "queue" || !admissionEnabledRef.current) {
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
      canonicalOutboxAuthority,
      dispatch,
      draft,
      quotes,
      markSending,
      parkQueuedSend,
      storageLoaded,
      threadId,
      transport.executionTarget,
      transport.execution,
      updateMessages,
    ],
  );

  const send = useCallback(() => submit(), [submit]);
  const sendPrompt = useCallback((prompt: string) => submit(prompt), [submit]);

  const stop = useCallback(() => {
    // Cancel queued messages first so the in-flight finally-handler doesn't
    // pick them up after the abort.
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
    const active = activeDispatchRef.current;
    if (active) {
      stoppedDispatchIdsRef.current.add(active.dispatchId);
      const control = requestAutomaticExecutionCancellation(
        active.automaticControl ?? {
          clientIdempotencyKey: active.dispatchId,
        },
      );
      active.automaticControl = control;
      const cancelRequestId = control.cancelRequestId!;
      const cancellation = automaticExecutionCancellationCommand(control);
      const authorityLease = canonicalAuthorityLeaseRef.current;
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
    markSending(false);
    setWorkingActivity(IDLE_WORKING_ACTIVITY);
  }, [
    acknowledgeDesktopSendIds,
    canonicalAuthorityLeaseCurrent,
    canonicalOutboxAuthority,
    markSending,
    patchActivity,
    threadId,
    updateMessages,
  ]);

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

  // The push socket owns freshness for the running-task snapshot behind the
  // activity pill; this poll only guarantees the snapshot can't freeze if the
  // socket silently stops delivering.
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
      void refreshDesktopThreadTasks();
    }, desktopTaskPollIntervalMs(livePushConnected));
    return () => clearInterval(handle);
  }, [
    desktopAccess,
    appActive,
    hasRunningConversationTask,
    livePushConnected,
    refreshDesktopThreadTasks,
    sending,
    storageLoaded,
  ]);

  return {
    messages: displayMessages,
    draft,
    setDraft,
    attachments,
    addAttachments,
    removeAttachment,
    retryAttachment,
    maxAttachments: CHAT_ATTACHMENT_MAX_COUNT,
    quotes,
    addQuote,
    removeQuote,
    sending,
    activeSendMessageId: sending ? activeDispatchRef.current?.userMessageId ?? null : null,
    workingIndicator,
    storageLoaded,
    authorityIssue: hydrationAuthorityIssue,
    conversationTasks,
    activityArtifactsByTaskId: activityArtifactGroups.byTaskId,
    send,
    sendPrompt,
    stop,
    livePushConnected,
  };
}
