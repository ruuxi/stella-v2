/**
 * The onboarding film stage.
 *
 * Every showcase in onboarding plays on one fixed 960×540 canvas that is
 * scaled to the card's width, so choreography can be written in canvas
 * pixels: a window sits at (480, 40), a cursor travels to (712, 318), the
 * camera pushes in on (700, 260) at 1.4×. Nothing reflows mid-shot, which is
 * what lets the motion be precise.
 *
 * The camera is a single transform on the scene layer, moved between shots
 * with a sampled spring (`springEasing`), so pans and pushes feel physical
 * and stay on the compositor. Windows, cursor and threads are positioned
 * absolutely inside the scene and animate with transforms and opacity only.
 *
 * Presentation-only: the cue timeline (`use-choreography`) decides what is on
 * screen; this file only knows how a state looks and how it moves.
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { springEasing } from "@stella/contracts/desktop/spring";
import { Lock } from "@/ui/icons";
import "./film.css";

export const FILM_W = 960;
export const FILM_H = 540;

/** A camera framing: the canvas point at the center of the frame, and zoom. */
export type Shot = { x: number; y: number; z: number };

export const WIDE: Shot = { x: FILM_W / 2, y: FILM_H / 2, z: 1 };

export type Has = (cue: string) => boolean;

/** The latest shot whose cue has passed, else the opening shot. */
export const pickShot = (
  has: Has,
  opening: Shot,
  shots: readonly (readonly [cue: string, shot: Shot])[],
): Shot => {
  let current = opening;
  for (const [cue, shot] of shots) {
    if (has(cue)) current = shot;
  }
  return current;
};

const CAMERA = springEasing(1.05, 0);
const SETTLE = springEasing(0.6, 0);
const POP = springEasing(0.5, 0.28);
const SNAP = springEasing(0.32, 0.18);

/** Spring easings shared by every film element, as custom properties. */
const SPRING_VARS = {
  "--film-camera": CAMERA.easing,
  "--film-camera-ms": `${CAMERA.ms}ms`,
  "--film-settle": SETTLE.easing,
  "--film-settle-ms": `${SETTLE.ms}ms`,
  "--film-pop": POP.easing,
  "--film-pop-ms": `${POP.ms}ms`,
  "--film-snap": SNAP.easing,
  "--film-snap-ms": `${SNAP.ms}ms`,
} as CSSProperties;

/** Scale the fixed canvas to whatever width the card gives the film. */
function useFitScale() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setScale(node.clientWidth / FILM_W);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, scale };
}

export function Film({
  shot,
  backdrop,
  children,
  className,
  tone,
}: {
  shot: Shot;
  /** Painted behind the camera so it never pans out of frame. */
  backdrop?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Optional mood hook for chapter-specific backdrops in CSS. */
  tone?: string;
}) {
  const { ref, scale } = useFitScale();
  const camera = {
    transform: `translate(${FILM_W / 2}px, ${FILM_H / 2}px) scale(${shot.z}) translate(${-shot.x}px, ${-shot.y}px)`,
  } as CSSProperties;
  return (
    <div
      ref={ref}
      className={`ofilm${className ? ` ${className}` : ""}`}
      data-tone={tone}
      style={SPRING_VARS}
      aria-hidden="true"
      inert
    >
      <div
        className="ofilm__canvas"
        style={{ transform: `scale(${scale})`, opacity: scale > 0 ? 1 : 0 }}
      >
        {backdrop ? <div className="ofilm__backdrop">{backdrop}</div> : null}
        <div className="ofilm__camera" style={camera}>
          {children}
        </div>
      </div>
    </div>
  );
}

/* ── Building blocks ─────────────────────────────────────────────── */

type Box = { x: number; y: number; w: number; h: number };

const boxStyle = (box: Box, extra?: CSSProperties): CSSProperties => ({
  left: box.x,
  top: box.y,
  width: box.w,
  height: box.h,
  ...extra,
});

/**
 * Anything placed on the canvas. `from` is where it enters from, relative
 * to its resting box: agent windows are dealt out from behind Stella's
 * window, so they enter from the left, small and turned slightly.
 */
