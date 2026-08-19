"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useSceneLoop } from "@/lib/use-scene-loop";
import { HomeMiniChatMock } from "./home-desktop-mock";
import mock from "./home-desktop-mock.module.css";
import { Composer } from "./home-mock-composer";
import styles from "./stella-mini-chat.module.css";

export type StellaMiniChatExchange = {
  user: string;
  reply: string;
};

type Message = { role: "user" | "assistant"; text: string };

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

  const { reduced } = useSceneLoop(
    loopRef,
    async ({ sleep, type }) => {
      for (let k = 0; k < exchanges.length; k += 1) {
        const exchange = exchanges[k];
        onActiveIndexChange?.(k);
        await sleep(420);
        await type(exchange.user, setComposerTyped, 22);
        await sleep(240);
        setComposerTyped("");
        setMessages((prev) => [...prev, { role: "user", text: exchange.user }]);
        await sleep(380);
        // The reply streams into one stable node: it mounts empty (showing
        // the thinking dots), then fills word by word — never remounted, so
        // its entry animation only ever runs once.
        setMessages((prev) => [...prev, { role: "assistant", text: "" }]);
        await sleep(820);
        const words = exchange.reply.split(" ");
        for (let w = 1; w <= words.length; w += 1) {
          const text = words.slice(0, w).join(" ");
          setMessages((prev) => {
            const next = prev.slice();
            next[next.length - 1] = { role: "assistant", text };
            return next;
          });
          await sleep(34);
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
    ? exchanges.flatMap((exchange): Message[] => [
        { role: "user", text: exchange.user },
        { role: "assistant", text: exchange.reply },
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
          >
            {shownMessages.map((message, i) => (
              <div key={i} className={styles.entry}>
                <div className={styles.entryInner}>
                  {message.role === "user" ? (
                    <div className={mock.userMessage}>{message.text}</div>
                  ) : (
                    <div className={mock.assistantRow}>
                      {message.text ? (
                        <p className={mock.assistantMessage}>{message.text}</p>
                      ) : (
                        <span className={styles.thinking}>
                          <i />
                          <i />
                          <i />
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <Composer
            showContext={false}
            typed={composerTyped}
            className={mock.chatComposerWrap}
          />
        </div>
      </HomeMiniChatMock>
    </div>
  );
}
