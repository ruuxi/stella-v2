/**
 * "What can I do?" — five short films, one request each.
 *
 * Each film opens close on Stella's composer while the request types, then
 * pulls back as she spawns agents: their windows are dealt out from behind
 * hers with a thread back to her, and the camera follows whichever one is
 * doing the interesting thing. Results flow back into the chat as receipts
 * and a reply, and the camera returns to read it. The approval moment in
 * the shopping film is the user's own cursor, labelled "You".
 *
 * Copy inside the films is set dressing (like a screenshot) and stays in
 * English; the card around them is translated.
 */
import type { ReactNode } from "react";
import {
  Check,
  Clock,
  Code,
  CreditCard,
  FileSpreadsheet,
  Globe,
  Presentation,
  Smartphone,
  Star,
  type IconComponent,
} from "@/ui/icons";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import {
  DemoBubble,
  DemoChat,
  DemoComposer,
  DemoShell,
  DemoWorkCard,
  DemoWorking,
} from "@/global/onboarding/demo/DemoShell";
import type { ChoreographyCue } from "@/global/onboarding/demo/use-choreography";
import {
  Cursor,
  Film,
  Layer,
  pickShot,
  Roll,
  Thread,
  WIDE,
  Win,
  type Has,
  type Shot,
} from "./Film";
import "./capability-films.css";

export type CapabilityId = "errands" | "shopping" | "work" | "build" | "routines";

type Receipt = { cue: string; icon: IconComponent; label: string };

export type CapabilityFilm = {
  id: CapabilityId;
  cues: ChoreographyCue[];
  prompt: string;
  render: (props: { has: Has; typed: string; typing: boolean }) => ReactNode;
};

/* ── Stella's window ─────────────────────────────────────────────── */

const STELLA = { x: 30, y: 32, w: 400, h: 476 };
/** Where threads leave Stella's window: its right edge, by the chat tail. */
const THREAD_ORIGIN = { x: STELLA.x + STELLA.w - 6, y: 384 };
/** Opening shot: close on the composer while the request types. */
const COMPOSER_SHOT: Shot = { x: 230, y: 300, z: 1.55 };
const READ_SHOT: Shot = { x: 300, y: 330, z: 1.32 };

function StellaPane({
  has,
  typed,
  typing,
  prompt,
  working,
  receipts,
  reply,
  extra,
  after,
  pauseCue,
}: {
  has: Has;
  typed: string;
  typing: boolean;
  prompt: string;
  working: string;
  receipts: Receipt[];
  reply: string;
  /** Rendered between the receipts and the reply (an approval card). */
  extra?: ReactNode;
  /** Rendered after the reply (a later message). */
  after?: ReactNode;
  /** Stella stops working here to wait on the user. */
  pauseCue?: string;
}) {
  const firstBusy = pauseCue ?? receipts[0]?.cue ?? "reply";
  return (
    <Layer box={STELLA} visible from="fade" z={5}>
      <DemoShell className="ofilm-stella">
        <DemoChat
          started={has("send")}
          composer={
            <DemoComposer
              value={has("send") ? "" : typed}
              typing={typing && !has("send")}
              sending={has("send") && !has("working")}
            />
          }
        >
          <DemoBubble role="user" visible={has("send")}>
            {prompt}
          </DemoBubble>
          <DemoWorking visible={has("working") && !has(firstBusy)} label={working} />
          {receipts.map((receipt) => {
            const Icon = receipt.icon;
            return (
              <DemoWorkCard
                key={receipt.cue}
                visible={has(receipt.cue)}
                done={has(`${receipt.cue}-done`)}
                icon={<Icon size={12} />}
              >
                {receipt.label}
              </DemoWorkCard>
            );
          })}
          {extra}
          <DemoBubble role="assistant" visible={has("reply")}>
            {reply}
          </DemoBubble>
          {after}
        </DemoChat>
      </DemoShell>
    </Layer>
  );
}

