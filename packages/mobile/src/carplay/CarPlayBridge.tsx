import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { isGuest } from "../lib/guest-mode";
import {
  getDesktopBridgeStatus,
  getOrCreateMobileDeviceId,
  getPreferredPhoneAccess,
  type StoredPhoneAccess,
} from "../lib/phone-access";
import { loadLastMainTab } from "../lib/last-main-tab";
import {
  getVoiceTargetPreference,
  loadVoiceTargetPreference,
  reachabilityFromProbe,
  resolveVoiceTarget,
  setVoiceTargetPreference,
  subscribeVoiceTargetPreference,
  type VoiceTarget,
  type VoiceTargetPreference,
} from "../lib/voice-target";
import { useChatThread, type ChatTransport } from "../lib/use-chat-thread";
import { useDictation } from "../lib/dictation";
import { speakReply, startAfterStoppingReadAloud, stopReadAloud, useReadAloudState } from "../lib/read-aloud";
import { carPlayLog, carPlaySession, type CarPlayPhase } from "./carplay-session";
import { RECENT_REPLY_COUNT, type RecentReply } from "./carplay-home";
import { pickTurnReply } from "./turn-reply";

const REPLY_GRACE_MS = 1500;

const SEND_START_TIMEOUT_MS = 1500;

export function CarPlayBridge() {

  if (Platform.OS !== "ios") return null;
  return <CarPlayBridgeIOS />;
}

function CarPlayBridgeIOS() {
  const guest = isGuest();
  const [access, setAccess] = useState<StoredPhoneAccess | null>(null);
  const [preference, setPreferenceState] = useState<VoiceTargetPreference>(
    () => getVoiceTargetPreference(),
  );
  const [connected, setConnected] = useState(false);
  const [target, setTarget] = useState<VoiceTarget>("phone");

  useEffect(() => {

    carPlayLog("CarPlayBridge mounted");

    const unsubscribe = carPlaySession.onConnectionChange(setConnected);
    carPlaySession.register();
    setConnected(carPlaySession.isConnected());
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (guest) return;
    void getPreferredPhoneAccess().then(setAccess);
  }, [guest]);

  useEffect(() => {
    const unsubscribe = subscribeVoiceTargetPreference(setPreferenceState);
    void loadVoiceTargetPreference();
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      const paired = Boolean(access);
      let lastMainTab: string | null = null;
      let computerReachable: boolean | null = null;
      if (preference === "auto" && paired) {
        lastMainTab = await loadLastMainTab();
        if (cancelled) return;
        if (lastMainTab === "computer" && access) {

          computerReachable = reachabilityFromProbe(
            await getDesktopBridgeStatus(access.desktopDeviceId).catch(
              () => null,
            ),
          );
          if (cancelled) return;
        }
      }
      const next = resolveVoiceTarget({
        preference,
        paired,
        lastMainTab,
        computerReachable,
      });
      carPlayLog(
        `voice target resolved -> ${next} (pref=${preference} paired=${paired} lastTab=${lastMainTab ?? "?"} reachable=${computerReachable ?? "?"})`,
      );
      setTarget(next);
    };
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [preference, access, connected]);

  useEffect(() => {
    carPlaySession.setVoiceTarget(target, Boolean(access));
  }, [target, access]);

  const onToggleVoiceTarget = useCallback(() => {
    if (!access) return;
    const next: VoiceTargetPreference =
      target === "computer" ? "phone" : "computer";
    carPlayLog(`voice target toggled from CarPlay -> ${next}`);
    void setVoiceTargetPreference(next);
  }, [access, target]);

  const effectiveTarget: VoiceTarget =
    target === "computer" && access && connected ? "computer" : "phone";

  return (
    <CarPlayVoiceLoop
      key={effectiveTarget}
      target={effectiveTarget}
      access={effectiveTarget === "computer" ? access : null}
      guest={guest}
      onToggleVoiceTarget={onToggleVoiceTarget}
    />
  );
}

