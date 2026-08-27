/**
 * Watches the chat message stream and, when read-aloud is enabled, plays
 * each newly-finalized assistant message via the TTS service.
 *
 * Threshold model:
 *   - When the toggle flips off→on we record `enabledAtMs = Date.now()`.
 *   - Only assistant messages whose `message.timestamp > enabledAtMs`
 *     are ever spoken. This is robust against (a) the renderer's initial
 *     load — messages arriving after the pref does not retroactively
 *     trigger TTS for the whole history — and (b) navigating between
 *     conversations: an existing conversation's history all has older
 *     timestamps than the toggle's enabled-at moment.
 *
 * Spoken turns are tracked in a module-level set so the same reply isn't
 * requested twice when both the full chat and the sidebar render the same
 * conversation in parallel.
 *
 * De-duplication uses a stable `userMessageId + final text` key rather
 * than the message `_id`. A reply is shown first as a synthetic overlay row
 * (one `_id`) and later as its persisted twin (a different, real `_id`);
 * keying on the turn + text means whichever representation we see first
 * speaks the reply, and the other is ignored. Assistant text is delivered
 * whole, so both representations always carry the same final text.
 *
 * Voice-sourced assistant messages (`payload.source === "voice"`) are
 * skipped so the realtime voice agent never gets double-spoken.
 */
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
  /** Trimmed assistant text to speak. */
  text: string;
  /** Stable key shared by the live overlay and its persisted twin. */
  key: string;
};

/**
 * Returns the speakable text + dedupe key for an assistant reply, or null
 * when the message should be skipped (not an assistant reply, voice-sourced,
 * or empty). Assistant messages arrive whole, so every row is final.
 */
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
  // Normalize whitespace so the overlay's chunk-concatenated text and the
  // persisted twin's saved text collapse to the same key.
  const normalized = text.replace(/\s+/g, " ");
  return { text, key: `${turnId}\u0000${normalized}` };
};

export function useReadAloud(messages: readonly MessageRecord[]): void {
  const enabled = useSyncExternalStore(
    readAloudPrefStore.subscribe,
    readAloudPrefStore.getSnapshot,
    readAloudPrefStore.getServerSnapshot,
  );
  // Timestamp (ms) the user transitioned into "enabled". Anything
  // older than this is treated as pre-existing history and skipped.
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

          // Prefer progressive Inworld streaming; fall back to one-shot for
          // the OpenAI voice family, unsupported runtimes, or a stream that
          // fails before any audio arrives.
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