/** The user's approval, inline in the chat. */
function ApprovalCard({ has }: { has: Has }) {
  const done = has("approved");
  return (
    <div
      className="ofc-approve"
      data-visible={has("ask") || undefined}
      data-done={done || undefined}
    >
      <span className="ofc-approve__icon">
        <CreditCard size={12} />
      </span>
      <span className="ofc-approve__text">
        <b>{done ? "Approved" : "OK to buy?"}</b>
        <i>Trail Runner 2 · size 10 · $129.99</i>
      </span>
      <span className="ofc-approve__btn" data-pressed={has("approve") || undefined}>
        {done ? <Check size={11} /> : "Approve"}
      </span>
    </div>
  );
}

/* ── 1. Errands: find a quiet place, book it, put it on the calendar ── */

const ERRANDS_CUES: ChoreographyCue[] = [
  { id: "send", at: 1500 },
  { id: "working", at: 1850 },
  { id: "agent", at: 2200 },
  { id: "results", at: 2600 },
  { id: "pick", at: 3300 },
  { id: "open", at: 3800 },
  { id: "fill-1", at: 4250 },
  { id: "fill-2", at: 4650 },
  { id: "fill-3", at: 5050 },
  { id: "click", at: 5500 },
  { id: "reserved", at: 5850 },
  { id: "work-1", at: 5950 },
  { id: "work-1-done", at: 6100 },
  { id: "agent-2", at: 6250 },
  { id: "event", at: 6850 },
  { id: "work-2", at: 7000 },
  { id: "work-2-done", at: 7200 },
  { id: "reply", at: 7600 },
  { id: "end", at: 9300 },
];

const BROWSER_A = { x: 474, y: 50, w: 450, h: 306 };
const CALENDAR = { x: 640, y: 288, w: 286, h: 214 };

const RESTAURANTS = [
  { name: "Ozen", meta: "Japanese · Lively", tone: 28 },
  { name: "Kura Sushi", meta: "Omakase · Quiet", tone: 200 },
  { name: "Lupa", meta: "Italian · Busy", tone: 60 },
];

