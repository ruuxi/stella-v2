"use client";

import {
  CalendarCheck,
  Check,
  FileSpreadsheet,
  Loader,
  MessageCircle,
  Send,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { StellaMiniChat } from "./stella-mini-chat";
import styles from "./home-single-chat.module.css";

type Exchange = {
  icon: typeof Send;
  label: string;
  top: number;
  user: string;
  reply: string;
};

// Each request chip fires its own exchange into the one chat.
const EXCHANGES: Exchange[] = [
  {
    icon: CalendarCheck,
    label: "Plan the weekend",
    top: 8,
    user: "Plan Saturday around dinner and the school form.",
    reply:
      "Booked 7:30 at Luna Cucina and the form is due Friday — both are on your calendar.",
  },
  {
    icon: Send,
    label: "Text the team",
    top: 30,
    user: "Text the group that we're on for 7:30.",
    reply: "Sent. Maya and Ben are in — Maya's bringing dessert.",
  },
  {
    icon: FileSpreadsheet,
    label: "Build a spreadsheet",
    top: 52,
    user: "Turn these receipts into a budget sheet.",
    reply: "Done — totals by store, with the cheaper one highlighted.",
  },
  {
    icon: Loader,
    label: "Run in the background",
    top: 74,
    user: "Watch flight prices to Lisbon for me.",
    reply: "Watching daily. I'll flag anything under $250.",
  },
];

export function HomeSingleChat() {
  const sectionRef = useRef<HTMLElement>(null);
  // Chips: < activeIndex are done, === activeIndex is firing, > are idle.
  const [activeIndex, setActiveIndex] = useState(-1);
  const onActiveIndexChange = useCallback((index: number) => {
    setActiveIndex(index);
  }, []);
  const shownIndex = activeIndex;

  return (
    <section
      className={`grid-shell section-border home-atlas-section ${styles.section}`}
      data-reveal
      ref={sectionRef}
    >
      <div
        className="home-atlas-heading"
        data-reveal-child
        style={{ ["--reveal-index" as string]: 0 }}
      >
        <h2>One chat for everything.</h2>
      </div>

      <div className="home-atlas-scene home-atlas-scene--reverse">
        <div
          className="home-atlas-copy"
          data-reveal-child
          style={{ ["--reveal-index" as string]: 2 }}
        >
          <span className="home-atlas-kicker">
            <MessageCircle size={15} strokeWidth={1.9} aria-hidden="true" />
            One chat
          </span>
          <p>
            No more juggling threads. Fire off a plan, a file, a message, and a
            background task at once — they all flow into the same conversation
            and come back together.
          </p>
        </div>

        <div
          className={`home-atlas-media home-atlas-media--right ${styles.media}`}
          data-reveal-child
          style={{ ["--reveal-index" as string]: 1 }}
          aria-hidden="true"
        >
          <div className={styles.diagram}>
            <div className={styles.inputs}>
              {EXCHANGES.map((exchange, i) => {
                const state =
                  i < shownIndex ? "done" : i === shownIndex ? "firing" : "idle";
                return (
                  <div
                    className={styles.node}
                    key={exchange.label}
                    data-state={state}
                    style={{ ["--top" as string]: `${exchange.top}%` }}
                  >
                    <span className={styles.nodeIcon}>
                      {state === "done" ? (
                        <Check size={14} strokeWidth={2.2} aria-hidden="true" />
                      ) : (
                        <exchange.icon
                          size={15}
                          strokeWidth={1.9}
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <span className={styles.nodeLabel}>{exchange.label}</span>
                  </div>
                );
              })}
            </div>

            <svg
              className={styles.connectors}
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="oneChatFlow" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stopColor="rgba(82, 104, 134, 0.18)" />
                  <stop offset="1" stopColor="rgba(37, 99, 235, 0.6)" />
                </linearGradient>
              </defs>
              {EXCHANGES.map((exchange, i) => (
                <path
                  key={exchange.label}
                  data-firing={i === shownIndex || undefined}
                  d={`M0 ${exchange.top} C 58 ${exchange.top}, 42 50, 100 50`}
                />
              ))}
            </svg>

            <div className={styles.frame}>
              <span className={styles.merge} aria-hidden="true" />
              <StellaMiniChat
                className={styles.miniWindow}
                themeId="sage"
                exchanges={EXCHANGES.map((exchange) => ({
                  user: exchange.user,
                  reply: exchange.reply,
                }))}
                onActiveIndexChange={onActiveIndexChange}
                observeRef={sectionRef}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
