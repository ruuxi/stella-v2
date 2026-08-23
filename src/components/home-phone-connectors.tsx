"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import styles from "./home-phone-connectors.module.css";

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
/*  Stella app skin                                                   */
/*                                                                    */
/*  Mirrors the real iOS app (stella-mobile) on its default Pearl     */
/*  theme: white flat canvas, hamburger-only top bar, Manrope 17pt    */
/*  copy, accentSoft user bubbles (18 / 4 radii, hairline border),    */
/*  bubble-less assistant prose, the Stella working indicator at the  */
/*  chat tail, and the glass pill composer ("+", "Message Stella",     */
/*  mic, waveform). Sources: mobile/app/(main)/_layout.tsx,           */
/*  src/components/ChatPane.tsx, WorkingIndicator.tsx, theme/*.       */
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

/**
 * Landing time (ms after the phone takes the stage) for each message, paced
 * like a real exchange: a read-dwell after every reply, a short pause after
 * the user sends, then Stella visibly thinks before the final answer lands.
 */
const STELLA_TIMELINE = [500, 1900, 3300, 5000, 8300];
/** When the working indicator enters; it holds ~2.5s and fades as the
 *  final reply (last timeline entry) streams in. */
const THINKING_AT = 5700;

// SF Symbols as used by mobile/src/components/Icon.tsx:
// menu → line.3.horizontal, plus → plus, mic → mic, waveform → waveform.
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3.5 6.2h17M3.5 12h17M3.5 17.8h17"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 4.5v15M4.5 12h15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="8.6"
        y="2.2"
        width="6.8"
        height="12.4"
        rx="3.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
      />
      <path
        d="M4.9 11.2a7.1 7.1 0 0 0 14.2 0M12 18.3v3.4M8.4 21.7h7.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WaveformIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M2.4 10v4M5.6 7.6v8.8M8.8 4.2v15.6M12 1.8v20.4M15.2 5.4v13.2M18.4 8.4v7.2M21.6 10.4v3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Stand-in for the app's working indicator star (stella-v2 mobile
 * `StellaAnimation variant="star"` — the aurora star from the brand mark,
 * "spun like a top" by `starTurn()` in aurora-shader.ts): a 30pt canvas in a
 * 34pt viewport, one staged revolution per 3.2s (drift → wind-up → whip →
 * sprung landing), four horizontal arms seen from a little above the
 * equator (sinElev 0.30) plus the upright axis and hub, tinted with the
 * theme's five aurora ramp stops (Pearl: #859dc3 → #918096, teal-ish low,
 * rose-ish high). The arms' per-frame pose is baked into CSS keyframes
 * sampled from the same starTurn() curve. The ShimmerText label is kept,
 * as in the app.
 */
function WorkingIndicator() {
  return (
    <div
      className={styles.stWorking}
      style={{ ["--t" as string]: THINKING_AT }}
    >
      <span className={styles.stStar}>
        <i className={styles.stStarBloom} />
        <i className={`${styles.stStarArms} ${styles.stStarArmsA}`} />
        <i className={`${styles.stStarArms} ${styles.stStarArmsB}`} />
        <svg className={styles.stStarAxis} viewBox="-15 -15 30 30" aria-hidden="true">
          <defs>
            <linearGradient id="st-axis" x1="0" y1="-6.3" x2="0" y2="6" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#918096" />
              <stop offset="0.45" stopColor="#6a6fab" />
              <stop offset="1" stopColor="#859dc3" />
            </linearGradient>
          </defs>
          <path
            d="M-1.83 0 Q-0.55 -2.4 0 -6.3 Q0.55 -2.4 1.83 0 Q0.5 2.3 0 6 Q-0.5 2.3 -1.66 0 Z"
            fill="url(#st-axis)"
          />
          <circle r="1.15" fill="#6d73ad" />
        </svg>
      </span>
      <span className={styles.stStatus}>Thinking</span>
    </div>
  );
}

