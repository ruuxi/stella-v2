"use client";

import {
  AppWindow,
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock,
  ClipboardList,
  Download,
  Ellipsis,
  ExternalLink,
  Inbox,
  LayoutGrid,
  Link as LinkIcon,
  Mail,
  MailOpen,
  Menu,
  Mic,
  MoreVertical,
  Paperclip,
  Pencil,
  Plus,
  Printer,
  Puzzle,
  Reply,
  RotateCw,
  Search,
  Send,
  Settings,
  Share,
  SlidersHorizontal,
  Smile,
  Star,
  Tag,
  Trash2,
  Type,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useSceneLoop } from "@/lib/use-scene-loop";
import { StellaMark } from "@/components/stella-mark";
import { HomeMiniChatMock } from "./home-desktop-mock";
import mock from "./home-desktop-mock.module.css";
import { Composer } from "./home-mock-composer";
import chat from "./stella-mini-chat.module.css";
import styles from "./home-real-work.module.css";

/* ------------------------------------------------------------------ */
/*  Transcript model                                                   */
/* ------------------------------------------------------------------ */

type WorkState = "running" | "done";

type Work = {
  id: string;
  title: string;
  state: WorkState;
  /** Trailing status, e.g. "Marcus Hale · Tue" or "ends Oct 31". */
  meta?: string;
};

type ConnectPhase = "offer" | "connecting" | "connected";

type Connect = {
  phase: ConnectPhase;
  /** Brief pressed look on the Connect button before the hand-off. */
  pressed?: boolean;
};

type Entry =
  | { kind: "user"; text: string; attachment?: string }
  | {
      kind: "assistant";
      text: string;
      works?: Work[];
      connect?: Connect;
      /** A little page Stella made, shown as a chip with an Open affordance. */
      page?: string;
    };

type Pill = { state: "running"; count: number } | { state: "done" };

/* What the action window is showing. The chat is how you ask; this is
   the work itself. */
type MailStep = "inbox" | "filtered" | "thread" | "reply" | "sent";
type BrowserStep = "account" | "form" | "offer" | "confirm" | "done";

type Action =
  | { scene: "none" }
  | { scene: "consent"; allowed: boolean }
  | { scene: "mail"; step: MailStep }
  | { scene: "page"; rows: number; tag: boolean; verdict: boolean }
  | { scene: "browser"; step: BrowserStep; reason: boolean; agreed: boolean };

type Cursor = { at: string; click?: boolean } | null;

type Layout = "wide" | "stacked";

/* ------------------------------------------------------------------ */
/*  Script content                                                     */
/* ------------------------------------------------------------------ */

const ASK_EMAIL =
  "Find the email from my landlord about renewing the lease — tell him we're in, but ask if he can keep rent the same.";
const REPLY_NEED = "I'll need a look at your inbox for that.";
const REPLY_ON_IT = "On it.";
const REPLY_EMAIL_DONE =
  "Done — I told Marcus you're in for another 12 months and asked if he'd keep rent at $1,450. I'll let you know when he writes back.";

const ASK_APTS = "Help me pick between these apartments";
const ASK_APTS_ATTACHMENT = "Pasted text · 5 listings";
const REPLY_SEC = "Give me a sec.";
const REPLY_APTS_DONE =
  "Here you go — I put together a little page so you can see them side by side. Elm St wins once you count the commute.";
const PAGE_NAME = "Apartment comparison";

const ASK_GYM = "Cancel my gym membership. Don't let them talk you out of it.";
const REPLY_GYM =
  "On it — I've got their site open in your browser, signed in as you.";
const REPLY_GYM_DONE =
  "Done. They offered you three months at half price to stay — I said no thanks. Your access ends Oct 31, and the confirmation's in your inbox.";

const WORK_SEARCH: Work = {
  id: "search",
  title: "Searching your inbox",
  state: "running",
};
const WORK_REPLY: Work = {
  id: "reply",
  title: "Writing the reply",
  state: "running",
};
const WORK_COMPARE: Work = {
  id: "compare",
  title: "Comparing listings",
  state: "running",
};
const WORK_GYM: Work = {
  id: "gym",
  title: "Canceling membership",
  state: "running",
};

const MAIL_SEARCH = "lease renewal";
const MAIL_REPLY =
  "Hi Marcus — we're in for another 12 months. Any chance rent could stay at $1,450? Thanks! — Sam";
const GYM_EMAIL = "sam.rivera@gmail.com";

const MAIL_ROWS = [
  {
    from: "Ridgeline Fitness",
    subject: "Your October statement is ready",
    snippet: "Unlimited membership · $54.00 · Next payment Nov 1",
    time: "8:40 AM",
    unread: true,
    match: false,
    starred: false,
  },
  {
    from: "Jess Okafor",
    subject: "friday??",
    snippet: "ok but are we doing the 7pm or the late show — I can do either honestly",
    time: "Oct 15",
    unread: false,
    match: false,
    starred: true,
  },
  {
    from: "Marcus Hale",
    subject: "Lease renewal — 14 Elm St",
    snippet: "Hi Sam — your lease at 14 Elm St is up on Nov 30. We'd love to have you stay…",
    time: "Oct 14",
    unread: true,
    match: true,
    starred: false,
  },
  {
    from: "Mom",
    subject: "Thanksgiving",
    snippet: "Are you flying in Wednesday or Thursday? Dad wants to know for the car",
    time: "Oct 14",
    unread: false,
    match: false,
    starred: false,
  },
  {
    from: "Lemonade",
    subject: "Your lease renewal checklist",
    snippet: "Renewing soon? Here's what to check on your renters policy before you sign",
    time: "Oct 12",
    unread: false,
    match: true,
    starred: false,
  },
  {
    from: "Google Flights",
    subject: "Denver from $89 round trip",
    snippet: "Prices dropped on 3 of your tracked routes · SFO → DEN, Nov 26 – Dec 1",
    time: "Oct 11",
    unread: false,
    match: false,
    starred: false,
  },
  {
    from: "Priya Natarajan, me (3)",
    subject: "Re: Q4 planning doc",
    snippet: "Left a few comments in the doc — mostly on the timeline section",
    time: "Oct 10",
    unread: false,
    match: false,
    starred: false,
  },
  {
    from: "Figma",
    subject: "Weekly digest",
    snippet: "3 files were edited this week · 12 new comments",
    time: "Oct 9",
    unread: false,
    match: false,
    starred: false,
  },
  {
    from: "Chase",
    subject: "Your October statement is available",
    snippet: "View your statement for the account ending in 8821",
    time: "Oct 8",
    unread: false,
    match: false,
    starred: false,
  },
  {
    from: "Alex Chen",
    subject: "Photos from Saturday",
    snippet: "Finally went through them all — the one of you on the rocks is great",
    time: "Oct 7",
    unread: false,
    match: false,
    starred: false,
  },
] as const;

const APARTMENTS = [
  {
    name: "14 Elm St",
    detail: "1 bd · 640 ft² · In-unit laundry · Top floor",
    price: "$1,450",
    commute: 22,
    trueCost: "$1,681",
    bar: 0.45,
    tone: 0,
  },
  {
    name: "Maple Court",
    detail: "1 bd · 590 ft² · Pets OK · Parking",
    price: "$1,610",
    commute: 12,
    trueCost: "$1,736",
    bar: 0.59,
    tone: 1,
  },
  {
    name: "The Foundry",
    detail: "Studio · 480 ft² · Gym downstairs · No laundry",
    price: "$1,390",
    commute: 35,
    trueCost: "$1,757",
    bar: 0.64,
    tone: 2,
  },
  {
    name: "9 Grant Ave",
    detail: "1 bd · 610 ft² · No parking · Street noise",
    price: "$1,300",
    commute: 48,
    trueCost: "$1,804",
    bar: 0.76,
    tone: 3,
  },
  {
    name: "Riverside Lofts",
    detail: "1 bd · 700 ft² · Rooftop · Doorman",
    price: "$1,700",
    commute: 18,
    trueCost: "$1,889",
    bar: 0.97,
    tone: 4,
  },
] as const;

