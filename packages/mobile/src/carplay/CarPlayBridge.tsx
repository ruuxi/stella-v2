/**
 * Headless bridge between CarPlay's imperative templates and Stella's existing
 * mobile plumbing. It mounts once (inside the auth/Convex providers, so tokens
 * resolve) and stays mounted for the app's lifetime, but renders nothing.
 *
 * It deliberately reuses — never re-implements — the app's pipelines:
 *   • send + response  → {@link useCloudCanonicalChatThread}, i.e. the SAME
 *     cloud conversation the Chat tab reads. A dictated turn therefore lands
 *     in the one chat, and its execution placement (paired computer first,
 *     cloud otherwise) is the server's decision exactly as on the phone. Only
 *     the optimistic outbox is separate ("carplay"), so the always-mounted
 *     bridge never races the tab's queue.
 *   • dictation        → {@link useDictation} (the same Muse realtime stream
 *     push-to-talk recorder the composer mic uses).
 *   • text-to-speech   → {@link speakReply} from read-aloud (the same Inworld
 *     TTS the chat "read aloud" button uses), so replies sound identical.
 *
 * Account-free use has a Better Auth anonymous owner, so both anonymous and
 * connected sessions resolve the same cloud-canonical conversation pipeline.
 *
 * The hands-free loop: tap → record → stop → transcribe → send → await reply →
 * auto-speak it → offer one-tap replay. {@link carPlaySession} owns the actual
 * CarPlay templates; this component just drives its phases.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { authClient } from "../lib/auth-client";
import {
  useCloudCanonicalChatThread,
  useCloudConversationAuthority,
} from "../lib/use-cloud-canonical-chat-thread";
import type { CloudConversationAuthority } from "../lib/cloud-conversation-authority";
import { useDictation } from "../lib/dictation";
import {
  speakReply,
  startAfterStoppingReadAloud,
  stopReadAloud,
  useReadAloudState,
} from "../lib/read-aloud";
import {
  carPlayLog,
  carPlaySession,
  type CarPlayPhase,
} from "./carplay-session";
import { RECENT_REPLY_COUNT, type RecentReply } from "./carplay-home";
import { pickTurnReply } from "./turn-reply";

/**
 * Grace window for the assistant reply row that can land a render tick after
 * `sending` flips false. We keep watching `messages` this long before giving
 * up on speaking, so a late read-back isn't silently dropped.
 */
const REPLY_GRACE_MS = 1500;
/**
 * Insurance for the (today unreachable) case where `send()` early-returns
 * without starting a turn — e.g. storage not loaded, empty text, or AI consent
 * not yet granted. `sending` never flips true, so the turn-finished effect
 * never runs; if no turn materializes within this window we reset to idle
 * rather than hanging "thinking" on the head unit.
 */
const SEND_START_TIMEOUT_MS = 1500;

export function CarPlayBridge() {
  // CarPlay is iOS-only; `Platform.OS` is constant at runtime, so this gate is
  // stable and never changes the hook order below.
  if (Platform.OS !== "ios") return null;
  return <CarPlayBridgeIOS />;
}

/**
 * Owns the CarPlay session registration and mounts the voice loop only while a
 * head unit is attached, so the always-mounted bridge doesn't hold the cloud
 * conversation's journal socket open for the app's whole lifetime.
 */
function CarPlayBridgeIOS() {
  const session = authClient.useSession();
  const hasSession = Boolean(session.data);
  const anonymous = session.data?.user?.isAnonymous === true;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // First [js] breadcrumb of a healthy run. If a diagnostics dump has native
    // lines but not this one, the React tree never mounted the bridge (env
    // gating, provider crash, or JS never ran at all).
    carPlayLog("CarPlayBridge mounted");
    // Subscribe before register(): register can replay an already-connected
    // session synchronously, and we must not miss that first callback.
    const unsubscribe = carPlaySession.onConnectionChange(setConnected);
    carPlaySession.register();
    setConnected(carPlaySession.isConnected());
    return unsubscribe;
  }, []);

  useEffect(() => {
    carPlaySession.setSignedIn(hasSession);
  }, [hasSession]);

  if (!hasSession || !connected) return null;
  return <CarPlayCloudChatGate anonymous={anonymous} />;
}

/**
 * Resolves the one signed-in cloud conversation the head unit talks to. Until
 * it verifies, the home keeps its idle rows: a dictated turn has nowhere to go
 * yet, and the loop's own send guard would reject it anyway.
 */