function StellaSkin() {
  return (
    <PhoneFrame>
      <div className={`${styles.app} ${styles.stella}`}>
        <header className={styles.stTopBar}>
          <span className={styles.stHamburger}>
            <MenuIcon />
          </span>
        </header>
        <div className={styles.stThread}>
          {stellaThread.map((b, i) =>
            b.from === "you" ? (
              <div
                key={i}
                className={styles.stYou}
                style={{ ["--t" as string]: STELLA_TIMELINE[i] }}
                data-beat
              >
                {b.text}
              </div>
            ) : (
              <p
                key={i}
                className={styles.stAssistant}
                style={{ ["--t" as string]: STELLA_TIMELINE[i] }}
                data-beat
              >
                {b.text}
              </p>
            ),
          )}
          <div className={styles.stTail}>
            <WorkingIndicator />
          </div>
        </div>
        <div className={styles.stComposerWrap}>
          <div className={styles.stComposer}>
            <span className={styles.stPlus}>
              <PlusIcon />
            </span>
            <span className={styles.stPlaceholder}>Message Stella</span>
            <span className={styles.stTrailing}>
              <span className={styles.stMic}>
                <MicIcon />
              </span>
              <span className={styles.stVoice}>
                <WaveformIcon />
              </span>
            </span>
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}

/* ------------------------------------------------------------------ */
/*  Mobile app downloads                                              */
/* ------------------------------------------------------------------ */
// Apple ID 6761148311 — `ascAppId` in stella-mobile/mobile/eas.json; the full
// store URL matches the one the desktop app links from its Phone Access card.
const APP_STORE_URL = "https://apps.apple.com/us/app/stella-your-ai/id6761148311";
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.fromyou.stella";

type DevicePlatform = "desktop" | "ios" | "android";
type StorePlatform = Exclude<DevicePlatform, "desktop">;

function detectDevicePlatform(): DevicePlatform {
  const navigatorWithUaData = navigator as Navigator & {
    userAgentData?: { mobile?: boolean; platform?: string };
  };
  const ua = navigator.userAgent;
  const uaData = navigatorWithUaData.userAgentData;
  const uaPlatform = uaData?.platform ?? "";

  if (/android/i.test(`${ua} ${uaPlatform}`)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";

  // iPadOS can identify itself as macOS when requesting desktop websites.
  if (/Mac/i.test(navigator.platform) && navigator.maxTouchPoints > 1) {
    return "ios";
  }

  // UA-CH is available in Chromium, where a remaining mobile client is
  // Android even when the reduced user agent omits the platform token.
  if (uaData?.mobile) return "android";

  return "desktop";
}

const subscribeToDevicePlatform = () => () => {};
const getServerDevicePlatform = (): DevicePlatform => "desktop";

function AppleLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16.365 12.86c-.023-2.36 1.93-3.49 2.018-3.546-1.099-1.606-2.81-1.826-3.42-1.852-1.456-.148-2.84.86-3.58.86-.74 0-1.881-.838-3.094-.815-1.59.024-3.057.926-3.874 2.351-1.652 2.863-.422 7.094 1.188 9.418.787 1.138 1.724 2.418 2.954 2.373 1.187-.048 1.636-.768 3.07-.768 1.434 0 1.84.768 3.094.744 1.28-.024 2.09-1.16 2.872-2.303.906-1.32 1.279-2.6 1.301-2.667-.029-.013-2.495-.957-2.529-3.795zM14.07 5.638c.655-.793 1.097-1.895.976-2.99-.944.038-2.085.628-2.762 1.42-.607.7-1.139 1.82-.995 2.894 1.052.082 2.126-.534 2.781-1.324z" />
    </svg>
  );
}

function AndroidLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.523 15.341a1.05 1.05 0 1 1 0-2.1 1.05 1.05 0 0 1 0 2.1M6.477 15.341a1.05 1.05 0 1 1 0-2.1 1.05 1.05 0 0 1 0 2.1m11.423-6.33 2.1-3.637a.437.437 0 0 0-.16-.598.437.437 0 0 0-.597.16l-2.126 3.682A12.881 12.881 0 0 0 12 7.575c-1.853 0-3.615.37-5.117 1.043L4.757 4.936a.438.438 0 0 0-.757.438l2.1 3.637C2.493 10.969.33 14.618 0 19h24c-.33-4.382-2.493-8.031-6.1-9.989" />
    </svg>
  );
}

