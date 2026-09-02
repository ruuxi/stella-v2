/**
 * Side scenes for the capabilities demo: what Stella is *doing* while the
 * chat on the left shows what she *says*. Each scene is a small mock window
 * (browser, spreadsheet, website, game) driven by the same choreography cues
 * as the chat, so the receipt "Reserved 8:00 PM" lands the moment the form
 * on the right gets its confirmation banner.
 *
 * Everything is presentation-only CSS; `has(cue)` decides each state. The
 * pointer is one shared element moved by `--cx` / `--cy` so the eye reads a
 * single hand doing the work rather than things appearing by themselves.
 */
import type { CSSProperties, ReactNode } from "react";
import { Check, Globe, History, Lock, Star } from "@/ui/icons";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import "./demo-scenes.css";

export type Has = (cue: string) => boolean;

/* ── Shared bits ──────────────────────────────────────────────────── */

/** Chat + scene side by side inside the capabilities frame. */
export function DemoSplit({
  chat,
  scene,
}: {
  chat: ReactNode;
  scene: ReactNode;
}) {
  return (
    <div className="odemo-split">
      <div className="odemo-split__chat">{chat}</div>
      <div className="odemo-split__scene">{scene}</div>
    </div>
  );
}

type CursorAt = { x: number; y: number; click?: boolean };