/* Tiny façade thumbnails: sky, a building with a window grid, a roofline and
   ground, tinted per listing. Reads as a listing photo at 36–44 px. */
const APT_TONES = [
  { sky: "#dbe9f7", wall: "#c9a97e", trim: "#8f6f47", ground: "#9bb08a" },
  { sky: "#e3edf5", wall: "#9fb58a", trim: "#5f7a4c", ground: "#c7b48c" },
  { sky: "#dde5ee", wall: "#8ea0b6", trim: "#55687f", ground: "#b9b4a6" },
  { sky: "#e8e4f0", wall: "#a79ebd", trim: "#6b6187", ground: "#a3a89a" },
  { sky: "#f0e3df", wall: "#c49289", trim: "#8a5a52", ground: "#9fb6a8" },
] as const;

function AptPhoto({ tone }: { tone: number }) {
  const t = APT_TONES[tone % APT_TONES.length];
  const windows: React.ReactNode[] = [];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      windows.push(
        <rect
          key={`${r}-${c}`}
          x={9 + c * 7}
          y={13 + r * 6.5}
          width={4}
          height={4.2}
          rx={0.6}
          fill="rgba(255,255,255,0.78)"
        />,
      );
    }
  }
  return (
    <svg className={styles.aptPhoto} viewBox="0 0 36 36" aria-hidden="true">
      <rect width="36" height="36" fill={t.sky} />
      <circle cx="28" cy="8" r="3.2" fill="rgba(255,255,255,0.9)" />
      <rect x="0" y="29" width="36" height="7" fill={t.ground} />
      <rect x="5" y="9" width="24" height="21" fill={t.wall} />
      <rect x="3.5" y="7.5" width="27" height="2.5" rx="0.6" fill={t.trim} />
      {windows}
      <rect x="15.5" y="23.5" width="5" height="6.5" rx="0.6" fill={t.trim} />
    </svg>
  );
}

const ACTS = [
  { label: "Reads your inbox" },
  { label: "Makes you a page" },
  { label: "Works in your browser" },
] as const;

/* The settled frame reduced-motion visitors see instead of the animation:
   the first two beats in their finished state, and the page Stella built. */
const FINAL_ENTRIES: Entry[] = [
  { kind: "user", text: ASK_EMAIL },
  { kind: "assistant", text: REPLY_NEED, connect: { phase: "connected" } },
  {
    kind: "assistant",
    text: REPLY_ON_IT,
    works: [
      {
        ...WORK_SEARCH,
        state: "done",
        title: "Found the thread",
        meta: "Marcus Hale · Tue",
      },
      { ...WORK_REPLY, state: "done", title: "Reply sent" },
    ],
  },
  { kind: "assistant", text: REPLY_EMAIL_DONE },
  { kind: "user", text: ASK_APTS, attachment: ASK_APTS_ATTACHMENT },
  {
    kind: "assistant",
    text: REPLY_APTS_DONE,
    works: [{ ...WORK_COMPARE, state: "done", title: "Compared the listings" }],
    page: PAGE_NAME,
  },
];

const FINAL_ACTION: Action = { scene: "page", rows: 5, tag: true, verdict: true };

const SUMMARY =
  `You: ${ASK_EMAIL} Stella: ${REPLY_NEED} Connect Gmail? You connect; Gmail connected. ` +
  `Stella: ${REPLY_ON_IT} Found the thread from Marcus Hale. Reply sent: ${MAIL_REPLY} Stella: ${REPLY_EMAIL_DONE} ` +
  `You: ${ASK_APTS} (${ASK_APTS_ATTACHMENT}) Stella: ${REPLY_SEC} Then: ${REPLY_APTS_DONE} A page called ${PAGE_NAME} opens, listing five apartments with rent, commute and true monthly cost; Elm St is marked best value. ` +
  `You: ${ASK_GYM} Stella: ${REPLY_GYM} In the browser, Stella opens the membership page, fills in the cancellation form, declines the stay offer, and confirms. Stella: ${REPLY_GYM_DONE}`;

/* ------------------------------------------------------------------ */
/*  Product-accurate chat pieces                                       */
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

function Grow({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.grow}>
      <div className={styles.growInner}>{children}</div>
    </div>
  );
}

function WorkRow({ work }: { work: Work }) {
  const running = work.state === "running";
  return (
    <Grow>
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
    </Grow>
  );
}

/* The app's inline connect card: an offer with Not now / Connect, a
   waiting state while you finish signing in, then a quiet connected
   state — after which the reply simply continues. */
function ConnectCard({ connect }: { connect: Connect }) {
  const { phase } = connect;
  return (
    <Grow>
      <div className={styles.connectCard} data-phase={phase}>
        <span className={styles.connectIcon}>
          {phase === "connected" ? (
            <Check size={14} strokeWidth={2.1} />
          ) : (
            <Mail size={14} strokeWidth={1.9} />
          )}
        </span>
        <span className={styles.connectBody}>
          <span className={styles.connectTitle}>
            {phase === "offer"
              ? "Connect Gmail?"
              : phase === "connecting"
                ? "Waiting for Gmail"
                : "Gmail connected"}
          </span>
          <span className={styles.connectSub}>
            {phase === "offer"
              ? "So I can find the thread and reply for you."
              : phase === "connecting"
                ? "Finish signing in to Gmail in your browser."
                : "Connected. Continuing with your request."}
          </span>
        </span>
        <span className={styles.connectActions}>
          <span className={styles.connectActionsInner}>
            {phase === "connecting" ? (
              <span className={styles.pillButton}>Cancel</span>
            ) : (
              <>
                <span className={styles.pillButton}>Not now</span>
                <span
                  className={`${styles.pillButton} ${styles.pillButtonPrimary}`}
                  data-pressed={connect.pressed || undefined}
                >
                  Connect
                </span>
              </>
            )}
          </span>
        </span>
      </div>
    </Grow>
  );
}

function PagePill({ name }: { name: string }) {
  return (
    <Grow>
      <span className={styles.pagePill}>
        <AppWindow size={13} strokeWidth={1.9} className={styles.pagePillIcon} />
        <span className={styles.pagePillName}>{name}</span>
        <span className={styles.pagePillOpen}>
          Open
          <ArrowUpRight size={11} strokeWidth={2.1} />
        </span>
      </span>
    </Grow>
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
              {pill.count === 1
                ? "1 task in progress"
                : `${pill.count} tasks in progress`}
            </span>
          )}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Action window: shared chrome                                       */
/* ------------------------------------------------------------------ */

