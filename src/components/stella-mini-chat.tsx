"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useSceneLoop } from "@/lib/use-scene-loop";
import { HomeMiniChatMock } from "./home-desktop-mock";
import mock from "./home-desktop-mock.module.css";
import { Composer } from "./home-mock-composer";
import styles from "./stella-mini-chat.module.css";

export type StellaMiniChatExchange = {
  user: string;
  reply: string;
};

type Message =
  | { id: string; role: "user"; text: string }
  | {
      id: string;
      role: "assistant";
      text: string;
      fullText: string;
      phase: "reserved" | "thinking" | "streaming" | "complete";
    };

export function StellaMiniChat({
  exchanges,
  className,
  themeId = "sage",
  onActiveIndexChange,
  observeRef,
}: {
  exchanges: StellaMiniChatExchange[];
  className?: string;
  themeId?: string;
  onActiveIndexChange?: (index: number) => void;
  observeRef?: RefObject<HTMLElement | null>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef(new Map<string, number>());
  const movementAnimationsRef = useRef(new Map<string, Animation>());
  const loopRef = observeRef ?? rootRef;
  const [messages, setMessages] = useState<Message[]>([]);
  const [composerTyped, setComposerTyped] = useState("");
  const [clearing, setClearing] = useState(false);

  const reset = useCallback(() => {
    setMessages([]);
    setComposerTyped("");
    setClearing(false);
    onActiveIndexChange?.(-1);
  }, [onActiveIndexChange]);

  /* The transcript is bottom-anchored, so new or wrapping content moves the
     rows above it. FLIP that layout delta with compositor-only transforms. */
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;

    const nextPositions = new Map<string, number>();
    for (const child of Array.from(transcript.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const id = child.dataset.messageId;
      if (!id) continue;

      const top = child.offsetTop;
      nextPositions.set(id, top);
      const previousTop = positionsRef.current.get(id);
      if (previousTop === undefined) continue;

      const delta = previousTop - top;
      if (Math.abs(delta) < 0.5) continue;
      movementAnimationsRef.current.get(id)?.cancel();
      const animation = child.animate(
        [
          { transform: `translate3d(0, ${delta}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        {
          duration: 360,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        },
      );
      movementAnimationsRef.current.set(id, animation);
      const forget = () => {
        if (movementAnimationsRef.current.get(id) === animation) {
          movementAnimationsRef.current.delete(id);
        }
      };
      animation.addEventListener("finish", forget, { once: true });
      animation.addEventListener("cancel", forget, { once: true });
    }
    positionsRef.current = nextPositions;
  }, [messages]);

  useEffect(
    () => () => {
      for (const animation of movementAnimationsRef.current.values()) {
        animation.cancel();
      }
      movementAnimationsRef.current.clear();
    },
    [],
  );

  const { reduced } = useSceneLoop(
    loopRef,
    async ({ sleep, frame, type }) => {
      for (let k = 0; k < exchanges.length; k += 1) {
        const exchange = exchanges[k];
        onActiveIndexChange?.(k);
        await sleep(420);
        await type(exchange.user, setComposerTyped, 22);
        await sleep(240);
        setComposerTyped("");
        // Reserve the assistant's final wrapped height in the same commit as
        // the user message. Thinking and streamed text can then appear inside
        // that stable slot without causing a second transcript movement.
        setMessages((prev) => [
          ...prev,
          { id: `user-${k}`, role: "user", text: exchange.user },
          {
            id: `assistant-${k}`,
            role: "assistant",
            text: "",
            fullText: exchange.reply,
            phase: "reserved",
          },
        ]);
        await sleep(380);
        setMessages((prev) => {
          const next = prev.slice();
          const assistant = next[next.length - 1];
          if (assistant?.role === "assistant") {
            next[next.length - 1] = { ...assistant, phase: "thinking" };
          }
          return next;
        });
        await sleep(820);
        const startedAt = performance.now();
        let visibleLength = 0;
        while (visibleLength < exchange.reply.length) {
          const now = await frame();
          const nextLength = Math.min(
            exchange.reply.length,
            Math.max(1, Math.floor((now - startedAt) / 11) + 1),
          );
          if (nextLength === visibleLength) continue;
          visibleLength = nextLength;
          const text = exchange.reply.slice(0, visibleLength);
          setMessages((prev) => {
            const next = prev.slice();
            next[next.length - 1] = {
              id: `assistant-${k}`,
              role: "assistant",
              text,
              fullText: exchange.reply,
              phase:
                visibleLength === exchange.reply.length
                  ? "complete"
                  : "streaming",
            };
            return next;
          });
        }
        await sleep(420);
      }
      onActiveIndexChange?.(exchanges.length);
      await sleep(3200);
      // Fade the conversation out before the loop resets it, so the
      // restart reads as a deliberate beat instead of a snap.
      setClearing(true);
      await sleep(450);
    },
    reset,
  );

  useEffect(() => {
    if (reduced) onActiveIndexChange?.(exchanges.length);
  }, [reduced, exchanges.length, onActiveIndexChange]);

  const shownMessages = reduced
    ? exchanges.flatMap((exchange, index): Message[] => [
        { id: `user-${index}`, role: "user", text: exchange.user },
        {
          id: `assistant-${index}`,
          role: "assistant",
          text: exchange.reply,
          fullText: exchange.reply,
          phase: "complete",
        },
      ])
    : messages;

  const summary = exchanges
    .map((exchange) => `You: ${exchange.user} Stella: ${exchange.reply}`)
    .join(" ");

  return (
    <div className={styles.root} ref={rootRef}>
      <p className={styles.srOnly}>{summary}</p>
      <HomeMiniChatMock
        className={className ? `${styles.window} ${className}` : styles.window}
        themeId={themeId}
      >
        <div className={styles.liveChat} aria-hidden="true">
          <div
            className={styles.liveTranscript}
            data-clearing={clearing || undefined}
            ref={transcriptRef}
          >
            {shownMessages.map((message) => (
              <div
                key={message.id}
                className={styles.entry}
                data-message-id={message.id}
                data-role={message.role}
                data-phase={
                  message.role === "assistant" ? message.phase : undefined
                }
              >
                <div className={styles.entryInner}>
                  {message.role === "user" ? (
                    <div className={mock.userMessage}>{message.text}</div>
                  ) : (
                    <div
                      className={`${mock.assistantRow} ${styles.assistantSlot}`}
                    >
                      <p
                        className={`${mock.assistantMessage} ${styles.assistantSizer}`}
                      >
                        {message.fullText}
                      </p>
                      {message.phase !== "reserved" ? (
                        <div className={styles.assistantVisual}>
                          {message.text ? (
                            <p
                              className={`${mock.assistantMessage} ${styles.assistantContent}`}
                            >
                              {message.text}
                            </p>
                          ) : (
                            <span className={styles.thinking}>
                              <i />
                              <i />
                              <i />
                            </span>
                          )}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {shownMessages.length > 0 ? (
              <div className={styles.responseSpacer} aria-hidden="true" />
            ) : null}
          </div>
          <Composer
            showContext={false}
            typed={composerTyped}
            className={`${mock.chatComposerWrap} ${styles.composerDock}`}
          />
        </div>
      </HomeMiniChatMock>
    </div>
  );
}