function ErrandsFilm({ has, typed, typing }: { has: Has; typed: string; typing: boolean }) {
  const shot = pickShot(has, COMPOSER_SHOT, [
    ["send", { x: 300, y: 300, z: 1.2 }],
    ["agent", WIDE],
    ["pick", { x: 700, y: 214, z: 1.42 }],
    ["agent-2", { x: 690, y: 330, z: 1.2 }],
    ["reply", READ_SHOT],
    ["end", WIDE],
  ]);
  const cursor = has("click")
    ? { x: 572, y: 256, click: true }
    : has("fill-3")
      ? { x: 840, y: 202 }
      : has("fill-2")
        ? { x: 702, y: 202 }
        : has("fill-1")
          ? { x: 560, y: 202 }
          : has("pick")
            ? { x: 660, y: 206, click: !has("open") }
            : { x: 720, y: 150 };
  return (
    <Film shot={shot}>
      <StellaPane
        has={has}
        typed={typed}
        typing={typing}
        prompt="Book somewhere quiet for two, Friday at 8"
        working="Looking for a table…"
        receipts={[
          { cue: "work-1", icon: Globe, label: "Kura Sushi · Fri 8:00 PM · 2 guests" },
          { cue: "work-2", icon: Clock, label: "Added to your calendar" },
        ]}
        reply="Booked Kura Sushi, Friday at 8. It's quiet, and it's on your calendar."
      />
      <Thread
        from={THREAD_ORIGIN}
        to={{ x: BROWSER_A.x, y: BROWSER_A.y + 60 }}
        visible={has("agent")}
        done={has("reserved")}
      />
      <Layer box={BROWSER_A} visible={has("agent")} from="deal" z={10} dim={has("agent-2") && !has("reply")}>
        <Win url={has("open") ? "opentable.com/kura-sushi" : "opentable.com/s?quiet"}>
          <div className="ofc-results" data-gone={has("open") || undefined}>
            <div className="ofc-results__head">Friday, 8:00 PM · 2 guests · Quiet</div>
            {RESTAURANTS.map((r, index) => (
              <div
                key={r.name}
                className="ofc-results__row"
                data-visible={has("results") || undefined}
                data-picked={(index === 1 && has("pick")) || undefined}
                style={{ transitionDelay: `${index * 90}ms`, ["--hue" as string]: r.tone }}
              >
                <i className="ofc-results__thumb" />
                <span className="ofc-results__text">
                  <b>{r.name}</b>
                  <em>
                    <Star size={9} /> 4.{8 - index} · {r.meta}
                  </em>
                </span>
                <span className="ofc-results__slot">8:00</span>
              </div>
            ))}
          </div>
          <div className="ofc-book" data-visible={has("open") || undefined}>
            <div className="ofc-book__hero">
              <b>Kura Sushi</b>
              <em>
                <Star size={9} /> 4.8 · Omakase · Quiet room
              </em>
            </div>
            <div className="ofc-book__fields">
              {[
                ["Date", "Fri, Oct 9", "fill-1"],
                ["Time", "8:00 PM", "fill-2"],
                ["Party", "2 guests", "fill-3"],
              ].map(([label, value, cue]) => (
                <span key={label} className="ofc-field" data-filled={has(cue!) || undefined}>
                  <em>{label}</em>
                  <b>{value}</b>
                </span>
              ))}
            </div>
            <span
              className="ofc-cta"
              data-pressed={(has("click") && !has("reserved")) || undefined}
              data-done={has("reserved") || undefined}
            >
              <span className="ofc-cta__label">Reserve</span>
              <span className="ofc-cta__done">
                <Check size={11} /> Reserved · Fri 8:00 PM
              </span>
            </span>
          </div>
        </Win>
      </Layer>
      <Thread
        from={THREAD_ORIGIN}
        to={{ x: CALENDAR.x, y: CALENDAR.y + 50 }}
        visible={has("agent-2")}
        done={has("event")}
      />
      <Layer box={CALENDAR} visible={has("agent-2")} from="deal" z={12}>
        <Win title="Calendar" accent={<Clock size={11} />}>
          <div className="ofc-cal">
            {["Wed", "Thu", "Fri"].map((day) => (
              <span key={day} className="ofc-cal__day">
                {day}
              </span>
            ))}
            {["6 PM", "7 PM", "8 PM", "9 PM"].map((hour) => (
              <span key={hour} className="ofc-cal__row">
                <em>{hour}</em>
              </span>
            ))}
            <span className="ofc-cal__busy" style={{ left: "16%", top: "30%" }}>
              Gym
            </span>
            <span className="ofc-cal__busy" style={{ left: "44%", top: "50%" }}>
              Call
            </span>
            <span className="ofc-cal__event" data-visible={has("event") || undefined}>
              <b>Kura Sushi</b>
              <em>8:00 – 9:30</em>
            </span>
          </div>
        </Win>
      </Layer>
      <Cursor
        x={cursor.x}
        y={cursor.y}
        click={cursor.click}
        visible={has("results") && !has("reserved")}
      />
    </Film>
  );
}

/* ── 2. Shopping: find it, check out, wait for the user's OK ──────── */

const SHOPPING_CUES: ChoreographyCue[] = [
  { id: "send", at: 1500 },
  { id: "working", at: 1850 },
  { id: "agent", at: 2200 },
  { id: "page", at: 2500 },
  { id: "size", at: 3200 },
  { id: "cart", at: 3800 },
  { id: "checkout", at: 4300 },
  { id: "ask", at: 4800 },
  { id: "you", at: 5200 },
  { id: "approve", at: 5900 },
  { id: "approved", at: 6150 },
  { id: "placed", at: 6700 },
  { id: "work-1", at: 6900 },
  { id: "work-1-done", at: 7050 },
  { id: "reply", at: 7500 },
  { id: "end", at: 9200 },
];

const BROWSER_B = { x: 474, y: 64, w: 450, h: 330 };