const STORE_DETAILS = {
  ios: {
    url: APP_STORE_URL,
    eyebrow: "Download on the",
    name: "App Store",
    scanWith: "your iPhone or iPad",
    qrCode: "/downloads/stella-app-store-qr.svg",
    icon: <AppleLogo />,
  },
  android: {
    url: PLAY_STORE_URL,
    eyebrow: "Get it on",
    name: "Google Play",
    scanWith: "your Android phone",
    qrCode: "/downloads/stella-google-play-qr.svg",
    icon: <AndroidLogo />,
  },
} satisfies Record<StorePlatform, {
  url: string;
  eyebrow: string;
  name: string;
  scanWith: string;
  qrCode: string;
  icon: ReactNode;
}>;

function StoreLink({
  platform,
  device,
  onDesktopClick,
}: {
  platform: StorePlatform;
  device: DevicePlatform;
  onDesktopClick: (platform: StorePlatform) => void;
}) {
  const store = STORE_DETAILS[platform];
  const isPreferred = device === platform;
  const isSecondary = device !== "desktop" && !isPreferred;

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (device !== "desktop") return;
    event.preventDefault();
    onDesktopClick(platform);
  };

  return (
    <a
      className={styles.storeLink}
      href={store.url}
      data-preferred={isPreferred || undefined}
      data-secondary={isSecondary || undefined}
      onClick={handleClick}
      aria-label={
        device === "desktop"
          ? `Show a QR code for Stella on the ${store.name}`
          : `${store.eyebrow} ${store.name}`
      }
    >
      {store.icon}
      <span className={styles.storeLinkText}>
        <span className={styles.storeLinkEyebrow}>{store.eyebrow}</span>
        <span className={styles.storeLinkName}>{store.name}</span>
      </span>
    </a>
  );
}

function DownloadQrModal({
  platform,
  onClose,
}: {
  platform: StorePlatform;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const store = STORE_DETAILS[platform];

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);
    closeRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className={styles.qrBackdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={styles.qrModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-download-title"
        aria-describedby="mobile-download-description"
      >
        <button
          ref={closeRef}
          className={styles.qrClose}
          type="button"
          onClick={onClose}
          aria-label="Close download QR code"
        >
          <span aria-hidden="true">×</span>
        </button>

        <span className={styles.qrStoreMark}>{store.icon}</span>
        <p className={styles.qrKicker}>Stella for mobile</p>
        <h3 id="mobile-download-title">Scan to open {store.name}</h3>
        <p id="mobile-download-description" className={styles.qrDescription}>
          Point the camera on {store.scanWith} at this code.
        </p>

        <div className={styles.qrCode}>
          <Image
            src={store.qrCode}
            width={196}
            height={196}
            loading="eager"
            unoptimized
            alt={`QR code for Stella on the ${store.name}`}
          />
        </div>

        <a
          className={styles.qrFallbackLink}
          href={store.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open the listing instead <span aria-hidden="true">↗</span>
        </a>
      </div>
    </div>,
    document.body,
  );
}

export function HomePhoneConnectors() {
  const sectionRef = useRef<HTMLElement>(null);
  const [running, setRunning] = useState(false);
  const device = useSyncExternalStore(
    subscribeToDevicePlatform,
    detectDevicePlatform,
    getServerDevicePlatform,
  );
  const [qrPlatform, setQrPlatform] = useState<StorePlatform | null>(null);
  const closeQr = useCallback(() => setQrPlatform(null), []);

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
            The Stella app
          </span>
          <p>
            Text Stella from the mobile app. Every message reaches the same
            assistant on your computer.
          </p>
          <div className={styles.storeLinks}>
            <StoreLink
              platform="ios"
              device={device}
              onDesktopClick={setQrPlatform}
            />
            <StoreLink
              platform="android"
              device={device}
              onDesktopClick={setQrPlatform}
            />
          </div>
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
      {qrPlatform ? (
        <DownloadQrModal platform={qrPlatform} onClose={closeQr} />
      ) : null}
    </section>
  );
}
