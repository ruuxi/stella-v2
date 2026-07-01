/**
 * Headless bridge between CarPlay's imperative templates and Stella's existing
 * mobile plumbing. It mounts once (inside the auth/Convex providers, so tokens
 * resolve) and stays mounted for the app's lifetime, but renders nothing.
 *
 * It deliberately reuses — never re-implements — the app's pipelines:
 *   • send + response  → {@link useChatThread} on the cloud transport (the same
 *     `/api/mobile/offline-chat/stream` flow the Chat tab uses), on a dedicated
 *     "carplay" transcript so it never races the Chat tab's "cloud" store.
 *   • dictation        → {@link useDictation} (the same `/api/mobile/transcribe`
 *     push-to-talk recorder the composer mic uses).
 *   • text-to-speech   → {@link speakReply} from read-aloud (the same Inworld
 *     TTS the chat "read aloud" button uses), so replies sound identical.
 *
 * The hands-free loop: tap → record → stop → transcribe → send → await reply →
 * auto-speak it → offer one-tap replay. {@link carPlaySession} owns the actual
 * CarPlay templates; this component just drives its phases.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { isGuest } from "../lib/guest-mode";
import { getOrCreateMobileDeviceId } from "../lib/phone-access";
import { useChatThread } from "../lib/use-chat-thread";
import { useDictation } from "../lib/dictation";
import { speakReply, stopReadAloud, useReadAloudState } from "../lib/read-aloud";
import { carPlayLog, carPlaySession, type CarPlayPhase } from "./carplay-session";
import { RECENT_REPLY_COUNT, type RecentReply } from "./carplay-home";

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

function CarPlayBridgeIOS() {
  const guest = isGuest();
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);

  const transport = useMemo(
    () => ({ kind: "cloud" as const, guest }),
    [guest],
  );
  const thread = useChatThread({ threadId: "carplay", transport });
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
  // While true, we're still watching `messages` for this turn's reply to land.
  const watchingReplyRef = useRef(false);
  const replyGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Converse mode: while ON (the default — it preserves the v1 hands-free
  // loop), the reply to a dictated message auto-plays via TTS on arrival.
  // While OFF the reply row is just marked "New" for a later tap.
  const converseOnRef = useRef(true);
  // First-seen timestamps for assistant replies whose rows predate the
  // `createdAt` field (legacy persisted transcripts) — keeps the relative
  // timestamps stable instead of re-stamping on every render.
  const seenAtRef = useRef(new Map<string, number>());

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Surface the newest assistant replies (newest first) as home-list rows.
  useEffect(() => {
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
  }, [messages]);

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
  // the home surface to idle. Returns false when no *new* reply (one past
  // `priorReplyIdRef`) is present yet, so callers can keep waiting instead of
  // giving up.
  const trySpeakLatestReply = useCallback(() => {
    const reply = [...messagesRef.current]
      .reverse()
      .find((m) => m.role === "assistant" && m.text.trim().length > 0);
    if (!reply || reply.id === priorReplyIdRef.current) return false;
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

  useEffect(() => {
    if (!guest) return;
    void getOrCreateMobileDeviceId().then(setMobileDeviceId);
  }, [guest]);

  const dictationHeaders = useMemo(() => {
    if (!guest || !mobileDeviceId) return undefined;
    return { "X-Stella-Mobile-Device-Id": mobileDeviceId };
  }, [guest, mobileDeviceId]);

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
    anonymous: guest,
    headers: dictationHeaders,
    onTranscript,
  });

  // Tap-to-talk toggle from the CarPlay home row: tap to start dictation, tap
  // again to stop listening and send. Tapping while Stella is speaking
  // interrupts the read-back and starts listening (barge-in).
  const onTalk = useCallback(() => {
    if (dictation.status === "idle") {
      if (phaseRef.current === "speaking") stopReadAloud();
      carPlayLog("dictation start requested");
      goPhase("listening");
      // If recording never actually begins (AI consent not yet granted, mic
      // permission denied, or the recorder failed to start) the dictation
      // status stays "idle" — so the status-driven safety net below never
      // re-fires and would strand the listening overlay on the head unit.
      // Reconcile straight off the start() result instead.
      void dictation.start().then((started) => {
        carPlayLog(`dictation started=${started}`);
        if (!started && phaseRef.current === "listening") goPhase("idle");
      });
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
    carPlaySession.register();
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
    send();
    // If `send()` no-ops (no turn ever starts), `sending` never flips true and
    // the turn-finished effect never runs — don't hang on "thinking".
    if (sendStartTimerRef.current) clearTimeout(sendStartTimerRef.current);
    sendStartTimerRef.current = setTimeout(() => {
      sendStartTimerRef.current = null;
      if (!awaitingReplyRef.current || sendingRef.current) return;
      awaitingReplyRef.current = false;
      if (
        phaseRef.current === "thinking" ||
        phaseRef.current === "listening"
      ) {
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

  // Stop any in-flight speech if CarPlay drops mid-reply, and clear pending
  // timers so they can't fire against a torn-down component.
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