function ShoppingFilm({ has, typed, typing }: { has: Has; typed: string; typing: boolean }) {
  const shot = pickShot(has, COMPOSER_SHOT, [
    ["send", { x: 300, y: 300, z: 1.2 }],
    ["agent", WIDE],
    ["page", { x: 700, y: 236, z: 1.36 }],
    ["ask", { x: 240, y: 380, z: 1.5 }],
    ["placed", { x: 700, y: 236, z: 1.36 }],
    ["reply", READ_SHOT],
    ["end", WIDE],
  ]);
  const stellaCursor = has("cart")
    ? { x: 796, y: 252, click: !has("checkout") }
    : has("size")
      ? { x: 798, y: 204, click: true }
      : { x: 770, y: 150 };
  return (
    <Film shot={shot}>
      <StellaPane
        has={has}
        typed={typed}
        typing={typing}
        prompt="Reorder my trail runners, size 10"
        working="Finding them…"
        receipts={[
          { cue: "work-1", icon: CreditCard, label: "Order #48213 · $129.99 · arrives Thu" },
        ]}
        extra={<ApprovalCard has={has} />}
        pauseCue="ask"
        reply="Ordered. They arrive Thursday, and the receipt's in your email."
      />
      <Thread
        from={THREAD_ORIGIN}
        to={{ x: BROWSER_B.x, y: BROWSER_B.y + 70 }}
        visible={has("agent")}
        done={has("placed")}
      />
      <Layer box={BROWSER_B} visible={has("agent")} from="deal" z={10}>
        <Win
          url="runfast.com/trail-runner-2"
          badge={
            has("placed") ? (
              <>
                <Check size={9} /> Ordered
              </>
            ) : has("checkout") ? (
              "Waiting for your OK"
            ) : undefined
          }
        >
          <div className="ofc-shop" data-visible={has("page") || undefined}>
            <div className="ofc-shop__image">
              <svg viewBox="0 0 120 64" className="ofc-shoe" aria-hidden="true">
                <path
                  d="M8 44c0-9 4-17 10-22l14-4c4 7 10 11 20 12l30 5c14 2 26 8 30 17v6H8z"
                  fill="currentColor"
                />
                <path d="M8 50h104v6c0 2-2 4-4 4H12c-2 0-4-2-4-4z" className="ofc-shoe__sole" />
                <path
                  d="M38 24l6 8M46 22l6 8M54 23l5 7"
                  stroke="white"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  opacity=".8"
                />
              </svg>
            </div>
            <div className="ofc-shop__info">
              <b>Trail Runner 2</b>
              <span className="ofc-shop__price">$129.99</span>
              <span className="ofc-shop__label">Size</span>
              <span className="ofc-shop__sizes">
                {["8", "9", "10", "11"].map((size) => (
                  <span
                    key={size}
                    className="ofc-size"
                    data-active={(size === "10" && has("size")) || undefined}
                  >
                    {size}
                  </span>
                ))}
              </span>
              <span
                className="ofc-cta"
                data-pressed={(has("cart") && !has("checkout")) || undefined}
                data-done={has("placed") || undefined}
              >
                <span className="ofc-cta__label">Add to cart</span>
                <span className="ofc-cta__done">
                  <Check size={11} /> Order placed · arrives Thu
                </span>
              </span>
            </div>
          </div>
          <div className="ofc-checkout" data-visible={(has("checkout") && !has("placed")) || undefined}>
            <span className="ofc-checkout__row">
              <em>Trail Runner 2 · 10</em>
              <b>$129.99</b>
            </span>
            <span className="ofc-checkout__row">
              <em>Shipping</em>
              <b>Free</b>
            </span>
            <span className="ofc-checkout__pay">
              <CreditCard size={11} /> Visa ·· 6411
            </span>
            <span className="ofc-checkout__hold">
              <StellaLogoIcon size={10} aria-hidden /> Paused for your OK
            </span>
          </div>
        </Win>
      </Layer>
      <Cursor
        x={stellaCursor.x}
        y={stellaCursor.y}
        click={stellaCursor.click}
        visible={has("page") && !has("checkout")}
      />
      <Cursor
        owner="you"
        x={has("you") ? 300 : 380}
        y={has("you") ? 366 : 450}
        click={has("approve") && !has("approved")}
        visible={has("you") && !has("placed")}
      />
    </Film>
  );
}

