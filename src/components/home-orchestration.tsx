"use client";

import { CalendarClock, Check, ChevronRight, FileText } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useSceneLoop } from "@/lib/use-scene-loop";
import { HomeMiniChatMock } from "./home-desktop-mock";
import mock from "./home-desktop-mock.module.css";
import { Composer } from "./home-mock-composer";
import chat from "./stella-mini-chat.module.css";
import styles from "./home-orchestration.module.css";

/* ------------------------------------------------------------------ */
/*  Transcript model                                                   */
/* ------------------------------------------------------------------ */

type WorkState = "running" | "done";

type Work = {
  id: string;
  title: string;
  state: WorkState;
  /** Trailing status, e.g. "page 12 of 30" or "8:05 AM · $214". */
  meta?: string;
  /** Produced files, shown as pills under a finished row. */
  files?: string[];
};

type Schedule = {
  name: string;
  cadence: string;
  next: string;
};

type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; works?: Work[]; schedule?: Schedule }
  | { kind: "time"; label: string };

type Pill = { state: "running"; count: number } | { state: "done" };

/* ------------------------------------------------------------------ */
/*  Script content                                                     */
/* ------------------------------------------------------------------ */

const ASK_THREE =
  "Book the 8:05 flight, summarize the PDF, and chase that $42 refund.";
const REPLY_THREE =
  "On it. I'm booking the flight, reading the PDF, and chasing the refund — I'll keep you posted right here.";
const ASK_MAYA = "Also text Maya I'm running 10 late.";
const REPLY_MAYA = "Sent. Maya says no rush.";
const REPLY_REFUND = "Your refund went through — $42 is back on your card.";
const ASK_BRIEF = "Every morning, brief me on my calendar.";
const REPLY_BRIEF =
  "Done. Every morning at 8, you'll get a short brief right here.";

const WORK_FLIGHT: Work = {
  id: "flight",
  title: "Booking the 8:05 flight",
  state: "running",
};
const WORK_PDF: Work = {
  id: "pdf",
  title: "Summarizing the PDF",
  state: "running",
};
const WORK_REFUND: Work = {
  id: "refund",
  title: "Chasing the $42 refund",
  state: "running",
};

const SCHEDULE_BRIEF: Schedule = {
  name: "Morning calendar brief",
  cadence: "Daily 8:00 AM",
  next: "tomorrow 8:00 AM",
};

/* The settled frame reduced-motion visitors see instead of the animation:
   every beat in its finished state, trimmed to fit the window. */
const FINAL_ENTRIES: Entry[] = [
  { kind: "user", text: ASK_THREE },
  {
    kind: "assistant",
    text: REPLY_THREE,
    works: [
      {
        ...WORK_FLIGHT,
        state: "done",
        title: "Booked the flight",
        meta: "8:05 AM · $214",
      },
      {
        ...WORK_PDF,
        state: "done",
        title: "Summarized the PDF",
        files: ["q3-summary.md"],
      },
      { ...WORK_REFUND, state: "done", title: "Got the $42 refund" },
    ],
  },
  { kind: "time", label: "2:14 PM" },
  { kind: "assistant", text: REPLY_REFUND },
  { kind: "user", text: ASK_BRIEF },
  { kind: "assistant", text: REPLY_BRIEF, schedule: SCHEDULE_BRIEF },
];

const BEATS = [
  {
    kicker: "Three things, one message",
    copy: "Name three things — or ten. She starts on all of them while you keep typing.",
  },
  {
    kicker: "She gets back to you",
    copy: "When something finishes, the answer lands in the same conversation.",
  },
  {
    kicker: "Set it once",
    copy: "Ask for it every morning, and it happens every morning.",
  },
] as const;

const SUMMARY =
  `You: ${ASK_THREE} Stella: ${REPLY_THREE} Booked the flight, 8:05 AM, $214. Summarized the PDF. ` +
  `You: ${ASK_MAYA} Stella: ${REPLY_MAYA} Later, Stella: ${REPLY_REFUND} ` +
  `You: ${ASK_BRIEF} Stella: ${REPLY_BRIEF} Scheduled: ${SCHEDULE_BRIEF.name}, ${SCHEDULE_BRIEF.cadence}, next ${SCHEDULE_BRIEF.next}.`;

/* ------------------------------------------------------------------ */
/*  Product-accurate pieces                                            */
/* ------------------------------------------------------------------ */

/* The working glyph on an in-progress row: a quiet spinner arc. Slow and
   low-contrast; under reduced motion it holds still and reads as a
   progress ring. */