function CarPlayCloudChatGate({ anonymous }: { anonymous: boolean }) {
  const authority = useCloudConversationAuthority();
  if (authority.status !== "ready") return null;
  return (
    <CarPlayVoiceLoop
      key={`${authority.authority.accountScope}:${authority.authority.ownerGeneration}:${authority.authority.conversationId}`}
      authority={authority.authority}
      reloadAuthority={authority.retry}
      anonymous={anonymous}
    />
  );
}

function CarPlayVoiceLoop({
  authority,
  reloadAuthority,
  anonymous,
}: {
  authority: CloudConversationAuthority;
  reloadAuthority: () => void;
  anonymous: boolean;
}) {
  // The head unit's own optimistic outbox, so a queued dictated turn is never
  // drained twice by the Chat tab's copy of the same conversation.
  const thread = useCloudCanonicalChatThread(authority, {
    reloadAuthority,
    threadId: "carplay",
  });
  const { setDraft, send, messages, sending, storageLoaded } = thread;

  const readAloud = useReadAloudState();

  // The transcript text we're waiting to dispatch once the draft state catches
  // up, plus flags tracking the in-flight turn and the last spoken reply.
  const pendingSendRef = useRef<string | null>(null);
  const awaitingReplyRef = useRef(false);
  const prevSendingRef = useRef(false);
  const lastReplyTextRef = useRef("");
  const phaseRef = useRef<CarPlayPhase>("idle");
  // Latest `messages` snapshot for reads outside render (grace timer/effect).
  const messagesRef = useRef(messages);
  // Mirror of `sending` for the send-start guard timer.
  const sendingRef = useRef(sending);
  // Id of the newest assistant reply that existed *before* the current turn, so
  // the grace re-check only speaks a genuinely new reply, never a stale one.
  const priorReplyIdRef = useRef<string | null>(null);
  // Local id of the turn's optimistic user bubble (reported by `send()`), so
  // the auto-speak picks THIS turn's reply structurally — the journal can catch
  // up with older replies the loop had never seen, and "newest reply that
  // changed" would speak one of those instead.
  const sentUserMessageIdRef = useRef<string | null>(null);
  // While true, we're still watching `messages` for this turn's reply to land.
  const watchingReplyRef = useRef(false);
  const replyGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Converse mode: while ON (the default — it preserves the v1 hands-free
  // loop), the reply to a dictated message auto-plays via TTS on arrival.
  // While OFF the reply row is just marked "New" for a later tap. Seeded from
  // the session so a loop remount keeps the driver's choice.
  const converseOnRef = useRef(carPlaySession.getConverseMode());
  // First-seen timestamps for assistant replies whose rows predate the
  // `createdAt` field (legacy persisted transcripts) — keeps the relative
  // timestamps stable instead of re-stamping on every render.
  const seenAtRef = useRef(new Map<string, number>());

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Surface the newest assistant replies (newest first) as home-list rows.
  // Skipped while a turn is in flight: the reply row is appended empty and
  // then grows as each message segment lands, and pushing every intermediate
  // state would rebuild the native CarPlay template repeatedly mid-turn. When
  // `sending` flips false this effect re-runs and pushes the settled
  // transcript once.
  useEffect(() => {
    if (sending) return;
    const replies: RecentReply[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant" || !msg.text.trim()) continue;
      let at = msg.createdAt;
      if (at === undefined) {
        at = seenAtRef.current.get(msg.id) ?? Date.now();
        seenAtRef.current.set(msg.id, at);
      }
      replies.push({ id: msg.id, text: msg.text, at });
      if (replies.length >= RECENT_REPLY_COUNT) break;
    }
    carPlaySession.setRecentReplies(replies);
  }, [messages, sending]);

  // Single entry point for phase changes so we keep a local mirror (the session
  // is imperative and doesn't expose its phase back to React).
  const goPhase = useCallback((phase: CarPlayPhase) => {
    phaseRef.current = phase;
    carPlaySession.setPhase(phase);
  }, []);

  const clearReplyGrace = useCallback(() => {
    watchingReplyRef.current = false;
    if (replyGraceTimerRef.current) {
      clearTimeout(replyGraceTimerRef.current);
      replyGraceTimerRef.current = null;
    }
  }, []);

  // Handle this turn's assistant reply if it has actually landed: converse
  // mode ON auto-speaks it; OFF leaves the reply row marked "New" and returns
  // the home surface to idle. The reply is located structurally (the first
  // assistant row after this turn's user bubble — see `pickTurnReply`), never
  // as "newest reply that changed". Returns false while the turn's reply
  // hasn't landed yet, so callers keep waiting instead of giving up.
  const trySpeakLatestReply = useCallback(() => {
    const reply = pickTurnReply(messagesRef.current, {
      sentUserMessageId: sentUserMessageIdRef.current,
      priorReplyId: priorReplyIdRef.current,
    });
    if (!reply) return false;
    sentUserMessageIdRef.current = null;
    lastReplyTextRef.current = reply.text;
    if (!converseOnRef.current) {
      goPhase("idle");
      return true;
    }
    carPlaySession.setReplyPreview(reply.text);
    carPlaySession.markReplyRead(reply.id);
    carPlayLog("TTS start (auto-read reply)");
    goPhase("speaking");
    void speakReply(reply.text, reply.id);
    return true;
  }, [goPhase]);

  const onTranscript = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        goPhase("idle");
        return;
      }
      // Park the transcript and prime the composer draft; the effect below
      // dispatches it through the real send pipeline once the draft settles.
      pendingSendRef.current = trimmed;
      goPhase("thinking");
      setDraft(trimmed);
    },
    [goPhase, setDraft],
  );

  const dictation = useDictation({
    anonymous,
    onTranscript,
  });

  // Tap-to-talk toggle from the CarPlay home row: tap to start dictation, tap
  // again to stop listening and send. Tapping while Stella is speaking
  // interrupts the read-back and starts listening (barge-in).
  const onTalk = useCallback(() => {
    if (dictation.status === "idle") {
      carPlayLog("dictation start requested");
      goPhase("listening");
      // If recording never actually begins (AI consent not yet granted, mic
      // permission denied, or the recorder failed to start) the dictation
      // status stays "idle" — so the status-driven safety net below never
      // re-fires and would strand the listening overlay on the head unit.
      // Reconcile straight off the start() result instead.
      void startAfterStoppingReadAloud(() => dictation.start()).then(
        (started) => {
          carPlayLog(`dictation started=${started}`);
          if (!started && phaseRef.current === "listening") goPhase("idle");
        },
      );
    } else if (dictation.status === "recording") {
      carPlayLog("dictation stop requested (send)");
      goPhase("thinking");
      void dictation.stop();
    }
    // While transcribing/thinking, ignore taps — the loop is mid-flight.
  }, [dictation, goPhase]);

  // A recent-reply row was tapped: read THAT message aloud (not necessarily
  // the newest one).
  const onReadReply = useCallback(
    (id: string) => {
      const message = messagesRef.current.find((m) => m.id === id);
      if (!message || !message.text.trim()) return;
      lastReplyTextRef.current = message.text;
      carPlaySession.setReplyPreview(message.text);
      carPlaySession.markReplyRead(message.id);
      carPlayLog("TTS start (tapped reply row)");
      goPhase("speaking");
      void speakReply(message.text, message.id);
    },
    [goPhase],
  );

  // Dedicated "read the newest reply" row.
  const onReadLatest = useCallback(() => {
    const newest = [...messagesRef.current]
      .reverse()
      .find((m) => m.role === "assistant" && m.text.trim().length > 0);
    if (newest) onReadReply(newest.id);
  }, [onReadReply]);

  // Converse-mode toggle row.
  const onToggleConverse = useCallback(() => {
    converseOnRef.current = !converseOnRef.current;
    carPlayLog(`converse mode -> ${converseOnRef.current ? "on" : "off"}`);
    carPlaySession.setConverseMode(converseOnRef.current);
  }, []);

  // Keep the session bound to the latest closures.
  useEffect(() => {
    carPlaySession.bindActions({
      onTalk,
      onReadReply,
      onReadLatest,
      onToggleConverse,
    });
  }, [onTalk, onReadReply, onReadLatest, onToggleConverse]);

  useEffect(() => {
    carPlayLog("voice loop mounted");
    // An authority remount starts a fresh loop: make sure the head unit isn't
    // stuck showing the previous loop's phase.
    goPhase("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dispatch the parked transcript once the draft state reflects it.
  useEffect(() => {
    const pending = pendingSendRef.current;
    if (!pending) return;
    if (!storageLoaded) return;
    if (thread.draft.trim() !== pending) return;
    if (sending) return;
    pendingSendRef.current = null;
    awaitingReplyRef.current = true;
    // Snapshot the newest existing reply so the turn-finished/grace path only
    // speaks a genuinely new one.
    const priorReply = [...messagesRef.current]
      .reverse()
      .find((m) => m.role === "assistant" && m.text.trim().length > 0);
    priorReplyIdRef.current = priorReply?.id ?? null;
    const dispatched = send();
    sentUserMessageIdRef.current = dispatched?.userMessageId ?? null;
    // If `send()` no-ops (no turn ever starts), `sending` never flips true and
    // the turn-finished effect never runs — don't hang on "thinking".
    if (sendStartTimerRef.current) clearTimeout(sendStartTimerRef.current);
    sendStartTimerRef.current = setTimeout(() => {
      sendStartTimerRef.current = null;
      if (!awaitingReplyRef.current || sendingRef.current) return;
      awaitingReplyRef.current = false;
      if (phaseRef.current === "thinking" || phaseRef.current === "listening") {
        goPhase("idle");
      }
    }, SEND_START_TIMEOUT_MS);
  }, [thread.draft, storageLoaded, sending, send, goPhase]);

  // Mirror `sending` and cancel the send-start guard the moment a real turn
  // begins (so the guard only ever fires for a send that never started).
  useEffect(() => {
    sendingRef.current = sending;
    if (sending && sendStartTimerRef.current) {
      clearTimeout(sendStartTimerRef.current);
      sendStartTimerRef.current = null;
    }
  }, [sending]);

  // When a turn finishes, grab the assistant reply, auto-speak it, and surface
  // the now-playing replay card. The reply row can land a render tick after
  // `sending` flips false, so if it isn't here yet we keep watching `messages`
  // for a short grace window before falling back to idle.
  useEffect(() => {
    const wasSending = prevSendingRef.current;
    prevSendingRef.current = sending;
    if (!(wasSending && !sending && awaitingReplyRef.current)) return;
    awaitingReplyRef.current = false;
    if (trySpeakLatestReply()) return;

    watchingReplyRef.current = true;
    if (replyGraceTimerRef.current) clearTimeout(replyGraceTimerRef.current);
    replyGraceTimerRef.current = setTimeout(() => {
      replyGraceTimerRef.current = null;
      if (!watchingReplyRef.current) return;
      watchingReplyRef.current = false;
      if (!trySpeakLatestReply() && phaseRef.current === "thinking") {
        goPhase("idle");
      }
    }, REPLY_GRACE_MS);
  }, [sending, trySpeakLatestReply, goPhase]);

  // While in the grace window, retry as soon as a new `messages` snapshot lands.
  useEffect(() => {
    if (!watchingReplyRef.current) return;
    if (trySpeakLatestReply()) clearReplyGrace();
  }, [messages, trySpeakLatestReply, clearReplyGrace]);

  // Safety net: if dictation ends without producing a turn (silence, denied
  // mic, or a cancelled recording), don't leave the listening/thinking surface
  // stuck — fall back to idle. Guarded so it never disturbs a live reply.
  useEffect(() => {
    if (dictation.status !== "idle") return;
    if (
      pendingSendRef.current ||
      awaitingReplyRef.current ||
      watchingReplyRef.current
    ) {
      return;
    }
    if (phaseRef.current === "listening" || phaseRef.current === "thinking") {
      goPhase("idle");
    }
  }, [dictation.status, goPhase]);

  // Stop any in-flight speech if CarPlay drops mid-reply (or the loop remounts
  // for a new authority), and clear pending timers so they can't fire against a
  // torn-down component.
  useEffect(() => {
    return () => {
      stopReadAloud();
      if (replyGraceTimerRef.current) clearTimeout(replyGraceTimerRef.current);
      if (sendStartTimerRef.current) clearTimeout(sendStartTimerRef.current);
    };
  }, []);

  // When the TTS clip finishes (playback state clears), flip the talk row back
  // to idle so the home surface never claims "Stella is speaking" after the
  // audio stopped.
  useEffect(() => {
    if (readAloud === null && phaseRef.current === "speaking") {
      goPhase("idle");
    }
  }, [readAloud, goPhase]);

  return null;
}