/* ── 3. Work: two agents at once, and a chart that changes hands ──── */

const WORK_CUES: ChoreographyCue[] = [
  { id: "send", at: 1600 },
  { id: "working", at: 1950 },
  { id: "agent", at: 2300 },
  { id: "agent-2", at: 2650 },
  { id: "cells-1", at: 3000 },
  { id: "cells-2", at: 3350 },
  { id: "cells-3", at: 3700 },
  { id: "chart", at: 4050 },
  { id: "work-1", at: 4300 },
  { id: "work-1-done", at: 4500 },
  { id: "fly", at: 4800 },
  { id: "landed", at: 5600 },
  { id: "slides", at: 5800 },
  { id: "work-2", at: 6200 },
  { id: "work-2-done", at: 6500 },
  { id: "reply", at: 6900 },
  { id: "end", at: 8600 },
];

const SHEET = { x: 468, y: 40, w: 322, h: 252 };
const DECK = { x: 600, y: 262, w: 330, h: 240 };
/** The chart's two homes, in canvas pixels: in the sheet, then the slide. */
const CHART_IN_SHEET = { x: SHEET.x + 196, y: SHEET.y + 70, w: 112, h: 92 };
const CHART_ON_SLIDE = { x: DECK.x + 118, y: DECK.y + 70, w: 132, h: 108 };
const FLIGHT = {
  dx: CHART_ON_SLIDE.x - CHART_IN_SHEET.x,
  dy: CHART_ON_SLIDE.y - CHART_IN_SHEET.y,
  scale: CHART_ON_SLIDE.w / CHART_IN_SHEET.w,
};

const SHEET_ROWS: [string, string, string][] = [
  ["North", "412", "468"],
  ["South", "388", "402"],
  ["West", "295", "351"],
  ["Total", "1,095", "1,221"],
];

function Bars({ grown }: { grown: boolean }) {
  return (
    <span className="ofc-bars" data-grown={grown || undefined}>
      {[46, 62, 38, 78].map((height, index) => (
        <i key={index} style={{ height: `${height}%`, transitionDelay: `${index * 70}ms` }} />
      ))}
    </span>
  );
}