function CarPlayVoiceLoop({
  target,
  access,
  guest,
  onToggleVoiceTarget,
}: {
  target: VoiceTarget;
  access: StoredPhoneAccess | null;
  guest: boolean;
  onToggleVoiceTarget: () => void;
}) {
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);

  const transport = useMemo<ChatTransport>(
    () =>
      target === "computer" && access
        ? { kind: "desktop" as const, access }
        : { kind: "cloud" as const, guest },
    [target, access, guest],
  );
  const threadId = transport.kind === "desktop" ? "carplay-computer" : "carplay";
  const thread = useChatThread({ threadId, transport });
  const { setDraft, send, messages, sending, storageLoaded, runDesktopSync } =
    thread;

  const readAloud = useReadAloudState();

  const pendingSendRef = useRef<string | null>(null);
  const awaitingReplyRef = useRef(false);
  const prevSendingRef = useRef(false);
  const lastReplyTextRef = useRef("");
  const phaseRef = useRef<CarPlayPhase>("idle");

  const messagesRef = useRef(messages);

  const sendingRef = useRef(sending);

  const priorReplyIdRef = useRef<string | null>(null);

  const sentUserMessageIdRef = useRef<string | null>(null);

  const watchingReplyRef = useRef(false);
  const replyGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const converseOnRef = useRef(carPlaySession.getConverseMode());

  const seenAtRef = useRef(new Map<string, number>());

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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

  const onTalk = useCallback(() => {
    if (dictation.status === "idle") {
      carPlayLog("dictation start requested");
      goPhase("listening");

      void startAfterStoppingReadAloud(() => dictation.start()).then((started) => {
        carPlayLog(`dictation started=${started}`);
        if (!started && phaseRef.current === "listening") goPhase("idle");
      });
    } else if (dictation.status === "recording") {
      carPlayLog("dictation stop requested (send)");
      goPhase("thinking");
      void dictation.stop();
    }

  }, [dictation, goPhase]);

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

  const onReadLatest = useCallback(() => {
    const newest = [...messagesRef.current]
      .reverse()
      .find((m) => m.role === "assistant" && m.text.trim().length > 0);
    if (newest) onReadReply(newest.id);
  }, [onReadReply]);

  const onToggleConverse = useCallback(() => {
    converseOnRef.current = !converseOnRef.current;
    carPlayLog(`converse mode -> ${converseOnRef.current ? "on" : "off"}`);
    carPlaySession.setConverseMode(converseOnRef.current);
  }, []);

  useEffect(() => {
    carPlaySession.bindActions({
      onTalk,
      onReadReply,
      onReadLatest,
      onToggleConverse,
      onToggleVoiceTarget,
    });
  }, [onTalk, onReadReply, onReadLatest, onToggleConverse, onToggleVoiceTarget]);

  useEffect(() => {
    carPlayLog("voice loop mounted");
    goPhase("idle");
  }, [goPhase]);

  useEffect(() => {
    if (transport.kind !== "desktop") return;
    if (!storageLoaded) return;
    void runDesktopSync({ catchUp: true });
  }, [transport.kind, storageLoaded, runDesktopSync]);

  useEffect(() => {
    const pending = pendingSendRef.current;
    if (!pending) return;
    if (!storageLoaded) return;
    if (thread.draft.trim() !== pending) return;
    if (sending) return;
    pendingSendRef.current = null;
    awaitingReplyRef.current = true;

    const priorReply = [...messagesRef.current]
      .reverse()
      .find((m) => m.role === "assistant" && m.text.trim().length > 0);
    priorReplyIdRef.current = priorReply?.id ?? null;
    const dispatched = send();
    sentUserMessageIdRef.current = dispatched?.userMessageId ?? null;

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

  useEffect(() => {
    sendingRef.current = sending;
    if (sending && sendStartTimerRef.current) {
      clearTimeout(sendStartTimerRef.current);
      sendStartTimerRef.current = null;
    }
  }, [sending]);

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

  useEffect(() => {
    if (!watchingReplyRef.current) return;
    if (trySpeakLatestReply()) clearReplyGrace();
  }, [messages, trySpeakLatestReply, clearReplyGrace]);

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

  useEffect(() => {
    return () => {
      stopReadAloud();
      if (replyGraceTimerRef.current) clearTimeout(replyGraceTimerRef.current);
      if (sendStartTimerRef.current) clearTimeout(sendStartTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (readAloud === null && phaseRef.current === "speaking") {
      goPhase("idle");
    }
  }, [readAloud, goPhase]);

  return null;
}