function Pointer() {
  return (
    <svg
      className={styles.pointer}
      width="22"
      height="24"
      viewBox="0 0 22 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 2.2 L3 18.4 L7.1 14.4 L9.9 20.9 L12.7 19.7 L9.9 13.3 L15.4 13.1 Z"
        fill="currentColor"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* Stella's pointer. It finds its target by `data-target` inside the action
   window and glides there, so every mock can be laid out freely without
   hand-tuned coordinates. Positions are design pixels: the stage scales
   them along with everything else. */
function StellaCursor({
  cursor,
  windowRef,
}: {
  cursor: Cursor;
  windowRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [pos, setPos] = useState<{ x: number; y: number; flip: boolean } | null>(
    null,
  );
  const at = cursor?.at;

  useLayoutEffect(() => {
    if (!at) return;
    const win = windowRef.current;
    if (!win) return;
    const measure = () => {
      const target = win.querySelector<HTMLElement>(`[data-target="${at}"]`);
      if (!target) return;
      const scale =
        parseFloat(
          getComputedStyle(win).getPropertyValue("--stage-scale"),
        ) || 1;
      const w = win.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      const fx = parseFloat(target.dataset.targetX ?? "0.5");
      const fy = parseFloat(target.dataset.targetY ?? "0.5");
      const x = (r.left + r.width * fx - w.left) / scale;
      const y = (r.top + r.height * fy - w.top) / scale;
      /* Keep the label off the UI she's about to use: flip it to the left
         near the right edge. */
      setPos({ x, y, flip: x > w.width / scale - 150 });
    };
    measure();
    /* Targets inside growing panels settle a few hundred ms later. */
    const t1 = window.setTimeout(measure, 220);
    const t2 = window.setTimeout(measure, 480);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [at, windowRef]);

  return (
    <div
      className={styles.cursor}
      data-shown={cursor ? "true" : undefined}
      data-click={cursor?.click || undefined}
      data-flip={pos?.flip || undefined}
      style={
        pos
          ? ({ "--cx": `${pos.x}px`, "--cy": `${pos.y}px` } as React.CSSProperties)
          : undefined
      }
    >
      <Pointer />
      <span className={styles.clickRing} />
      <span className={styles.cursorLabel}>
        <span className={styles.cursorLabelMark}>
          <StellaMark size={12} />
        </span>
        Stella
      </span>
    </div>
  );
}

function Lights() {
  return (
    <span className={styles.lights}>
      <i />
      <i />
      <i />
    </span>
  );
}

function Caret() {
  return <span className={styles.caret} aria-hidden="true" />;
}

function Avatar({
  initial,
  tone,
  size = 28,
  className,
}: {
  initial: string;
  tone: number;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`${styles.avatar} ${className ?? ""}`}
      data-tone={tone}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Browser chrome (shared by the consent screen and the gym site)    */
/* ------------------------------------------------------------------ */

function ChromeFrame({
  tabTitle,
  site,
  host,
  path,
  placeholder,
  children,
}: {
  tabTitle: string;
  site: "google" | "ridgeline" | "newtab";
  host?: string;
  path?: string;
  /** Empty omnibox (new tab): placeholder instead of a URL. */
  placeholder?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.app} data-kind="browser">
      <div className={`${styles.titlebar} ${styles.tabStrip}`}>
        <Lights />
        <span className={styles.tab}>
          <span className={styles.favicon} data-site={site} aria-hidden="true" />
          <span className={styles.tabTitle}>{tabTitle}</span>
          <X size={11} strokeWidth={2.2} />
        </span>
        <span className={styles.tabNew}>
          <Plus size={13} strokeWidth={2} />
        </span>
        <span className={styles.tabsRight}>
          <ChevronDown size={13} strokeWidth={2} />
        </span>
      </div>
      <div className={styles.toolbar}>
        <span className={styles.navButtons}>
          <ChevronLeft size={16} strokeWidth={2} />
          <ChevronRight size={16} strokeWidth={2} data-disabled="true" />
          <RotateCw size={13} strokeWidth={2} />
        </span>
        <span className={styles.omnibox}>
          {placeholder ? (
            <>
              <Search size={12} strokeWidth={2} />
              <span className={styles.omniPlaceholder}>{placeholder}</span>
            </>
          ) : (
            <>
              <SlidersHorizontal size={12} strokeWidth={2} />
              <span className={styles.omniHost}>{host}</span>
              <span className={styles.omniPath}>{path}</span>
              <Bookmark size={12} strokeWidth={2} className={styles.omniStar} />
            </>
          )}
        </span>
        <span className={styles.toolbarRight}>
          <Puzzle size={14} strokeWidth={1.9} className={styles.toolbarPuzzle} />
          <Avatar initial="S" tone={1} size={22} />
          <MoreVertical size={14} strokeWidth={2} />
        </span>
      </div>
      {children}
    </div>
  );
}

/* Before anything is asked, your browser is simply open on a new tab — so
   the stage is a complete desktop from the first frame. The consent page
   then loads into this same window. */
const NTP_SHORTCUTS = [
  { label: "Gmail", initial: "M", bg: "#fde7e3", fg: "#c5221f" },
  { label: "Calendar", initial: "C", bg: "#e3ecfb", fg: "#1a56c4" },
  { label: "Docs", initial: "D", bg: "#e2efe6", fg: "#137333" },
  { label: "YouTube", initial: "Y", bg: "#fde8e8", fg: "#d93025" },
  { label: "Maps", initial: "M", bg: "#e6f1ea", fg: "#188038" },
  { label: "Notion", initial: "N", bg: "#ecedef", fg: "#1f1f1f" },
  { label: "Figma", initial: "F", bg: "#f1e8fb", fg: "#7b3fe4" },
  { label: "Ridgeline", initial: "R", bg: "#e1efe9", fg: "#0d3b2e" },
] as const;

function NewTabApp() {
  return (
    <ChromeFrame
      tabTitle="New Tab"
      site="newtab"
      placeholder="Search Google or type a URL"
    >
      <div className={styles.ntp}>
        <span className={styles.ntpLogo} aria-hidden="true">
          <i style={{ color: "#4285f4" }}>G</i>
          <i style={{ color: "#ea4335" }}>o</i>
          <i style={{ color: "#fbbc04" }}>o</i>
          <i style={{ color: "#4285f4" }}>g</i>
          <i style={{ color: "#34a853" }}>l</i>
          <i style={{ color: "#ea4335" }}>e</i>
        </span>
        <span className={styles.ntpSearch}>
          <Search size={15} strokeWidth={2} />
          <span>Search Google or type a URL</span>
          <Mic size={15} strokeWidth={1.9} />
          <Camera size={15} strokeWidth={1.9} />
        </span>
        <div className={styles.ntpShortcuts}>
          {NTP_SHORTCUTS.map((item) => (
            <span key={item.label} className={styles.ntpShortcut}>
              <i style={{ background: item.bg, color: item.fg }}>{item.initial}</i>
              <span>{item.label}</span>
            </span>
          ))}
        </div>
        <span className={styles.ntpCustomize}>
          <Pencil size={11} strokeWidth={2} />
          Customize Chrome
        </span>
      </div>
    </ChromeFrame>
  );
}

/* The Google consent page that opens while Gmail connects — the "finish
   signing in in your browser" step, seen from the browser's side. */
function ConsentApp({ allowed }: { allowed: boolean }) {
  return (
    <ChromeFrame
      tabTitle="Sign in – Google Accounts"
      site="google"
      host="accounts.google.com"
      path="/signin/oauth/consent"
    >
      <div className={styles.consent}>
        <div className={styles.consentCard}>
          <span className={styles.consentLogo} aria-hidden="true">
            G
          </span>
          <h4 className={styles.consentTitle}>
            Stella wants access to your Google&nbsp;Account
          </h4>
          <span className={styles.consentAccount}>
            <Avatar initial="S" tone={1} size={20} />
            sam.rivera@gmail.com
          </span>
          <p className={styles.consentLead}>This will allow Stella to:</p>
          <ul className={styles.consentScopes}>
            <li>
              <Mail size={15} strokeWidth={1.8} />
              Read, compose, and send emails from your Gmail account
            </li>
            <li>
              <Avatar initial="" tone={1} size={15} className={styles.consentDot} />
              See your primary Google Account email address
            </li>
          </ul>
          <p className={styles.consentFine}>
            Make sure you trust Stella. You can see or remove access in your{" "}
            <b>Google Account</b>.
          </p>
          <div className={styles.consentActions}>
            <span className={styles.consentCancel}>Cancel</span>
            <span className={styles.consentAllow} data-pressed={allowed || undefined}>
              Allow
            </span>
          </div>
        </div>
        <div className={styles.consentFoot}>
          <span>English (United States)</span>
          <span>Help</span>
          <span>Privacy</span>
          <span>Terms</span>
        </div>
      </div>
    </ChromeFrame>
  );
}

/* ------------------------------------------------------------------ */
/*  Act 1 — Gmail                                                      */
/* ------------------------------------------------------------------ */

function GmailM() {
  return (
    <svg className={styles.gmailM} viewBox="0 0 52 40" aria-hidden="true">
      <path d="M4 4 L26 21 L48 4 L48 12 L26 29 L4 12 Z" fill="#ea4335" />
      <path d="M4 4 L12 10.2 L12 18.2 L4 12 Z" fill="#fbbc04" />
      <rect x="4" y="12" width="8" height="24" fill="#4285f4" />
      <rect x="40" y="4" width="8" height="32" fill="#34a853" />
    </svg>
  );
}

const MAIL_NAV = [
  { label: "Inbox", count: "12", icon: Inbox, active: true },
  { label: "Starred", icon: Star },
  { label: "Snoozed", icon: Clock },
  { label: "Sent", icon: Send },
  { label: "Drafts", count: "3", icon: Pencil },
] as const;

const FIRST_MATCH = MAIL_ROWS.findIndex((row) => row.match);

function MailApp({
  step,
  search,
  reply,
  hoverAt,
}: {
  step: MailStep;
  search: string;
  reply: string;
  hoverAt?: string;
}) {
  const filtered = step !== "inbox";
  const threadOpen = step === "thread" || step === "reply" || step === "sent";
  const replyOpen = step === "reply" || step === "sent";
  const sent = step === "sent";
  const matches = MAIL_ROWS.filter((r) => r.match).length;
  return (
    <div className={styles.app} data-kind="mail">
      <div className={styles.titlebar}>
        <Lights />
        <span className={styles.title}>
          {threadOpen ? "Lease renewal — 14 Elm St — Gmail" : "Inbox (12) — Gmail"}
        </span>
      </div>

      <div className={styles.gmailTop}>
        <span className={styles.gmailMenu}>
          <Menu size={16} strokeWidth={1.8} />
        </span>
        <span className={styles.gmailBrand}>
          <GmailM />
          Gmail
        </span>
        <span
          className={styles.gmailSearch}
          data-active={search ? "true" : undefined}
        >
          <Search size={15} strokeWidth={2} />
          {search ? (
            <span className={styles.gmailSearchText}>
              {search}
              {!filtered ? <Caret /> : null}
            </span>
          ) : (
            <span className={styles.gmailSearchPlaceholder}>Search mail</span>
          )}
          <SlidersHorizontal size={14} strokeWidth={1.8} className={styles.gmailSearchFilter} />
        </span>
        <span className={styles.gmailTopRight}>
          <CircleHelp size={16} strokeWidth={1.7} />
          <Settings size={16} strokeWidth={1.7} />
          <LayoutGrid size={15} strokeWidth={1.8} />
          <Avatar initial="S" tone={1} size={26} />
        </span>
      </div>

      <div className={styles.gmailBody}>
        <aside className={styles.gmailNav}>
          <span className={styles.gmailCompose}>
            <Pencil size={14} strokeWidth={2} />
            Compose
          </span>
          <ul>
            {MAIL_NAV.map((item) => (
              <li
                key={item.label}
                data-active={("active" in item && item.active) || undefined}
              >
                <item.icon size={14} strokeWidth={1.9} />
                <span>{item.label}</span>
                {"count" in item ? <b>{item.count}</b> : null}
              </li>
            ))}
            <li>
              <ChevronDown size={14} strokeWidth={1.9} />
              <span>More</span>
            </li>
          </ul>
          <span className={styles.gmailNavHead}>
            Labels
            <Plus size={13} strokeWidth={2} />
          </span>
          <ul>
            <li>
              <i className={styles.labelDot} style={{ background: "#4f8ef7" }} />
              <span>Apartment hunt</span>
            </li>
            <li>
              <i className={styles.labelDot} style={{ background: "#f2a93b" }} />
              <span>Receipts</span>
            </li>
          </ul>
        </aside>

        <div className={styles.gmailMain}>
          {/* List (inbox + search results) */}
          <div className={styles.gmailList} data-hidden={threadOpen || undefined}>
            <div className={styles.gmailListBar}>
              <i className={styles.checkbox} />
              <ChevronDown size={12} strokeWidth={2} />
              <RotateCw size={13} strokeWidth={2} />
              <MoreVertical size={14} strokeWidth={2} />
              <span className={styles.gmailCount}>
                {filtered ? `1–${matches} of ${matches}` : "1–50 of 1,284"}
                <ChevronLeft size={13} strokeWidth={2} />
                <ChevronRight size={13} strokeWidth={2} />
              </span>
            </div>
            {filtered ? (
              <div className={styles.gmailChips} key="chips">
                {["From", "Any time", "Has attachment", "To", "Is unread"].map((c) => (
                  <span key={c} className={styles.gmailChip}>
                    {c}
                    {c !== "Has attachment" && c !== "Is unread" ? (
                      <ChevronDown size={11} strokeWidth={2} />
                    ) : null}
                  </span>
                ))}
                <span className={styles.gmailChipLink}>Advanced search</span>
              </div>
            ) : (
              <div className={styles.gmailTabs} key="tabs">
                <span data-active="true">
                  <Inbox size={13} strokeWidth={1.9} />
                  Primary
                </span>
                <span>
                  <Tag size={13} strokeWidth={1.9} />
                  Promotions
                  <b>24 new</b>
                </span>
                <span>
                  <Smile size={13} strokeWidth={1.9} />
                  Social
                </span>
              </div>
            )}
            <div className={styles.gmailRows}>
              {MAIL_ROWS.map((row, i) => (
                <div
                  key={row.subject}
                  className={styles.gmailRowWrap}
                  data-hidden={(filtered && !row.match) || undefined}
                >
                  <div
                    className={styles.gmailRow}
                    data-unread={row.unread || undefined}
                    data-hover={
                      (filtered && i === FIRST_MATCH && hoverAt === "mailRow") || undefined
                    }
                    data-target={i === FIRST_MATCH ? "mailRow" : undefined}
                    data-target-x="0.42"
                  >
                    <i className={styles.checkbox} />
                    <Star
                      size={14}
                      strokeWidth={1.8}
                      className={styles.gmailStar}
                      data-on={row.starred || undefined}
                    />
                    <span className={styles.gmailFrom}>{row.from}</span>
                    <span className={styles.gmailSubject}>
                      <b>{row.subject}</b>
                      <span className={styles.gmailSnippet}>{row.snippet}</span>
                    </span>
                    <span className={styles.gmailTime}>{row.time}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Thread */}
          <div
            className={styles.gmailThread}
            data-open={threadOpen || undefined}
            data-reply={replyOpen || undefined}
          >
            <div className={styles.gmailThreadBar}>
              <ArrowLeft size={15} strokeWidth={1.9} />
              <span className={styles.gmailBarSep} />
              <Archive size={14} strokeWidth={1.8} />
              <Trash2 size={14} strokeWidth={1.8} />
              <span className={styles.gmailBarSep} />
              <MailOpen size={14} strokeWidth={1.8} />
              <Clock size={14} strokeWidth={1.8} />
              <Tag size={14} strokeWidth={1.8} />
              <MoreVertical size={14} strokeWidth={2} />
              <span className={styles.gmailCount}>
                1 of {matches}
                <ChevronLeft size={13} strokeWidth={2} />
                <ChevronRight size={13} strokeWidth={2} />
              </span>
            </div>
            <div className={styles.gmailThreadScroll}>
              <h4 className={styles.gmailThreadSubject}>
                Lease renewal — 14 Elm St
                <span className={styles.gmailLabelChip}>Inbox</span>
                <span className={styles.gmailThreadTools}>
                  <Printer size={14} strokeWidth={1.8} />
                  <ExternalLink size={14} strokeWidth={1.8} />
                </span>
              </h4>

              <div className={styles.gmailMsg}>
                <Avatar initial="M" tone={2} size={34} />
                <div className={styles.gmailMsgBody}>
                  <div className={styles.gmailMsgHead}>
                    <span className={styles.gmailMsgFrom}>
                      <b>Marcus Hale</b>
                      <span>&lt;marcus@haleprops.com&gt;</span>
                    </span>
                    <span className={styles.gmailMsgWhen}>
                      <span className={styles.whenLong}>Tue, Oct 14, 9:12 AM (2 days ago)</span>
                      <span className={styles.whenShort}>Oct 14</span>
                      <Star size={13} strokeWidth={1.8} />
                      <Reply size={13} strokeWidth={1.8} />
                      <MoreVertical size={13} strokeWidth={2} />
                    </span>
                  </div>
                  <span className={styles.gmailMsgTo}>
                    to me <ChevronDown size={11} strokeWidth={2} />
                  </span>
                  <div className={styles.gmailMsgText}>
                    <p>
                      Hi Sam — your lease at 14 Elm St is up on Nov 30. We&apos;d love
                      to have you stay. If you want to renew for another 12 months, rent
                      would go to <b>$1,525/mo</b> starting December.
                    </p>
                    <p>Let me know by the 24th so I can send the paperwork over.</p>
                    <p>
                      Thanks,
                      <br />
                      Marcus
                      <br />
                      <span className={styles.gmailSig}>
                        Hale Property Management · (555) 014-2200
                      </span>
                    </p>
                  </div>
                </div>
              </div>

              {/* The sent reply becomes part of the thread. */}
              <div className={styles.gmailMsg} data-sent-msg data-shown={sent || undefined}>
                <Avatar initial="S" tone={1} size={34} />
                <div className={styles.gmailMsgBody}>
                  <div className={styles.gmailMsgHead}>
                    <span className={styles.gmailMsgFrom}>
                      <b>Sam Rivera</b>
                      <span>&lt;sam.rivera@gmail.com&gt;</span>
                    </span>
                    <span className={styles.gmailMsgWhen}>
                      <span className={styles.whenLong}>10:07 AM (0 minutes ago)</span>
                      <span className={styles.whenShort}>10:07 AM</span>
                      <Star size={13} strokeWidth={1.8} />
                      <Reply size={13} strokeWidth={1.8} />
                      <MoreVertical size={13} strokeWidth={2} />
                    </span>
                  </div>
                  <span className={styles.gmailMsgTo}>
                    to Marcus <ChevronDown size={11} strokeWidth={2} />
                  </span>
                  <div className={styles.gmailMsgText}>
                    <p>{MAIL_REPLY}</p>
                  </div>
                </div>
              </div>

              {/* Inline reply composer */}
              <div
                className={styles.gmailReply}
                data-open={(replyOpen && !sent) || undefined}
              >
                <div className={styles.gmailReplyInner}>
                  <div className={styles.gmailReplyCard}>
                    <div className={styles.gmailReplyHead}>
                      <Reply size={13} strokeWidth={2} />
                      <span className={styles.gmailToChip}>
                        Marcus Hale
                        <ChevronDown size={11} strokeWidth={2} />
                      </span>
                    </div>
                    <p
                      className={styles.gmailReplyText}
                      data-target="mailCompose"
                      data-target-x="0.86"
                      data-target-y="0.7"
                    >
                      {reply}
                      {replyOpen && !sent ? <Caret /> : null}
                    </p>
                    <div className={styles.gmailReplyBar}>
                      <span
                        className={styles.gmailSend}
                        data-target="mailSend"
                      >
                        Send
                        <ChevronDown size={12} strokeWidth={2.2} />
                      </span>
                      <Type size={14} strokeWidth={1.8} />
                      <Paperclip size={14} strokeWidth={1.8} />
                      <LinkIcon size={14} strokeWidth={1.8} />
                      <Smile size={14} strokeWidth={1.8} />
                      <Ellipsis size={14} strokeWidth={2} />
                      <Trash2 size={14} strokeWidth={1.8} className={styles.gmailReplyTrash} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Reply / Forward affordance under the thread */}
              <div className={styles.gmailThreadFoot} data-hidden={replyOpen && !sent ? "true" : undefined}>
                <span>
                  <Reply size={13} strokeWidth={2} />
                  Reply
                </span>
                <span>
                  <ArrowUpRight size={13} strokeWidth={2} />
                  Forward
                </span>
              </div>
            </div>
          </div>

          <div className={styles.gmailToast} data-shown={sent || undefined}>
            <Check size={13} strokeWidth={2.4} />
            Message sent
            <b>Undo</b>
            <b>View message</b>
            <X size={13} strokeWidth={2} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Act 2 — the page Stella made                                       */
/* ------------------------------------------------------------------ */

function PageApp({ rows, tag, verdict }: { rows: number; tag: boolean; verdict: boolean }) {
  return (
    <div className={styles.app} data-kind="page">
      <div className={styles.titlebar}>
        <Lights />
        <span className={styles.title}>
          <AppWindow size={12} strokeWidth={1.9} />
          {PAGE_NAME}
        </span>
        <span className={styles.titlebarRight}>
          <span className={styles.titleButton}>
            <Share size={11} strokeWidth={2} />
            Share
          </span>
          <span className={styles.titleButton}>
            <ArrowUpRight size={12} strokeWidth={2} />
          </span>
        </span>
      </div>
      <div className={styles.pageBody}>
        <div className={styles.pageInner}>
          <div className={styles.pageHead}>
            <span className={styles.pageEyebrow}>
              <StellaMark size={11} />
              Made for you · Oct 16
            </span>
            <h4>Which apartment?</h4>
            <p>
              The five you pasted, sorted by true monthly cost — rent plus what
              the commute costs you at 21 round trips a month.
            </p>
          </div>

          <div className={styles.aptTable} data-empty={rows === 0 || undefined}>
            <div className={styles.aptHeadRow}>
              <span>Listing</span>
              <span>Rent</span>
              <span>Commute</span>
              <span>True cost</span>
              <span aria-hidden="true" />
            </div>
            {rows === 0 ? (
              <div className={styles.pageSkeleton} aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
            ) : null}
            {APARTMENTS.slice(0, rows).map((apt, i) => (
              <div
                className={styles.aptRow}
                key={apt.name}
                data-best={(i === 0 && tag) || undefined}
              >
                <span className={styles.aptListing}>
                  <AptPhoto tone={apt.tone} />
                  <span className={styles.aptMain}>
                    <span className={styles.aptName}>
                      <span className={styles.aptNameText}>{apt.name}</span>
                      {i === 0 && tag ? (
                        <span className={styles.aptBest}>
                          <Check size={9} strokeWidth={3} />
                          <span className={styles.aptBestText}>Best value</span>
                        </span>
                      ) : null}
                    </span>
                    <span className={styles.aptDetail}>{apt.detail}</span>
                  </span>
                </span>
                <span className={styles.aptCell}>{apt.price}</span>
                <span className={styles.aptCell}>
                  {apt.commute}
                  <small> min</small>
                </span>
                <span className={`${styles.aptCell} ${styles.aptCost}`}>{apt.trueCost}</span>
                <span className={styles.aptBar}>
                  <i style={{ ["--w" as string]: apt.bar }} />
                </span>
              </div>
            ))}
          </div>

          <div
            className={styles.pageVerdict}
            data-shown={verdict || undefined}
            data-target="pageVerdict"
            data-target-x="0.88"
            data-target-y="0.5"
          >
            <span className={styles.pageVerdictIcon}>
              <Check size={13} strokeWidth={2.2} />
            </span>
            <p>
              <b>Elm St wins once you count the commute</b> — $1,681 all-in, and
              it&apos;s the only one with in-unit laundry. Grant Ave is cheapest on
              paper but costs the most in time.
            </p>
          </div>

          <p className={styles.pageFoot}>
            True cost = rent + commute (2 ways × 21 days) at $15/hr · Commute
            times from Maps, weekdays 8:30 AM
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Act 3 — your browser                                               */
/* ------------------------------------------------------------------ */

const SITE_NAV = ["Overview", "Membership", "Billing", "Check-ins", "Settings"] as const;

function BrowserApp({
  step,
  email,
  reason,
  agreed,
  hoverAt,
}: {
  step: BrowserStep;
  email: string;
  reason: boolean;
  agreed: boolean;
  hoverAt?: string;
}) {
  const path =
    step === "account"
      ? "/account/membership"
      : step === "done"
        ? "/account/membership/canceled"
        : "/account/membership/cancel";
  /* The retention modal sits over the form; only real page changes remount. */
  const pageKey = step === "offer" ? "form" : step;
  return (
    <ChromeFrame
      tabTitle="Membership · Ridgeline Fitness"
      site="ridgeline"
      host="ridgelinefitness.com"
      path={path}
    >
      <div className={styles.site}>
        <div className={styles.siteHeader}>
          <span className={styles.siteLogo}>
            <i aria-hidden="true" />
            Ridgeline
          </span>
          <span className={styles.siteLinks}>
            <span>Clubs</span>
            <span>Classes</span>
            <span data-active="true">Membership</span>
            <span>Shop</span>
          </span>
          <span className={styles.siteHeaderRight}>
            <span className={styles.siteGhost}>Find a club</span>
            <span className={styles.siteUser}>
              <Avatar initial="S" tone={3} size={20} />
              Sam R.
            </span>
          </span>
        </div>

        <div className={styles.siteBody}>
          <div className={styles.siteCrumbs}>
            <span>Account</span>
            <ChevronRight size={11} strokeWidth={2} />
            <span data-current="true">Membership</span>
          </div>
          <div className={styles.siteColumns}>
            <aside className={styles.siteAside}>
              {SITE_NAV.map((item) => (
                <span key={item} data-active={item === "Membership" || undefined}>
                  {item}
                </span>
              ))}
              <span className={styles.siteAsideOut}>Sign out</span>
            </aside>

            <div className={styles.siteMain} key={pageKey} data-step={step}>
              {step === "account" ? (
                <>
                  <div className={styles.siteCard}>
                    <div className={styles.siteCardHead}>
                      <span>
                        <span className={styles.siteEyebrow}>Your plan</span>
                        <h4 className={styles.siteTitle}>Unlimited</h4>
                      </span>
                      <span className={styles.siteBadge} data-tone="good">
                        Active
                      </span>
                    </div>
                    <dl className={styles.siteFacts}>
                      <div>
                        <dt>Billing</dt>
                        <dd>$54.00 / month</dd>
                      </div>
                      <div>
                        <dt>Next payment</dt>
                        <dd>Nov 1, 2025</dd>
                      </div>
                      <div>
                        <dt>Member since</dt>
                        <dd>Mar 2024</dd>
                      </div>
                      <div>
                        <dt>Home club</dt>
                        <dd>Downtown</dd>
                      </div>
                      <div>
                        <dt>Payment method</dt>
                        <dd>Visa ···· 4417</dd>
                      </div>
                      <div>
                        <dt>Check-ins this year</dt>
                        <dd>48</dd>
                      </div>
                    </dl>
                    <div className={styles.siteActions}>
                      <span className={styles.siteButton}>Freeze membership</span>
                      <span className={styles.siteButton}>Change plan</span>
                      <span
                        className={styles.siteLink}
                        data-target="gymCancel"
                        data-hover={hoverAt === "gymCancel" || undefined}
                      >
                        Cancel membership
                      </span>
                    </div>
                  </div>
                  <div className={styles.siteCard}>
                    <div className={styles.siteCardHead}>
                      <h4 className={styles.siteTitleSm}>Recent check-ins</h4>
                      <span className={styles.siteLinkQuiet}>View all</span>
                    </div>
                    <ul className={styles.siteList}>
                      <li>
                        <span>Downtown</span>
                        <span>Tue, Oct 14 · 6:42 AM</span>
                      </li>
                      <li>
                        <span>Downtown</span>
                        <span>Sun, Oct 12 · 9:10 AM</span>
                      </li>
                      <li>
                        <span>Midtown</span>
                        <span>Thu, Oct 9 · 7:15 PM</span>
                      </li>
                    </ul>
                  </div>
                </>
              ) : step === "form" || step === "offer" ? (
                <div className={styles.siteCard}>
                  <div className={styles.siteCardHead}>
                    <span>
                      <span className={styles.siteEyebrow}>Cancel membership</span>
                      <h4 className={styles.siteTitle}>We&apos;re sorry to see you go</h4>
                    </span>
                    <span className={styles.siteStep}>Step 1 of 2</span>
                  </div>
                  <p className={`${styles.siteText} ${styles.siteIntro}`}>
                    Confirm a few details and we&apos;ll take care of the rest. Your
                    access continues through the end of your billing period.
                  </p>
                  <label className={styles.siteField}>
                    <span>Confirm your email</span>
                    <span
                      className={styles.siteInput}
                      data-filled={email ? "true" : undefined}
                      data-target="gymEmail"
                      data-target-x="0.7"
                    >
                      {email || "you@email.com"}
                      {email && email.length < GYM_EMAIL.length ? <Caret /> : null}
                    </span>
                  </label>
                  <label className={styles.siteField}>
                    <span>Reason for leaving</span>
                    <span
                      className={styles.siteSelect}
                      data-filled={reason || undefined}
                      data-target="gymReason"
                    >
                      {reason ? "Moving away" : "Select a reason"}
                      <ChevronDown size={13} strokeWidth={2} className={styles.siteSelectChevron} />
                    </span>
                  </label>
                  <span
                    className={styles.siteCheck}
                    data-checked={agreed || undefined}
                    data-target="gymAgree"
                    data-target-x="0.03"
                  >
                    <i>{agreed ? <Check size={10} strokeWidth={3} /> : null}</i>
                    I understand my access ends at the end of the current billing
                    period and any remaining guest passes are forfeited.
                  </span>
                  <div className={styles.siteActions}>
                    <span className={styles.siteButton}>Back</span>
                    <span
                      className={`${styles.siteButton} ${styles.siteButtonPrimary}`}
                      data-target="gymContinue"
                    >
                      Continue
                    </span>
                  </div>
                </div>
              ) : step === "confirm" ? (
                <div className={styles.siteCard}>
                  <div className={styles.siteCardHead}>
                    <span>
                      <span className={styles.siteEyebrow}>Cancel membership</span>
                      <h4 className={styles.siteTitle}>Confirm cancellation</h4>
                    </span>
                    <span className={styles.siteStep}>Step 2 of 2</span>
                  </div>
                  <dl className={styles.siteSummary}>
                    <div>
                      <dt>Plan</dt>
                      <dd>Unlimited · $54.00 / month</dd>
                    </div>
                    <div>
                      <dt>Last day of access</dt>
                      <dd>Oct 31, 2025</dd>
                    </div>
                    <div>
                      <dt>Final charge</dt>
                      <dd>None</dd>
                    </div>
                    <div>
                      <dt>Confirmation to</dt>
                      <dd>{GYM_EMAIL}</dd>
                    </div>
                  </dl>
                  <div className={styles.siteActions}>
                    <span className={styles.siteButton}>Keep membership</span>
                    <span
                      className={`${styles.siteButton} ${styles.siteButtonDanger}`}
                      data-target="gymConfirm"
                    >
                      Confirm cancellation
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div className={`${styles.siteCard} ${styles.siteDone}`}>
                    <span className={styles.siteDoneMark}>
                      <Check size={16} strokeWidth={2.6} />
                    </span>
                    <h4 className={styles.siteTitle}>Membership canceled</h4>
                    <p className={styles.siteText}>
                      Your access continues through <b>Oct 31, 2025</b>. You won&apos;t
                      be charged again. We&apos;ve sent a confirmation to{" "}
                      <b>{GYM_EMAIL}</b>.
                    </p>
                    <dl className={styles.siteSummary}>
                      <div>
                        <dt>Reference</dt>
                        <dd>RF-48213-0C</dd>
                      </div>
                      <div>
                        <dt>Canceled on</dt>
                        <dd>Oct 16, 2025</dd>
                      </div>
                    </dl>
                    <div className={styles.siteActions}>
                      <span className={styles.siteButton}>
                        <Download size={12} strokeWidth={2} />
                        Download confirmation
                      </span>
                      <span className={styles.siteLinkQuiet}>Back to account</span>
                    </div>
                  </div>
                  <div className={styles.siteCard}>
                    <div className={styles.siteCardHead}>
                      <h4 className={styles.siteTitleSm}>What happens next</h4>
                    </div>
                    <ul className={styles.siteList}>
                      <li>
                        <span>Key fob keeps working</span>
                        <span>through Oct 31</span>
                      </li>
                      <li>
                        <span>Autopay turned off</span>
                        <span>Visa ···· 4417</span>
                      </li>
                      <li>
                        <span>Rejoin any time</span>
                        <span>no joining fee until Jan</span>
                      </li>
                    </ul>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className={styles.siteFooter}>
            <span>© 2025 Ridgeline Fitness</span>
            <span>Terms</span>
            <span>Privacy</span>
            <span>Help</span>
          </div>
        </div>

        {step === "offer" ? (
          <div className={styles.siteModalWrap}>
            <div className={styles.siteModal}>
              <span className={styles.siteEyebrow}>Before you go</span>
              <h4 className={styles.siteTitle}>Stay for 50% off the next 3 months?</h4>
              <p className={styles.siteText}>
                Keep your Unlimited plan for <b>$27/mo</b> through January — no
                commitment, cancel any time.
              </p>
              <div className={styles.siteActions}>
                <span
                  className={styles.siteLinkQuiet}
                  data-target="gymNoThanks"
                  data-hover={hoverAt === "gymNoThanks" || undefined}
                >
                  No thanks, cancel anyway
                </span>
                <span className={`${styles.siteButton} ${styles.siteButtonPrimary}`}>
                  Keep my membership
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </ChromeFrame>
  );
}

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

const WIDE = { w: 1120, h: 600 };
const STACKED_H = 944;

export function HomeRealWork() {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [composerTyped, setComposerTyped] = useState("");
  const [pill, setPill] = useState<Pill | null>(null);
  const [clearing, setClearing] = useState(false);
  const [activeBeat, setActiveBeat] = useState(-1);
  const [action, setAction] = useState<Action>({ scene: "none" });
  const [cursor, setCursor] = useState<Cursor>(null);
  const [mailSearch, setMailSearch] = useState("");
  const [mailReply, setMailReply] = useState("");
  const [gymEmail, setGymEmail] = useState("");
  const [layout, setLayout] = useState<Layout>("wide");

  /* The stage is laid out in fixed design pixels and scaled to the column,
     so every width shows the same composition — nothing reflows or clips.
     Wide: chat beside the action window. Stacked (narrow): the action
     window above the chat, drawn 1:1 where possible so type stays legible. */
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const apply = () => {
      const width = el.clientWidth;
      if (width <= 0) return;
      const stacked = width < 720;
      const designW = stacked ? Math.min(560, Math.max(320, width)) : WIDE.w;
      const designH = stacked ? STACKED_H : WIDE.h;
      el.style.setProperty("--design-w", String(designW));
      el.style.setProperty("--design-h", String(designH));
      el.style.setProperty("--stage-scale", String(width / designW));
      setLayout(stacked ? "stacked" : "wide");
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* Between plays the last window stays up — like a desktop, the previous
     app is simply still there until she opens the next one — so the stage
     never goes dark at the seam. (The very first play starts empty.) */
  const reset = useCallback(() => {
    setEntries([]);
    setComposerTyped("");
    setPill(null);
    setClearing(false);
    setCursor(null);
    setMailSearch("");
    setMailReply("");
    setGymEmail("");
  }, []);

  const { reduced } = useSceneLoop(
    sectionRef,
    async ({ sleep, type }) => {
      const push = (entry: Entry) => setEntries((prev) => [...prev, entry]);
      const patchLast = (patch: (entry: Entry) => Entry) =>
        setEntries((prev) => {
          if (prev.length === 0) return prev;
          const next = prev.slice();
          next[next.length - 1] = patch(next[next.length - 1]);
          return next;
        });
      const patchAssistant = (patch: Partial<Extract<Entry, { kind: "assistant" }>>) =>
        patchLast((entry) =>
          entry.kind === "assistant" ? { ...entry, ...patch } : entry,
        );
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
      const reply = async (text: string, thinkMs = 720) => {
        push({ kind: "assistant", text: "" });
        await sleep(thinkMs);
        const words = text.split(" ");
        for (let w = 1; w <= words.length; w += 1) {
          const partial = words.slice(0, w).join(" ");
          patchAssistant({ text: partial });
          await sleep(32);
        }
      };
      const ask = async (text: string, attachment?: string, ms = 16) => {
        await type(text, setComposerTyped, ms);
        await sleep(240);
        setComposerTyped("");
        push({ kind: "user", text, attachment });
      };
      const click = async (at: string) => {
        setCursor({ at });
        await sleep(720);
        setCursor({ at, click: true });
        await sleep(260);
      };

      /* Beat 1 — email. Her first time in your inbox, so she asks. */
      await sleep(240);
      await ask(ASK_EMAIL, undefined, 12);
      await sleep(320);
      await reply(REPLY_NEED);
      await sleep(260);
      patchAssistant({ connect: { phase: "offer" } });
      await sleep(1100);
      patchAssistant({ connect: { phase: "offer", pressed: true } });
      await sleep(180);
      // Connecting opens Google's consent page in your browser.
      patchAssistant({ connect: { phase: "connecting" } });
      setActiveBeat(0);
      setAction({ scene: "consent", allowed: false });
      await sleep(1500);
      setAction({ scene: "consent", allowed: true });
      await sleep(300);
      patchAssistant({ connect: { phase: "connected" } });
      await sleep(380);

      // The inbox opens the moment she has it.
      setAction({ scene: "mail", step: "inbox" });
      await sleep(700);
      await reply(REPLY_ON_IT, 520);
      await sleep(200);
      addWork(WORK_SEARCH);
      setPill({ state: "running", count: 1 });
      await sleep(420);
      await type(MAIL_SEARCH, setMailSearch, 52);
      await sleep(320);
      setAction({ scene: "mail", step: "filtered" });
      await sleep(520);
      patchWork("search", {
        state: "done",
        title: "Found the thread",
        meta: "Marcus Hale · Tue",
      });
      await click("mailRow");
      setAction({ scene: "mail", step: "thread" });
      await sleep(900);
      addWork(WORK_REPLY);
      await sleep(360);
      setAction({ scene: "mail", step: "reply" });
      setCursor({ at: "mailCompose" });
      await sleep(420);
      await type(MAIL_REPLY, setMailReply, 17);
      await sleep(260);
      await click("mailSend");
      setAction({ scene: "mail", step: "sent" });
      patchWork("reply", { state: "done", title: "Reply sent" });
      setPill({ state: "done" });
      await sleep(420);
      setCursor(null);
      await reply(REPLY_EMAIL_DONE, 560);
      await sleep(800);
      setPill(null);
      await sleep(1400);

      /* Beat 2 — something messy in, something to look at out. */
      await ask(ASK_APTS, ASK_APTS_ATTACHMENT);
      await sleep(380);
      await reply(REPLY_SEC, 600);
      await sleep(220);
      addWork(WORK_COMPARE);
      setPill({ state: "running", count: 1 });
      await sleep(500);
      setActiveBeat(1);
      setAction({ scene: "page", rows: 0, tag: false, verdict: false });
      await sleep(1100);
      for (let rows = 1; rows <= APARTMENTS.length; rows += 1) {
        setAction({ scene: "page", rows, tag: false, verdict: false });
        await sleep(230);
      }
      patchWork("compare", { meta: "adding commutes" });
      await sleep(900);
      setAction({ scene: "page", rows: 5, tag: true, verdict: false });
      await sleep(500);
      setAction({ scene: "page", rows: 5, tag: true, verdict: true });
      patchWork("compare", {
        state: "done",
        title: "Compared the listings",
        meta: undefined,
      });
      setPill({ state: "done" });
      await sleep(360);
      await reply(REPLY_APTS_DONE, 520);
      await sleep(260);
      patchAssistant({ page: PAGE_NAME });
      await sleep(800);
      setPill(null);
      await sleep(2200);

      /* Beat 3 — your browser, your logins, her hands. */
      await ask(ASK_GYM);
      await sleep(380);
      await reply(REPLY_GYM);
      await sleep(240);
      addWork(WORK_GYM);
      setPill({ state: "running", count: 1 });
      await sleep(300);
      setActiveBeat(2);
      setAction({ scene: "browser", step: "account", reason: false, agreed: false });
      await sleep(900);
      await click("gymCancel");
      setAction({ scene: "browser", step: "form", reason: false, agreed: false });
      setCursor({ at: "gymEmail" });
      await sleep(600);
      await type(GYM_EMAIL, setGymEmail, 28);
      await sleep(240);
      await click("gymReason");
      setAction({ scene: "browser", step: "form", reason: true, agreed: false });
      await sleep(420);
      await click("gymAgree");
      setAction({ scene: "browser", step: "form", reason: true, agreed: true });
      await sleep(420);
      await click("gymContinue");
      setAction({ scene: "browser", step: "offer", reason: true, agreed: true });
      patchWork("gym", { meta: "declining offer" });
      await sleep(1000);
      await click("gymNoThanks");
      setAction({ scene: "browser", step: "confirm", reason: true, agreed: true });
      await sleep(800);
      await click("gymConfirm");
      setAction({ scene: "browser", step: "done", reason: true, agreed: true });
      await sleep(300);
      setCursor(null);
      patchWork("gym", {
        state: "done",
        title: "Membership canceled",
        meta: "ends Oct 31",
      });
      setPill({ state: "done" });
      await sleep(480);
      await reply(REPLY_GYM_DONE, 540);
      await sleep(800);
      setPill(null);
      await sleep(2600);

      // Breathe the conversation out before the loop resets it. The browser
      // stays up until the reset so the stage never goes dark mid-seam.
      setClearing(true);
      await sleep(450);
    },
    reset,
    { restartDelayMs: 350 },
  );

  const shownEntries = reduced ? FINAL_ENTRIES : entries;
  const shownAction = reduced ? FINAL_ACTION : action;
  /* The static frame parks the pointer on the verdict so the window still
     reads as Stella's doing. */
  const shownCursor: Cursor = reduced ? { at: "pageVerdict" } : cursor;
  const shownBeat = reduced ? 1 : activeBeat;
  const actsLive = reduced || activeBeat >= 0;

  return (
    <section
      className={`grid-shell section-border home-atlas-section ${styles.section}`}
      data-reveal
      ref={sectionRef}
    >
      <div
        className={`home-atlas-heading ${styles.heading}`}
        data-reveal-child
        style={{ ["--reveal-index" as string]: 0 }}
      >
        <h2>Yes, it can do that.</h2>
        <ol className={styles.acts} data-live={actsLive || undefined} aria-hidden="true">
          {ACTS.map((act, i) => (
            <li key={act.label} data-active={(actsLive && i === shownBeat) || undefined}>
              <span className={styles.actIndex}>0{i + 1}</span>
              {act.label}
            </li>
          ))}
        </ol>
        <Link className={styles.fixLink} href="/fix">
          See more things Stella can fix
          <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </div>

      <div
        className={styles.media}
        data-reveal-child
        style={{ ["--reveal-index" as string]: 1 }}
      >
        <p className={styles.srOnly}>{SUMMARY}</p>
        <div className={styles.frame} data-layout={layout}>
          <div
            className={styles.stage}
            ref={stageRef}
            data-layout={layout}
            aria-hidden="true"
          >
            <div className={styles.stageInner}>
              {/* The work, in the app it actually happens in. */}
              <div
                className={styles.actionWindow}
                data-scene={shownAction.scene}
                ref={windowRef}
              >
                <div className={styles.actionEnter} key={shownAction.scene}>
                  {shownAction.scene === "none" ? (
                    <NewTabApp />
                  ) : shownAction.scene === "consent" ? (
                    <ConsentApp allowed={shownAction.allowed} />
                  ) : shownAction.scene === "mail" ? (
                    <MailApp
                      step={shownAction.step}
                      search={mailSearch}
                      reply={mailReply}
                      hoverAt={shownCursor?.at}
                    />
                  ) : shownAction.scene === "page" ? (
                    <PageApp
                      rows={shownAction.rows}
                      tag={shownAction.tag}
                      verdict={shownAction.verdict}
                    />
                  ) : shownAction.scene === "browser" ? (
                    <BrowserApp
                      step={shownAction.step}
                      email={gymEmail}
                      reason={shownAction.reason}
                      agreed={shownAction.agreed}
                      hoverAt={shownCursor?.at}
                    />
                  ) : null}
                </div>
                <StellaCursor cursor={shownCursor} windowRef={windowRef} />
              </div>

              {/* How you asked. */}
              <HomeMiniChatMock className={styles.chatWindow} themeId="pearl">
                <div className={styles.liveChat}>
                  <div
                    className={styles.transcript}
                    data-clearing={clearing || undefined}
                  >
                    {shownEntries.map((entry, i) => (
                      <div key={i} className={chat.entry}>
                        <div className={chat.entryInner}>
                          {entry.kind === "user" ? (
                            <div className={styles.userStack}>
                              {entry.attachment ? (
                                <span className={styles.attachChip}>
                                  <ClipboardList size={11} strokeWidth={2} />
                                  {entry.attachment}
                                </span>
                              ) : null}
                              <div className={mock.userMessage}>{entry.text}</div>
                            </div>
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
                              {entry.connect ? (
                                <ConnectCard connect={entry.connect} />
                              ) : null}
                              {entry.works?.length ? (
                                <div className={styles.workGroup}>
                                  {entry.works.map((work) => (
                                    <WorkRow key={work.id} work={work} />
                                  ))}
                                </div>
                              ) : null}
                              {entry.page ? <PagePill name={entry.page} /> : null}
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
        </div>
      </div>
    </section>
  );
}
