/**
 * Full-shell side of the companion: this renderer owns the chat runtime, so
 * it publishes the small `CompanionState` snapshot the floating companion
 * draws, and executes the sends / stops the companion relays back.
 *
 * Publishing is diffed and throttled (~12 Hz while a reply streams) and
 * pauses entirely while the companion is hidden. The very first publish is
 * unconditional: main treats it as this renderer's "ready" signal and flushes
 * any send the companion queued while the shell was still booting.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { MessageRecord } from "@stella/contracts/local-chat";
import type {
  CompanionMessagePreview,
  CompanionState,
} from "@stella/contracts/desktop/companion";
import { useChatMessages } from "@/context/use-chat-messages";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { countActiveTopLevelActivityWorkUnits } from "@/features/chat/lib/event-transforms";
import { getWorkingIndicatorCharacterState } from "@/features/chat/working-indicator-state";
import { stripMarkdownForTts } from "@/features/voice/services/read-aloud/markdown-strip";
import { readAloudPrefStore } from "@/features/voice/services/read-aloud/read-aloud-pref";
import { isReadAloudPlaying } from "@/features/voice/services/read-aloud/read-aloud-player";
import { useCompanionVisible } from "./use-companion-window";

const PUBLISH_THROTTLE_MS = 80;
const READ_ALOUD_POLL_MS = 300;
const USER_PREVIEW_MAX_CHARS = 400;
const ASSISTANT_PREVIEW_MAX_CHARS = 700;

type MessagePayload = {
  text?: unknown;
  metadata?: {
    ui?: { visibility?: unknown };
    runtime?: { isStreaming?: unknown };
  };
};

// Every timeline update re-derives the latest previews, but the latest reply
// rarely changes between updates. Remember the last conversion per preview
// size so an unchanged message skips the full-text markdown strip.
const lastPlainPreview = new Map<number, { raw: string; preview: string }>();

const toPlainPreview = (raw: string, maxChars: number): string => {
  const cached = lastPlainPreview.get(maxChars);
  if (cached?.raw === raw) return cached.preview;
  const plain = stripMarkdownForTts(raw).replace(/\s+/g, " ").trim();
  const preview =
    plain.length > maxChars ? `${plain.slice(0, maxChars).trimEnd()}…` : plain;
  lastPlainPreview.set(maxChars, { raw, preview });
  return preview;
};

const latestUserPreview = (
  messages: readonly MessageRecord[],
): CompanionMessagePreview | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.type !== "user_message") continue;
    const payload = (message.payload ?? {}) as MessagePayload;
    if (payload.metadata?.ui?.visibility === "hidden") continue;
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) continue;
    const plain = toPlainPreview(text, USER_PREVIEW_MAX_CHARS);
    if (!plain) continue;
    return { id: message._id, text: plain, at: message.timestamp };
  }
  return null;
};

const latestAssistantPreview = (
  messages: readonly MessageRecord[],
): (CompanionMessagePreview & { streaming: boolean }) | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.type !== "assistant_message") continue;
    const payload = (message.payload ?? {}) as MessagePayload;
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    const streaming = payload.metadata?.runtime?.isStreaming === true;
    if (!text && !streaming) continue;
    return {
      id: message._id,
      text: text ? toPlainPreview(text, ASSISTANT_PREVIEW_MAX_CHARS) : "",
      at: message.timestamp,
      streaming,
    };
  }
  return null;
};

export function useCompanionBridge(conversationId: string | null): void {
  const api = window.electronAPI?.companion;
  const messages = useChatMessages();
  const { conversation } = useChatRuntime();
  const {
    tasks,
    isStreaming,
    reasoningText,
    sendContextlessMessage,
    cancelCurrentStream,
  } = conversation;
  const activeToolName = conversation.streaming.activeToolName ?? null;

  const readAloudEnabled = useSyncExternalStore(
    readAloudPrefStore.subscribe,
    readAloudPrefStore.getSnapshot,
    readAloudPrefStore.getServerSnapshot,
  );

  const companionVisible = useCompanionVisible(false);

  // Read-aloud playback has no change event; poll only while it can matter.
  const [readAloudPlaying, setReadAloudPlaying] = useState(false);
  useEffect(() => {
    if (!companionVisible || !readAloudEnabled) {
      setReadAloudPlaying(false);
      return;
    }
    const tick = () => setReadAloudPlaying(isReadAloudPlaying());
    tick();
    const timer = window.setInterval(tick, READ_ALOUD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [companionVisible, readAloudEnabled]);

  const runningAgentCount = useMemo(
    () => countActiveTopLevelActivityWorkUnits(tasks),
    [tasks],
  );
  const latestUser = useMemo(() => latestUserPreview(messages), [messages]);
  const latestAssistant = useMemo(
    () => latestAssistantPreview(messages),
    [messages],
  );

  const snapshot = useMemo<CompanionState>(
    () => ({
      conversationId,
      latestUser,
      latestAssistant,
      isStreaming,
      workState: isStreaming
        ? getWorkingIndicatorCharacterState({
            toolName: activeToolName ?? undefined,
            isReasoning: Boolean(reasoningText),
          })
        : null,
      runningAgentCount,
      readAloudPlaying,
    }),
    [
      conversationId,
      latestUser,
      latestAssistant,
      isStreaming,
      activeToolName,
      reasoningText,
      runningAgentCount,
      readAloudPlaying,
    ],
  );

  const latestRef = useRef(snapshot);
  latestRef.current = snapshot;
  const lastSentRef = useRef<string>("");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!api) return;
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSentRef.current) return;
    const publish = () => {
      const current = latestRef.current;
      lastSentRef.current = JSON.stringify(current);
      api.publishState(current);
    };
    // First publish is the ready handshake — always send it.
    if (!lastSentRef.current) {
      publish();
      return;
    }
    if (!companionVisible) return;
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      publish();
    }, PUBLISH_THROTTLE_MS);
  }, [api, companionVisible, snapshot]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!api) return;
    return api.onSendRequested(({ text }) => {
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!trimmed) return;
      sendContextlessMessage(trimmed, { trigger: { source: "companion" } });
    });
  }, [api, sendContextlessMessage]);

  useEffect(() => {
    if (!api) return;
    return api.onStopRequested(() => {
      cancelCurrentStream();
    });
  }, [api, cancelCurrentStream]);
}

/**
 * Hosts `useCompanionBridge` in its own leaf. The bridge subscribes to the
 * live message timeline; called from the root chrome, that subscription
 * re-rendered the whole shell (top bar, right sidebar, dialogs) on every
 * timeline update. As a leaf, only this null-rendering component does.
 */
export function CompanionBridge({
  conversationId,
}: {
  conversationId: string | null;
}): null {
  useCompanionBridge(conversationId);
  return null;
}