export function Layer({
  box,
  visible,
  from = "rise",
  dim,
  z,
  className,
  style,
  children,
}: {
  box: Box;
  visible: boolean;
  from?: "rise" | "deal" | "drop" | "pop" | "fade" | "right";
  /** Pushes the layer back while something else has focus. */
  dim?: boolean;
  z?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={`ofilm-layer${className ? ` ${className}` : ""}`}
      data-from={from}
      data-visible={visible || undefined}
      data-dim={dim || undefined}
      style={boxStyle(box, { zIndex: z, ...style })}
    >
      {children}
    </div>
  );
}

/** A plain app or browser window: traffic lights, a title or URL, a body. */
export function Win({
  title,
  url,
  badge,
  accent,
  children,
  className,
}: {
  title?: ReactNode;
  url?: ReactNode;
  badge?: ReactNode;
  /** Small app glyph before the title. */
  accent?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ofilm-win${className ? ` ${className}` : ""}`}>
      <div className="ofilm-win__bar">
        <span className="ofilm-win__lights">
          <i />
          <i />
          <i />
        </span>
        {url !== undefined ? (
          <span className="ofilm-win__url">
            <Lock size={9} />
            <span className="ofilm-win__url-text">{url}</span>
          </span>
        ) : (
          <span className="ofilm-win__title">
            {accent}
            {title}
          </span>
        )}
        <span className="ofilm-win__badge" data-visible={badge ? true : undefined}>
          {badge}
        </span>
      </div>
      <div className="ofilm-win__body">{children}</div>
    </div>
  );
}

/**
 * The one pointer on screen. It glides between targets on a spring and
 * presses when `click` is set; `owner="you"` marks the moments the user's
 * own hand acts (approving a purchase) rather than Stella's.
 */
export function Cursor({
  x,
  y,
  visible,
  click,
  owner = "stella",
}: {
  x: number;
  y: number;
  visible: boolean;
  click?: boolean;
  owner?: "stella" | "you";
}) {
  return (
    <span
      className="ofilm-cursor"
      data-visible={visible || undefined}
      data-click={click || undefined}
      data-owner={owner}
      style={{ transform: `translate(${x}px, ${y}px)` }}
    >
      <span className="ofilm-cursor__ripple" />
      <svg width="18" height="20" viewBox="0 0 16 18" fill="none">
        <path
          d="M1.5 1.5v13.2l3.6-3.2 2.3 4.9 2.7-1.3-2.3-4.7h4.8z"
          fill="#fff"
          stroke="#111"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
      {owner === "you" ? <span className="ofilm-cursor__tag">You</span> : null}
    </span>
  );
}

/**
 * A thread from Stella to an agent she spawned: a soft curve that flows
 * while the agent works and settles when it reports back.
 */
export function Thread({
  from,
  to,
  visible,
  done,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  visible: boolean;
  done?: boolean;
}) {
  const dx = Math.max(40, (to.x - from.x) * 0.5);
  const d = `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
  return (
    <svg
      className="ofilm-thread"
      data-visible={visible || undefined}
      data-done={done || undefined}
      width={FILM_W}
      height={FILM_H}
      viewBox={`0 0 ${FILM_W} ${FILM_H}`}
    >
      <path className="ofilm-thread__base" d={d} pathLength={100} />
      <path className="ofilm-thread__flow" d={d} pathLength={100} />
      <circle className="ofilm-thread__node" cx={to.x} cy={to.y} r={3.2} />
      <circle className="ofilm-thread__node" cx={from.x} cy={from.y} r={3.2} />
    </svg>
  );
}

/** Text that swaps with a short blur roll, so a label reads as changing. */
export function Roll({ value, className }: { value: string; className?: string }) {
  return (
    <span className={`ofilm-roll${className ? ` ${className}` : ""}`}>
      <span key={value} className="ofilm-roll__value">
        {value}
      </span>
    </span>
  );
}

/** A caption that sits over the frame's lower edge, like a keynote super. */
export function Super({ visible, children }: { visible: boolean; children: ReactNode }) {
  return (
    <div className="ofilm-super" data-visible={visible || undefined}>
      {children}
    </div>
  );
}