function WorkFilm({ has, typed, typing }: { has: Has; typed: string; typing: boolean }) {
  const shot = pickShot(has, COMPOSER_SHOT, [
    ["send", { x: 300, y: 300, z: 1.2 }],
    ["agent", WIDE],
    ["cells-1", { x: 630, y: 170, z: 1.42 }],
    ["fly", { x: 690, y: 270, z: 1.12 }],
    ["slides", { x: 765, y: 380, z: 1.4 }],
    ["reply", READ_SHOT],
    ["end", WIDE],
  ]);
  const filled = has("cells-3") ? 3 : has("cells-2") ? 2 : has("cells-1") ? 1 : 0;
  const flying = has("fly");
  return (
    <Film shot={shot}>
      <StellaPane
        has={has}
        typed={typed}
        typing={typing}
        prompt="Update the Q3 sheet and turn it into a board deck"
        working="Starting two agents…"
        receipts={[
          { cue: "work-1", icon: FileSpreadsheet, label: "Q3-revenue.xlsx · 214 cells updated" },
          { cue: "work-2", icon: Presentation, label: "Board deck.pptx · 14 slides" },
        ]}
        reply="Both done. Revenue's up 11.5%, and slide 4 has the chart."
      />
      <Thread
        from={THREAD_ORIGIN}
        to={{ x: SHEET.x, y: SHEET.y + 60 }}
        visible={has("agent")}
        done={has("work-1-done")}
      />
      <Thread
        from={THREAD_ORIGIN}
        to={{ x: DECK.x, y: DECK.y + 60 }}
        visible={has("agent-2")}
        done={has("work-2-done")}
      />
      <Layer box={SHEET} visible={has("agent")} from="deal" z={10} dim={has("slides") && !has("reply")}>
        <Win
          title="Q3-revenue.xlsx"
          accent={<FileSpreadsheet size={11} />}
          badge={has("chart") ? "Saved" : undefined}
        >
          <div className="ofc-sheet">
            <div className="ofc-sheet__row" data-head>
              <span>Region</span>
              <span>Q2</span>
              <span>Q3</span>
            </div>
            {SHEET_ROWS.map(([region, q2, q3], index) => (
              <div className="ofc-sheet__row" key={region} data-total={region === "Total" || undefined}>
                <span>{region}</span>
                <span>{q2}</span>
                <span
                  className="ofc-sheet__fresh"
                  data-filled={index < filled || (index === 3 && filled === 3) || undefined}
                >
                  {q3}
                </span>
              </div>
            ))}
          </div>
          <span className="ofc-sheet__chart-slot" data-empty={flying || undefined} />
        </Win>
      </Layer>
      <Layer box={DECK} visible={has("agent-2")} from="deal" z={11}>
        <Win title="Board deck.pptx" accent={<Presentation size={11} />}>
          <div className="ofc-deck">
            <div className="ofc-deck__strip">
              {[0, 1, 2, 3, 4].map((index) => (
                <span
                  key={index}
                  className="ofc-deck__thumb"
                  data-visible={(index < 3 || has("slides")) || undefined}
                  data-active={index === 3 || undefined}
                  style={{ transitionDelay: `${index * 80}ms` }}
                >
                  <i />
                  <i />
                </span>
              ))}
            </div>
            <div className="ofc-deck__slide">
              <b>Q3 revenue</b>
              <em data-visible={has("slides") || undefined}>+11.5% quarter over quarter</em>
            </div>
          </div>
        </Win>
      </Layer>
      {/* The chart is one object: it grows in the sheet, lifts off and
          lands on the slide, so the eye follows a single thing across. X and
          Y travel on different curves, which bends the flight into an arc. */}
      <Layer box={CHART_IN_SHEET} visible={has("chart")} from="fade" z={20}>
        <span
          className="ofc-flight-x"
          style={{ transform: flying ? `translateX(${FLIGHT.dx}px)` : undefined }}
        >
          <span
            className="ofc-flight-y"
            style={{
              transform: flying
                ? `translateY(${FLIGHT.dy}px) scale(${FLIGHT.scale})`
                : undefined,
            }}
          >
            <span className="ofc-chart" data-lifted={(flying && !has("landed")) || undefined}>
              <Bars grown={has("chart")} />
            </span>
          </span>
        </span>
      </Layer>
    </Film>
  );
}

/* ── 4. Build: code, a site that assembles, then live ─────────────── */

const BUILD_CUES: ChoreographyCue[] = [
  { id: "send", at: 1600 },
  { id: "working", at: 1950 },
  { id: "agent", at: 2300 },
  { id: "work-1", at: 2500 },
  { id: "preview", at: 3400 },
  { id: "work-1-done", at: 3500 },
  { id: "hero", at: 3800 },
  { id: "menu", at: 4300 },
  { id: "order", at: 4800 },
  { id: "live", at: 5400 },
  { id: "work-2", at: 5500 },
  { id: "work-2-done", at: 5700 },
  { id: "phone", at: 6100 },
  { id: "ping", at: 6600 },
  { id: "work-3", at: 6700 },
  { id: "work-3-done", at: 6900 },
  { id: "reply", at: 7300 },
  { id: "end", at: 9000 },
];

const CODE = { x: 466, y: 46, w: 300, h: 236 };
const PREVIEW = { x: 548, y: 130, w: 360, h: 330 };
const PHONE = { x: 836, y: 270, w: 104, h: 210 };

