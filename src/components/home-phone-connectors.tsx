"use client";

import { Smartphone } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./home-phone-connectors.module.css";
import { StellaMark } from "@/components/stella-mark";

type Bubble = { from: "them" | "you"; text: string };

/* ------------------------------------------------------------------ */
/*  Reusable iPhone frame                                             */
/* ------------------------------------------------------------------ */
function PhoneFrame({
  children,
  statusDark,
}: {
  children: ReactNode;
  statusDark?: boolean;
}) {
  return (
    <div className={styles.phone}>
      <div className={styles.phoneEdge}>
        <div className={styles.screen}>
          <div className={styles.statusBar} data-dark={statusDark || undefined}>
            <span className={styles.statusTime}>9:41</span>
            <span className={styles.statusIcons}>
              <svg
                viewBox="0 0 20 12"
                aria-hidden="true"
                className={styles.signal}
              >
                <rect x="0" y="8" width="3" height="4" rx="1" />
                <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
                <rect x="10" y="3" width="3" height="9" rx="1" />
                <rect x="15" y="0.5" width="3" height="11.5" rx="1" />
              </svg>
              <svg
                viewBox="0 0 18 13"
                aria-hidden="true"
                className={styles.wifi}
              >
                <path
                  d="M9 12.2 1 5.6a12 12 0 0 1 16 0Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  opacity="0.4"
                />
                <path
                  d="M9 12.2 4.2 8.2a7 7 0 0 1 9.6 0Z"
                  fill="currentColor"
                />
              </svg>
              <svg
                viewBox="0 0 27 13"
                aria-hidden="true"
                className={styles.battery}
              >
                <rect
                  x="0.6"
                  y="0.6"
                  width="22"
                  height="11.8"
                  rx="3.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                  opacity="0.45"
                />
                <rect
                  x="2.2"
                  y="2.2"
                  width="17"
                  height="8.6"
                  rx="1.8"
                  fill="currentColor"
                />
                <rect
                  x="24"
                  y="4"
                  width="1.8"
                  height="5"
                  rx="0.9"
                  fill="currentColor"
                  opacity="0.45"
                />
              </svg>
            </span>
          </div>
          <div className={styles.island} />
          {children}
        </div>
      </div>
      <span className={styles.homeIndicator} />
    </div>
  );
}
/* ------------------------------------------------------------------ */
/*  Stella app skin                                                  */
/* ------------------------------------------------------------------ */
const stellaThread: Bubble[] = [
  { from: "you", text: "What was I working on before lunch?" },
  {
    from: "them",
    text: "You were comparing flights to Lisbon and had the budget spreadsheet open.",
  },
  { from: "them", text: "Want me to pull it back up?" },
  { from: "you", text: "Yes, and book the cheapest morning one." },
  {
    from: "them",
    text: "Booked the 8:05 AM — $214. Added it to your calendar.",
  },
];

function StellaSkin() {
  return (
    <PhoneFrame statusDark>
      <div className={`${styles.app} ${styles.stella}`}>
        <div className={styles.stGradient} />
        <header className={styles.stHeader}>
          <span className={styles.stMenu}>
            <i />
            <i />
            <i />
          </span>
          <span className={styles.stBrand}>
            <StellaMark size={20} />
            Stella
          </span>
          <span className={styles.stModel}>4.5</span>
        </header>
        <div className={`${styles.thread} ${styles.stThread}`}>
          {stellaThread.map((b, i) =>
            b.from === "you" ? (
              <div
                key={i}
                className={styles.stYou}
                style={{ ["--b" as string]: i }}
                data-beat
              >
                {b.text}
              </div>
            ) : (
              <p
                key={i}
                className={styles.stAssistant}
                style={{ ["--b" as string]: i }}
                data-beat
              >
                {b.text}
              </p>
            ),
          )}
        </div>
        <div className={styles.stComposer}>
          <i className={styles.stPlus}>+</i>
          <span>Do anything…</span>
          <i className={styles.stMic} />
        </div>
      </div>
    </PhoneFrame>
  );
}

export function HomePhoneConnectors() {
  const sectionRef = useRef<HTMLElement>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    // Under reduced motion the mockup stays static.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(
      ([entry]) => setRunning(entry.isIntersecting),
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

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
        <h2>Text Stella.</h2>
      </div>

      <div className="home-atlas-scene home-atlas-scene--reverse">
        <div
          className="home-atlas-copy"
          data-reveal-child
          style={{ ["--reveal-index" as string]: 2 }}
        >
          <span className="home-atlas-kicker">
            <Smartphone size={15} strokeWidth={1.9} aria-hidden="true" />
            The Stella app
          </span>
          <p>
            Text Stella from the mobile app. Every message reaches the same
            assistant on your computer.
          </p>
        </div>

        <div
          className={`home-atlas-media home-atlas-media--right ${styles.media}`}
          data-reveal-child
          style={{ ["--reveal-index" as string]: 1 }}
        >
          <div className={styles.stage} aria-hidden="true">
            <div className={styles.slot} data-active={running || undefined}>
              <StellaSkin />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