/** The single pointer that moves between targets as cues pass. */
function Cursor({ at, visible }: { at: CursorAt; visible: boolean }) {
  const style = {
    "--cx": `${at.x}%`,
    "--cy": `${at.y}%`,
  } as CSSProperties;
  return (
    <span
      className="oscene__cursor"
      data-visible={visible || undefined}
      data-click={at.click || undefined}
      style={style}
      aria-hidden="true"
    >
      <svg width="16" height="18" viewBox="0 0 16 18" fill="none">
        <path
          d="M1.5 1.5v13.2l3.6-3.2 2.3 4.9 2.7-1.3-2.3-4.7h4.8z"
          fill="#fff"
          stroke="#111"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function Window({
  title,
  url,
  kind = "browser",
  children,
  visible,
  cursor,
  cursorVisible,
  badge,
}: {
  title?: string;
  url?: string;
  kind?: "browser" | "app" | "finder";
  children: ReactNode;
  visible: boolean;
  cursor?: CursorAt;
  cursorVisible?: boolean;
  badge?: ReactNode;
}) {
  return (
    <div className="oscene" data-kind={kind} data-visible={visible || undefined}>
      <div className="oscene__bar">
        <span className="oscene__lights">
          <span />
          <span />
          <span />
        </span>
        {url ? (
          <span className="oscene__url">
            <Lock size={9} />
            {url}
          </span>
        ) : (
          <span className="oscene__title">{title}</span>
        )}
        {badge ? <span className="oscene__badge">{badge}</span> : null}
      </div>
      <div className="oscene__body">{children}</div>
      {cursor ? <Cursor at={cursor} visible={Boolean(cursorVisible)} /> : null}
    </div>
  );
}

/* ── Errands: a reservation form filled and submitted ─────────────── */

export function ReservationScene({ has }: { has: Has }) {
  const cursor: CursorAt = has("click")
    ? { x: 72, y: 78, click: true }
    : has("fill-3")
      ? { x: 70, y: 60 }
      : has("fill-2")
        ? { x: 45, y: 60 }
        : has("fill-1")
          ? { x: 20, y: 60 }
          : { x: 50, y: 40 };
  return (
    <Window
      url="opentable.com"
      visible={has("page")}
      cursor={cursor}
      cursorVisible={has("fill-1") && !has("confirmed")}
    >
      <div className="oscene__site">
        <div className="oscene__site-head">
          <span className="oscene__site-name">Kura Sushi</span>
          <span className="oscene__site-meta">
            <Star size={9} /> 4.8 · Japanese · $$
          </span>
        </div>
        <div className="oscene__form">
          <span className="oscene__field" data-filled={has("fill-1") || undefined}>
            <em>Date</em>
            <b>Fri, Sep 5</b>
          </span>
          <span className="oscene__field" data-filled={has("fill-2") || undefined}>
            <em>Time</em>
            <b>8:00 PM</b>
          </span>
          <span className="oscene__field" data-filled={has("fill-3") || undefined}>
            <em>Party</em>
            <b>2 people</b>
          </span>
        </div>
        <span
          className="oscene__button"
          data-pressed={has("click") || undefined}
          data-done={has("confirmed") || undefined}
        >
          {has("confirmed") ? (
            <>
              <Check size={10} /> Reserved · Fri 8:00 PM
            </>
          ) : (
            "Reserve"
          )}
        </span>
      </div>
    </Window>
  );
}

/* ── Shopping: product page → size → cart → order placed ──────────── */

export function ShopScene({ has }: { has: Has }) {
  const cursor: CursorAt = has("cart")
    ? { x: 74, y: 84, click: true }
    : has("size")
      ? { x: 58, y: 62, click: true }
      : { x: 50, y: 40 };
  return (
    <Window
      url="runfast.com"
      visible={has("page")}
      cursor={cursor}
      cursorVisible={has("size") && !has("placed")}
    >
      <div className="oscene__product">
        <span className="oscene__product-image">
          <span className="oscene__shoe" />
        </span>
        <div className="oscene__product-info">
          <span className="oscene__site-name">Trail Runner 2</span>
          <span className="oscene__price">$129.99</span>
          <span className="oscene__sizes">
            {["8", "9", "10", "11"].map((size) => (
              <span
                key={size}
                className="oscene__size"
                data-active={(size === "10" && has("size")) || undefined}
              >
                {size}
              </span>
            ))}
          </span>
          <span
            className="oscene__button"
            data-pressed={has("cart") && !has("placed") ? true : undefined}
            data-done={has("placed") || undefined}
          >
            {has("placed") ? (
              <>
                <Check size={10} /> Order placed · arrives Thu
              </>
            ) : (
              "Add to cart"
            )}
          </span>
        </div>
      </div>
    </Window>
  );
}

/* ── Work: a spreadsheet updating, then a deck ────────────────────── */

const SHEET_ROWS = [
  ["Region", "Q2", "Q3"],
  ["North", "412", "468"],
  ["South", "388", "402"],
  ["West", "295", "351"],
  ["Total", "1,095", "1,221"],
];

export function SheetScene({ has }: { has: Has }) {
  const filledRows = has("cells-3") ? 5 : has("cells-2") ? 3 : has("cells-1") ? 2 : 1;
  return (
    <Window
      kind="app"
      title="Q3-revenue.xlsx"
      visible={has("page")}
      badge={has("cells-3") ? "Saved" : undefined}
    >
      <div className="oscene__sheet">
        {SHEET_ROWS.map((row, rowIndex) => (
          <div className="oscene__sheet-row" key={row[0]}>
            {row.map((cell, cellIndex) => (
              <span
                key={cell + cellIndex}
                className="oscene__cell"
                data-head={rowIndex === 0 || cellIndex === 0 || undefined}
                data-fresh={
                  (cellIndex === 2 && rowIndex > 0 && rowIndex < filledRows) ||
                  undefined
                }
                data-empty={
                  (cellIndex === 2 && rowIndex > 0 && rowIndex >= filledRows) ||
                  undefined
                }
              >
                {cellIndex === 2 && rowIndex > 0 && rowIndex >= filledRows
                  ? ""
                  : cell}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="oscene__slides" data-visible={has("deck") || undefined}>
        {[0, 1, 2, 3].map((slide) => (
          <span className="oscene__slide" key={slide} style={{ transitionDelay: `${slide * 120}ms` }}>
            <i />
            <i />
          </span>
        ))}
      </div>
    </Window>
  );
}

/* ── Build: a website assembling, then going live ─────────────────── */

export function SiteScene({ has }: { has: Has }) {
  return (
    <Window
      url={has("live") ? "marasbakery.com" : "preview.stella.sh"}
      visible={has("page")}
      badge={
        has("live") ? (
          <>
            <Globe size={9} /> Live
          </>
        ) : undefined
      }
    >
      <div className="oscene__web">
        <div className="oscene__web-hero" data-visible={has("hero") || undefined}>
          <span className="oscene__web-brand">Mara's Bakery</span>
          <span className="oscene__web-tag">Sourdough, daily. Order by 4pm for tomorrow.</span>
        </div>
        <div className="oscene__web-grid" data-visible={has("menu") || undefined}>
          {["Country loaf", "Morning buns", "Rye", "Focaccia"].map((item, index) => (
            <span className="oscene__web-item" key={item} style={{ transitionDelay: `${index * 90}ms` }}>
              <i />
              <b>{item}</b>
            </span>
          ))}
        </div>
        <span className="oscene__button oscene__web-cta" data-done={has("order") || undefined}>
          {has("pay") ? "Order online · Pay" : "Order online"}
        </span>
      </div>
    </Window>
  );
}

/* ── Games: a mod lands in the folder, then the game ──────────────── */

export function GameScene({ has }: { has: Has }) {
  if (has("game")) {
    return (
      <Window kind="app" title="Minecraft" visible>
        <div className="oscene__game">
          <span className="oscene__sky" />
          <span className="oscene__ground" />
          <span className="oscene__tree" />
          <span className="oscene__fox" data-tamed={has("tame") || undefined}>
            <i className="oscene__fox-ear" />
            <i className="oscene__fox-ear oscene__fox-ear--right" />
            <i className="oscene__fox-eye" />
            <i className="oscene__fox-eye oscene__fox-eye--right" />
          </span>
          <span className="oscene__hearts" data-visible={has("tame") || undefined}>
            <i>♥</i>
            <i>♥</i>
            <i>♥</i>
          </span>
          <span className="oscene__toast" data-visible={has("tame") || undefined}>
            Fox tamed
          </span>
        </div>
      </Window>
    );
  }
  return (
    <Window kind="finder" title="mods" visible={has("page")}>
      <div className="oscene__files">
        {["fabric-api-0.92.jar", "sodium-0.5.jar"].map((file) => (
          <span className="oscene__file" key={file}>
            <i />
            {file}
          </span>
        ))}
        <span className="oscene__file oscene__file--new" data-visible={has("file") || undefined}>
          <i />
          fox-taming-1.0.jar
        </span>
      </div>
    </Window>
  );
}

/* ── Memory step: the chatbot everyone knows, then Stella ──────────── */

const CHATBOT_THREADS = [
  "Dinner ideas for Friday",
  "Trip to Lisbon",
  "Fix my resume",
  "Sushi near me",
  "Q3 numbers",
  "Gift for mom",
  "Untitled",
  "New chat",
];

export function ChatbotMock({ has }: { has: Has }) {
  return (
    <div className="ochatbot">
      <div className="ochatbot__sidebar">
        <span className="ochatbot__new">+ New chat</span>
        {CHATBOT_THREADS.map((thread, index) => (
          <span className="ochatbot__thread" key={thread} data-active={index === 7 || undefined}>
            {thread}
          </span>
        ))}
      </div>
      <div className="ochatbot__main">
        <span className="ochatbot__bubble" data-role="user" data-visible={has("q") || undefined}>
          Book that sushi place again for Friday
        </span>
        <span className="ochatbot__bubble" data-role="assistant" data-visible={has("reply") || undefined}>
          I don't have access to your previous conversations. Which restaurant did you mean?
        </span>
        <span className="ochatbot__composer">Message…</span>
      </div>
    </div>
  );
}

export function StellaMemoryMock({ has }: { has: Has }) {
  const searching = has("recall") && !has("found");
  return (
    <div className="ostella">
      <div className="ostella__bar">
        <StellaLogoIcon size={11} aria-hidden />
        <span>One conversation</span>
      </div>
      <div className="ostella__main">
        <div className="ostella__history" aria-hidden="true">
          <span className="ochatbot__bubble" data-role="user" data-visible>
            Fix the typo on slide 3 and re-export
          </span>
          <span className="ochatbot__bubble" data-role="assistant" data-visible>
            Done. The new PDF is on your desktop.
          </span>
        </div>
        <span className="ochatbot__bubble" data-role="user" data-visible={has("q") || undefined}>
          Book that sushi place again for Friday
        </span>
        <div className="orecall" data-visible={has("recall") || undefined} data-found={has("found") || undefined}>
          <span className="orecall__head">
            <History size={10} />
            {searching ? "Looking back…" : "From last Friday"}
            <i className="orecall__scan" aria-hidden="true" />
          </span>
          <span className="orecall__quote">
            Booked Kura Sushi for two, Friday 8:00 PM. Confirmation is in your email.
          </span>
        </div>
        <span className="ochatbot__bubble" data-role="assistant" data-visible={has("reply") || undefined}>
          Kura Sushi again, table for two at 8? Booking it now.
        </span>
        <span className="ochatbot__composer">Do anything</span>
      </div>
    </div>
  );
}