const CODE_LINES: [number, string][] = [
  [0, "export default function Home() {"],
  [1, "return <Layout>"],
  [2, "<Hero title=\"Mara's Bakery\" />"],
  [2, "<Menu items={menu} />"],
  [2, "<OrderOnline pay=\"stripe\" />"],
  [1, "</Layout>"],
  [0, "}"],
];

function BuildFilm({ has, typed, typing }: { has: Has; typed: string; typing: boolean }) {
  const shot = pickShot(has, COMPOSER_SHOT, [
    ["send", { x: 300, y: 300, z: 1.2 }],
    ["agent", { x: 600, y: 200, z: 1.3 }],
    ["preview", { x: 728, y: 300, z: 1.32 }],
    ["phone", { x: 790, y: 330, z: 1.4 }],
    ["reply", READ_SHOT],
    ["end", WIDE],
  ]);
  return (
    <Film shot={shot}>
      <StellaPane
        has={has}
        typed={typed}
        typing={typing}
        prompt="Make a website for my bakery with online ordering"
        working="Building the site…"
        receipts={[
          { cue: "work-1", icon: Code, label: "Built 4 pages from your menu" },
          { cue: "work-2", icon: Globe, label: "Live at marasbakery.com" },
          { cue: "work-3", icon: Smartphone, label: "Orders go to your phone" },
        ]}
        reply="It's live at marasbakery.com. New orders ping your phone."
      />
      <Thread
        from={THREAD_ORIGIN}
        to={{ x: CODE.x, y: CODE.y + 60 }}
        visible={has("agent")}
        done={has("live")}
      />
      <Layer box={CODE} visible={has("agent")} from="deal" z={10} dim={has("preview")}>
        <Win title="site/app/page.tsx" accent={<Code size={11} />}>
          <div className="ofc-code" data-visible={has("work-1") || undefined}>
            {CODE_LINES.map(([indent, line], index) => (
              <span
                key={index}
                className="ofc-code__line"
                style={{ paddingLeft: indent * 14, transitionDelay: `${index * 110}ms` }}
              >
                <i>{index + 1}</i>
                {line}
              </span>
            ))}
          </div>
        </Win>
      </Layer>
      <Layer box={PREVIEW} visible={has("preview")} from="rise" z={11}>
        <Win
          url={<Roll value={has("live") ? "marasbakery.com" : "localhost:5173"} />}
          badge={
            has("live") ? (
              <>
                <i className="ofc-live-dot" /> Live
              </>
            ) : undefined
          }
        >
          <div className="ofc-site">
            <div className="ofc-site__hero" data-visible={has("hero") || undefined}>
              <b>Mara's Bakery</b>
              <em>Sourdough, daily. Order by 4 for tomorrow.</em>
            </div>
            <div className="ofc-site__menu">
              {["Country loaf", "Morning buns", "Rye", "Focaccia"].map((item, index) => (
                <span
                  key={item}
                  className="ofc-site__item"
                  data-visible={has("menu") || undefined}
                  style={{ transitionDelay: `${index * 80}ms`, ["--hue" as string]: 40 + index * 18 }}
                >
                  <i />
                  <b>{item}</b>
                </span>
              ))}
            </div>
            <span className="ofc-site__order" data-visible={has("order") || undefined}>
              Order online
            </span>
          </div>
        </Win>
      </Layer>
      <Layer box={PHONE} visible={has("phone")} from="right" z={14}>
        <div className="ofc-phone">
          <span className="ofc-phone__island" />
          <span className="ofc-phone__time">9:41</span>
          <span className="ofc-phone__note" data-visible={has("ping") || undefined}>
            <b>New order</b>
            <em>2 morning buns · $9</em>
          </span>
        </div>
      </Layer>
    </Film>
  );
}

/* ── 5. Routines: ask once, and it happens every morning ───────────── */