function WorkingGlyph() {
  return (
    <svg
      className={styles.working}
      viewBox="0 0 16 16"
      width={13}
      height={13}
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="5.5"
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeWidth="1.5"
      />
      <path
        d="M8 2.5A5.5 5.5 0 0 1 13.5 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WorkRow({ work }: { work: Work }) {
  const running = work.state === "running";
  return (
    <div className={styles.workEnter}>
      <div className={styles.workEnterInner}>
        <div className={styles.workRow} data-state={work.state}>
          <span className={styles.workGlyph}>
            {running ? <WorkingGlyph /> : <Check size={13} strokeWidth={1.75} />}
          </span>
          <span className={styles.workTitle}>
            {running ? (
              <span className={styles.shimmer}>{work.title}</span>
            ) : (
              work.title
            )}
          </span>
          {work.meta ? (
            <span className={styles.workMeta} key={work.meta}>
              {work.meta}
            </span>
          ) : null}
          <ChevronRight
            className={styles.workChevron}
            size={13}
            strokeWidth={1.9}
          />
        </div>
        {work.files?.length ? (
          <div className={styles.filePills}>
            {work.files.map((file) => (
              <span className={styles.filePill} key={file}>
                <FileText size={12} strokeWidth={1.9} />
                {file}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ScheduleCard({ schedule }: { schedule: Schedule }) {
  return (
    <div className={styles.workEnter}>
      <div className={styles.workEnterInner}>
        <div className={styles.scheduleCard}>
          <div className={styles.scheduleMain}>
            <span className={styles.scheduleName}>{schedule.name}</span>
            <span className={styles.scheduleMeta}>
              <CalendarClock size={12} strokeWidth={1.9} />
              <span>{schedule.cadence}</span>
              <span className={styles.scheduleSep}>·</span>
              <span>{schedule.next}</span>
            </span>
          </div>
          <div className={styles.scheduleActions}>
            <span className={styles.pillButton}>Run now</span>
            <span className={styles.pillButton}>Pause</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActivityPill({ pill }: { pill: Pill | null }) {
  return (
    <div className={styles.pillRow} aria-hidden="true">
      {pill ? (
        <span className={styles.activityPill} data-state={pill.state}>
          {pill.state === "done" ? (
            <>
              <Check size={12} strokeWidth={2} />
              Finished
            </>
          ) : (
            <span className={styles.shimmer}>
              {pill.count === 1 ? "1 task in progress" : `${pill.count} tasks in progress`}
            </span>
          )}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

export function HomeOrchestration() {
  const sectionRef = useRef<HTMLElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [composerTyped, setComposerTyped] = useState("");
  const [pill, setPill] = useState<Pill | null>(null);
  const [clearing, setClearing] = useState(false);
  const [activeBeat, setActiveBeat] = useState(-1);

  const reset = useCallback(() => {
    setEntries([]);
    setComposerTyped("");
    setPill(null);
    setClearing(false);
    setActiveBeat(-1);
  }, []);

  const { reduced } = useSceneLoop(
    sectionRef,
    async ({ sleep, type }) => {
      const push = (entry: Entry) =>
        setEntries((prev) => [...prev, entry]);
      const patchLast = (patch: (entry: Entry) => Entry) =>
        setEntries((prev) => {
          if (prev.length === 0) return prev;
          const next = prev.slice();
          next[next.length - 1] = patch(next[next.length - 1]);
          return next;
        });
      const patchWork = (id: string, patch: Partial<Work>) =>
        setEntries((prev) =>
          prev.map((entry) =>
            entry.kind === "assistant" && entry.works?.some((w) => w.id === id)
              ? {
                  ...entry,
                  works: entry.works.map((w) =>
                    w.id === id ? { ...w, ...patch } : w,
                  ),
                }
              : entry,
          ),
        );
      const addWork = (work: Work) =>
        patchLast((entry) =>
          entry.kind === "assistant"
            ? { ...entry, works: [...(entry.works ?? []), work] }
            : entry,
        );
      // A reply streams into one stable node: it mounts empty (thinking
      // dots), then fills word by word — never remounted, so its entry
      // animation only runs once.
      const reply = async (text: string, thinkMs = 760) => {
        push({ kind: "assistant", text: "" });
        await sleep(thinkMs);
        const words = text.split(" ");
        for (let w = 1; w <= words.length; w += 1) {
          const partial = words.slice(0, w).join(" ");
          patchLast((entry) =>
            entry.kind === "assistant" ? { ...entry, text: partial } : entry,
          );
          await sleep(34);
        }
      };
      const ask = async (text: string) => {
        await type(text, setComposerTyped, 20);
        await sleep(240);
        setComposerTyped("");
        push({ kind: "user", text });
      };

      /* Beat 1 — three requests in one message, progress inline. */
      setActiveBeat(0);
      await sleep(420);
      await ask(ASK_THREE);
      await sleep(380);
      await reply(REPLY_THREE);
      await sleep(260);
      addWork(WORK_FLIGHT);
      await sleep(180);
      addWork(WORK_PDF);
      await sleep(180);
      addWork(WORK_REFUND);
      setPill({ state: "running", count: 3 });
      await sleep(900);

      /* The chat never goes busy — a second request lands mid-flight. */
      await ask(ASK_MAYA);
      await sleep(300);
      patchWork("pdf", { meta: "page 12 of 30" });
      await reply(REPLY_MAYA, 620);
      await sleep(520);
      patchWork("flight", {
        state: "done",
        title: "Booked the flight",
        meta: "8:05 AM · $214",
      });
      setPill({ state: "running", count: 2 });
      await sleep(980);
      patchWork("pdf", {
        state: "done",
        title: "Summarized the PDF",
        meta: undefined,
        files: ["q3-summary.md"],
      });
      setPill({ state: "running", count: 1 });
      await sleep(1400);

      /* Beat 2 — a slow one reports back later, unprompted. */
      setActiveBeat(1);
      push({ kind: "time", label: "2:14 PM" });
      await sleep(560);
      patchWork("refund", { state: "done", title: "Got the $42 refund" });
      setPill({ state: "done" });
      await sleep(360);
      await reply(REPLY_REFUND, 520);
      await sleep(900);
      setPill(null);
      await sleep(1100);

      /* Beat 3 — set it once, it recurs. */
      setActiveBeat(2);
      await ask(ASK_BRIEF);
      await sleep(380);
      await reply(REPLY_BRIEF);
      await sleep(320);
      patchLast((entry) =>
        entry.kind === "assistant"
          ? { ...entry, schedule: SCHEDULE_BRIEF }
          : entry,
      );
      await sleep(3600);

      // Breathe the conversation out before the loop resets it.
      setClearing(true);
      await sleep(450);
    },
    reset,
  );

  const shownEntries = reduced ? FINAL_ENTRIES : entries;
  const beatsLive = !reduced && activeBeat >= 0;

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
        <h2>Ask for three things at once.</h2>
      </div>

      <div className="home-atlas-scene">
        <div
          className={`home-atlas-media home-atlas-media--left ${styles.media}`}
          data-reveal-child
          style={{ ["--reveal-index" as string]: 1 }}
        >
          <p className={styles.srOnly}>{SUMMARY}</p>
          <div className={styles.frame}>
            <HomeMiniChatMock className={styles.window} themeId="pearl">
              <div className={styles.liveChat} aria-hidden="true">
                <div
                  className={styles.transcript}
                  data-clearing={clearing || undefined}
                >
                  {shownEntries.map((entry, i) => (
                    <div key={i} className={chat.entry}>
                      <div className={chat.entryInner}>
                        {entry.kind === "user" ? (
                          <div className={mock.userMessage}>{entry.text}</div>
                        ) : entry.kind === "time" ? (
                          <div className={styles.timeDivider}>{entry.label}</div>
                        ) : (
                          <div className={styles.assistantBlock}>
                            <div className={mock.assistantRow}>
                              {entry.text ? (
                                <p className={mock.assistantMessage}>
                                  {entry.text}
                                </p>
                              ) : (
                                <span className={chat.thinking}>
                                  <i />
                                  <i />
                                  <i />
                                </span>
                              )}
                            </div>
                            {entry.works?.length ? (
                              <div className={styles.workGroup}>
                                {entry.works.map((work) => (
                                  <WorkRow key={work.id} work={work} />
                                ))}
                              </div>
                            ) : null}
                            {entry.schedule ? (
                              <ScheduleCard schedule={entry.schedule} />
                            ) : null}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <ActivityPill pill={pill} />
                <Composer
                  showContext={false}
                  typed={composerTyped}
                  className={mock.chatComposerWrap}
                />
              </div>
            </HomeMiniChatMock>
          </div>
        </div>

        <div
          className={`home-atlas-copy home-atlas-copy--right ${styles.copy}`}
          data-reveal-child
          style={{ ["--reveal-index" as string]: 2 }}
        >
          <div className={styles.beats} data-live={beatsLive || undefined}>
            {BEATS.map((beat, i) => (
              <div
                key={beat.kicker}
                className={styles.beat}
                data-active={(beatsLive && i === activeBeat) || undefined}
              >
                <span className="home-atlas-kicker">
                  {beat.kicker}
                </span>
                <p>{beat.copy}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
