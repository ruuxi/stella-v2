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
import { mergeMessagesById, reconcileSentDesktopTurn } from "./chat-merge";
import { collectConversationTasks } from "./mobile-task-merge";
import { createStreamTextSmoother } from "./stream-text-smoother";
import { userFacingError } from "./user-facing-error";
import { notifySuccess } from "./haptics";
import type { ChatArtifact, ChatMessage, MobileTask } from "../types";

/** Cap on how many desktop messages we pull per sync. */
const HISTORY_MESSAGE_LIMIT = 100;
/** Cap on how many recent artifacts the Artifacts list sheet shows. */
const MAX_LISTED_ARTIFACTS = 20;

const createId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const WAKE_STATUS_COPY: Record<DesktopBridgeSendStatus, string | undefined> = {
  connecting: "Reaching your computer",
  waking: "Waking your computer",
  running: undefined,
};

const assetsToBridgeAttachments = (
  assets: ImagePicker.ImagePickerAsset[],
): DesktopBridgeAttachment[] | null => {
  const out: DesktopBridgeAttachment[] = [];
  for (const asset of assets) {
    if (!asset.base64) return null;
    const mimeType = asset.mimeType ?? "image/jpeg";
    out.push({ url: `data:${mimeType};base64,${asset.base64}`, mimeType });
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
  send: () => void;
  stop: () => void;
  /**
   * Coalesced wake + pull + merge against the canonical desktop rows. A no-op
   * for the cloud transport; safe to call repeatedly (in-flight runs are
   * shared) so resume/focus catch-up syncs never stack.
   */
  runDesktopSync: () => Promise<{ offline: boolean }>;
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
  const desktopSyncRef = useRef<Promise<{ offline: boolean }> | null>(null);
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
      setMessages(loaded);
      setStorageLoaded(true);
    });
  }, [threadId]);

  // Debounce persistence so streaming (which mutates `messages` many times a
  // second) doesn't rewrite the whole history to disk on every chunk.
  useEffect(() => {
    if (!storageLoaded) return;
    const handle = setTimeout(() => {
      void saveChatMessages(threadId, messages);
    }, 500);
    return () => clearTimeout(handle);
  }, [messages, storageLoaded, threadId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
  const runDesktopSync = useCallback((): Promise<{ offline: boolean }> => {
    if (!desktopAccess) return Promise.resolve({ offline: false });
    const existing = desktopSyncRef.current;
    if (existing) return existing;
    // Snapshot the generation so results from a now-stale computer (switched or
    // unmounted mid-flight) are dropped instead of clobbering the current one.
    const generation = syncGenerationRef.current;
    const run = (async (): Promise<{ offline: boolean }> => {
      try {
        // Let the previous turn's reconcile settle first so its canonical ids
        // are linked onto the optimistic rows and its cursor is persisted.
        // Otherwise this pull (e.g. the next, queued turn's wake→sync firing
        // the instant the prior turn finished) would re-fetch the previous
        // turn's rows against a stale cursor and duplicate them.
        const pendingReconcile = pendingReconcileRef.current;
        if (pendingReconcile) await pendingReconcile;
        const expectedConversationId = syncConversationIdRef.current;
        const sinceCursor = syncCursorRef.current;
        const next = await syncDesktopBridgeChatMessages({
          access: desktopAccess,
          expectedConversationId,
          sinceCursor: expectedConversationId ? sinceCursor : null,
          maxMessages: HISTORY_MESSAGE_LIMIT,
        });
        if (generation !== syncGenerationRef.current) return { offline: false };
        persistSyncState({
          conversationId: next.conversationId,
          cursor: next.cursor,
        });
        setMessages((current) => mergeMessagesById(current, next.messages));
        return { offline: false };
      } catch (error) {
        // Best-effort: the device-status poll drives the connection badge, and
        // the next send/landing retries the sync. Report a confirmed offline so
        // the send can surface it without spending a second wake budget.
        return { offline: error instanceof DesktopOfflineError };
      } finally {
        // Only release the shared handle if a newer run hasn't claimed it.
        if (generation === syncGenerationRef.current) {
          desktopSyncRef.current = null;
        }
      }
    })();
    desktopSyncRef.current = run;
    return run;
  }, [desktopAccess, persistSyncState]);

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
    void runDesktopSync();
  }, [desktopAccess, runDesktopSync, storageLoaded]);

  const appendAssistantText = useCallback((replyId: string, chunk: string) => {
    setMessages((m) =>
      m.map((msg) =>
        msg.id === replyId ? { ...msg, text: msg.text + chunk } : msg,
      ),
    );
  }, []);

  const finishDispatch = useCallback(() => {
    setSending(false);
    setWorkingActivity(IDLE_WORKING_ACTIVITY);
    drainQueueRef.current?.();
  }, []);

  // ─── Cloud dispatch ───────────────────────────────────────────────────────
  const dispatchCloud = useCallback(
    async (item: QueuedSend, replyId: string, abort: AbortController) => {
      const guest = transport.kind === "cloud" ? transport.guest : false;
      const queuedIds = new Set(queueRef.current.map((q) => q.userMessageId));
      const history = messagesRef.current
        .filter(
          (m) =>
            m.id !== item.userMessageId &&
            m.id !== replyId &&
            !queuedIds.has(m.id) &&
            !m.queued,
        )
        .map((m) => ({ role: m.role, text: m.text }))
        .filter((m) => m.text.trim().length > 0);

      const imagesPayload: { base64: string; mimeType: string }[] = [];
      for (const a of item.assets) {
        if (!a.base64) continue;
        imagesPayload.push({
          base64: a.base64,
          mimeType: a.mimeType ?? "image/jpeg",
        });
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

      try {
        await streamFn(
          "/api/mobile/offline-chat/stream",
          {
            message: item.text,
            history,
            images: imagesPayload,
          },
          (delta) => {
            // Cloud turns have no tool stream — the only signal is answer
            // text, so mark streaming as soon as a non-empty delta lands to
            // retire the "thinking" indicator (matching desktop behaviour).
            if (/\S/.test(delta)) patchActivity({ isStreamingText: true });
            textSmoother.push(delta);
          },
          streamOptions,
        );
        await textSmoother.drain();
        ensureFallbackReply();
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
      }
    },
    [appendAssistantText, finishDispatch, patchActivity, transport],
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
        const synced = await runDesktopSync();
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          activeDispatchRef.current = null;
          setSending(false);
          return;
        }
        if (synced.offline) {
          throw new DesktopOfflineError();
        }
        const result = await sendDesktopBridgeChat({
          access,
          message: item.text,
          attachments: assetsToBridgeAttachments(item.assets) ?? undefined,
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
          setSending(false);
          return;
        }
        await textSmoother.drain();
        activeDispatchRef.current = null;
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId
              ? {
                  ...msg,
                  text: result.text,
                  ...(result.artifacts.length > 0
                    ? { artifacts: result.artifacts }
                    : {}),
                }
              : msg,
          ),
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
          setSending(false);
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
          // Re-stamp a *queued* bubble to its real dispatch time. Its original
          // `createdAt` is the enqueue moment (when the user tapped send while
          // the prior turn was still streaming); any messages that landed
          // during that wait carry later timestamps, so leaving the enqueue
          // time would let `sortByCreatedAt` slot this row into the past, above
          // those interleaved messages, instead of where it was actually sent.
          // An immediate (un-queued) send already dispatches at creation time,
          // so it keeps its original stamp. The local merge
          // (`mergeMessagesById`) and post-turn reconcile
          // (`reconcileSentDesktopTurn`) both preserve this local `createdAt`,
          // so the row holds this position when sync reconciles.
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
    setSending(true);
    void dispatchRef.current?.(next);
  }, []);

  useEffect(() => {
    drainQueueRef.current = drainQueue;
  }, [drainQueue]);

  const send = useCallback(() => {
    // Don't dispatch until hydration has restored the persisted transcript and
    // sync cursor: sending earlier lets the async load overwrite the optimistic
    // bubble, and lets the landing sync fire mid-stream against a fresh cursor.
    // The draft is left intact so the queued tap lands once we're loaded.
    if (!storageLoaded) return;
    const text = draft.trim();
    if (!text && attachments.length === 0) return;

    if (!hasAiConsent()) {
      requestAiConsent();
      return;
    }

    const assets = attachments.slice();
    setDraft("");
    setAttachments([]);

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
      ...(sending ? { queued: true } : {}),
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
    if (sending) {
      queueRef.current.push(item);
    } else {
      setSending(true);
      void dispatch(item);
    }
  }, [attachments, dispatch, draft, sending, storageLoaded]);

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
    setSending(false);
    setWorkingActivity(IDLE_WORKING_ACTIVITY);
  }, []);

  const workingIndicator = useMemo(
    () => buildWorkingIndicatorState({ sending, activity: workingActivity }),
    [sending, workingActivity],
  );

  const conversationArtifacts = useMemo(() => {
    const seen = new Set<string>();
    const out: ChatArtifact[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      for (const artifact of messages[i].artifacts ?? []) {
        // Agent-work cards are inline-chat only — not openable files, so they
        // don't belong in the artifacts browser (tapping one would hit the
        // viewer's "no preview" path).
        if (artifact.payload.kind === "agent-work") continue;
        if (seen.has(artifact.id)) continue;
        seen.add(artifact.id);
        out.push(artifact);
        if (out.length >= MAX_LISTED_ARTIFACTS) return out;
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
    if (!desktopAccess) return;
    if (!storageLoaded) return;
    if (!hasRunningConversationTask) return;
    const handle = setInterval(() => {
      void runDesktopSync();
    }, 5_000);
    return () => clearInterval(handle);
  }, [desktopAccess, hasRunningConversationTask, runDesktopSync, storageLoaded]);

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
  };
}