const ROUTINE_CUES: ChoreographyCue[] = [
  { id: "send", at: 1700 },
  { id: "working", at: 2050 },
  { id: "work-1", at: 2450 },
  { id: "work-1-done", at: 2700 },
  { id: "reply", at: 3000 },
  { id: "night", at: 3800 },
  { id: "t1", at: 4150 },
  { id: "t2", at: 4550 },
  { id: "t3", at: 4950 },
  { id: "dawn", at: 5250 },
  { id: "brief", at: 5700 },
  { id: "morning", at: 6400 },
  { id: "end", at: 8400 },
];

const CLOCK = { x: 500, y: 92, w: 420, h: 340 };

function RoutineFilm({ has, typed, typing }: { has: Has; typed: string; typing: boolean }) {
  const shot = pickShot(has, COMPOSER_SHOT, [
    ["send", { x: 300, y: 300, z: 1.2 }],
    ["reply", READ_SHOT],
    ["night", { x: 650, y: 270, z: 1.08 }],
    ["brief", { x: 690, y: 210, z: 1.18 }],
    ["morning", READ_SHOT],
    ["end", WIDE],
  ]);
  const time = has("dawn")
    ? "8:00"
    : has("t3")
      ? "6:55"
      : has("t2")
        ? "3:10"
        : has("t1")
          ? "12:40"
          : "11:42";
  const meridiem = has("dawn") || has("t3") || has("t2") || has("t1") ? "AM" : "PM";
  const phase = has("dawn") ? "dawn" : has("night") ? "night" : "day";
  return (
    <Film
      shot={shot}
      tone={phase}
      backdrop={
        <span className="ofc-sky" data-phase={phase}>
          <i className="ofc-sky__night" />
          <i className="ofc-sky__dawn" />
        </span>
      }
    >
      <StellaPane
        has={has}
        typed={typed}
        typing={typing}
        prompt="Every morning at 8, brief me on my inbox and day"
        working="Scheduling it…"
        receipts={[{ cue: "work-1", icon: Clock, label: "Every day at 8:00 AM · Morning brief" }]}
        reply="Done. I'll have it ready at 8 every morning."
        after={
          <DemoBubble role="assistant" visible={has("morning")}>
            Morning. Three emails need you, and standup moved to 10:30.
          </DemoBubble>
        }
      />
      <Layer box={CLOCK} visible={has("night") && !has("morning")} from="fade" z={8}>
        <div className="ofc-clock" data-phase={phase}>
          <span className="ofc-clock__time">
            <Roll value={time} />
            <em>{meridiem}</em>
          </span>
          <span className="ofc-clock__sub">
            {has("dawn") ? "Your brief is ready" : "Stella keeps going while you sleep"}
          </span>
        </div>
      </Layer>
      <Layer box={{ x: 590, y: 40, w: 330, h: 66 }} visible={has("brief")} from="drop" z={16}>
        <div className="ofc-banner">
          <span className="ofc-banner__app">
            <StellaLogoIcon size={14} aria-hidden />
          </span>
          <span className="ofc-banner__text">
            <b>Morning brief</b>
            <em>3 emails need you · standup moved to 10:30</em>
          </span>
          <span className="ofc-banner__when">now</span>
        </div>
      </Layer>
    </Film>
  );
}

export const CAPABILITY_FILMS: CapabilityFilm[] = [
  {
    id: "errands",
    cues: ERRANDS_CUES,
    prompt: "Book somewhere quiet for two, Friday at 8",
    render: (props) => <ErrandsFilm {...props} />,
  },
  {
    id: "shopping",
    cues: SHOPPING_CUES,
    prompt: "Reorder my trail runners, size 10",
    render: (props) => <ShoppingFilm {...props} />,
  },
  {
    id: "work",
    cues: WORK_CUES,
    prompt: "Update the Q3 sheet and turn it into a board deck",
    render: (props) => <WorkFilm {...props} />,
  },
  {
    id: "build",
    cues: BUILD_CUES,
    prompt: "Make a website for my bakery with online ordering",
    render: (props) => <BuildFilm {...props} />,
  },
  {
    id: "routines",
    cues: ROUTINE_CUES,
    prompt: "Every morning at 8, brief me on my inbox and day",
    render: (props) => <RoutineFilm {...props} />,
  },
];
