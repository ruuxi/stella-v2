import { useEffect, useRef, useSyncExternalStore } from "react";
import type { MessageRecord } from "@stella/contracts/local-chat";
import { stripMarkdownForTts } from "./markdown-strip";
import { fetchReadAloudAudio, openReadAloudStream } from "./tts-client";
import {
  canStreamReadAloud,
  playReadAloud,
  playReadAloudStream,
  stopReadAloud,
} from "./read-aloud-player";
import { readAloudPrefStore } from "./read-aloud-pref";
import { resolveReadAloudVoicePrefs } from "./read-aloud-voice-prefs";

const spokenTurnKeys = new Set<string>();

type MessagePayload = {
  text?: unknown;
  source?: unknown;
  userMessageId?: unknown;
};

type FinalizedReply = {

  text: string;

  key: string;
};

const getFinalizedReply = (message: MessageRecord): FinalizedReply | null => {
  if (message.type !== "assistant_message") return null;
  const payload = (message.payload ?? {}) as MessagePayload;
  if (payload.source === "voice") return null;
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return null;
  const turnId =
    typeof payload.userMessageId === "string" && payload.userMessageId
      ? payload.userMessageId
      : message._id;

  const normalized = text.replace(/\s+/g, " ");
  return { text, key: `${turnId}\u0000${normalized}` };
};

export function useReadAloud(messages: readonly MessageRecord[]): void {
  const enabled = useSyncExternalStore(
    readAloudPrefStore.subscribe,
    readAloudPrefStore.getSnapshot,
    readAloudPrefStore.getServerSnapshot,
  );

  const enabledAtMsRef = useRef<number | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) {
      stopReadAloud();
      enabledAtMsRef.current = null;
      return;
    }
    if (enabledAtMsRef.current === null) {
      enabledAtMsRef.current = Date.now();
    }
    const threshold = enabledAtMsRef.current;
    for (const message of messages) {
      if (
        typeof message.timestamp !== "number" ||
        message.timestamp <= threshold
      ) {
        continue;
      }
      const reply = getFinalizedReply(message);
      if (reply === null) continue;
      if (spokenTurnKeys.has(reply.key)) continue;
      spokenTurnKeys.add(reply.key);
      const clean = stripMarkdownForTts(reply.text);
      if (!clean) continue;
      void (async () => {
        try {
          const prefs = await resolveReadAloudVoicePrefs();
          if (!enabledRef.current) return;

          if (prefs.family === "inworld" && canStreamReadAloud()) {
            try {
              const response = await openReadAloudStream({
                text: clean,
                voice: prefs.voice,
                speed: prefs.speed,
              });
              if (!enabledRef.current) {
                await response.body?.cancel().catch(() => undefined);
                return;
              }
              await playReadAloudStream(response);
              return;
            } catch (streamErr) {
              console.warn(
                "[read-aloud] streaming failed, falling back:",
                streamErr,
              );
              if (!enabledRef.current) return;
            }
          }

          const { audio } = await fetchReadAloudAudio({
            text: clean,
            voiceProvider: prefs.family,
            voice: prefs.voice,
            speed: prefs.speed,
          });
          if (!enabledRef.current) return;
          await playReadAloud(audio);
        } catch (err) {
          console.warn("[read-aloud] playback failed:", err);
        }
      })();
    }
  }, [enabled, messages]);
}
