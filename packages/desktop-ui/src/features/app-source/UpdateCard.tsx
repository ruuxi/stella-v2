import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { springEasing } from "@stella/contracts/desktop/spring";
import { AlertCircle, RefreshCw } from "@/ui/icons";
import "./update-card.css";

/**
 * The card a change to Stella shows up as in the chat: what it is, where it
 * stands, and the one thing to do with it (Update, Undo, Ask Stella). The
 * button turns into a progress ring while the change applies and opens back
 * up around the next action; the icon and the detail line swap with a short
 * blur roll so the card reads as the same object changing state.
 *
 * While its ring spins the button is marked `data-update-transition="live"`:
 * the screen transition keeps it live over the cover and out of the
 * before/after comparison.
 */

export type UpdateCardTone = "update" | "done" | "attention";

export type UpdateCardAction = {
  label: string;
  primary?: boolean;
  onClick: () => void;
};

const PRESS_SPRING = springEasing(0.35, 0.35).easing;

const ICONS: Record<UpdateCardTone, ReactNode> = {
  update: <RefreshCw size={16} strokeWidth={2} />,
  done: (
    <svg
      className="app-update-card__check"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" pathLength={24} />
    </svg>
  ),
  attention: <AlertCircle size={16} strokeWidth={2} />,
};

/**
 * Cross-swaps its content when `value` changes: the old layer leaves while
 * the new one enters, stacked in one grid cell.
 */
const Swap = ({
  value,
  variant,
  appear = false,
  children,
}: {
  value: string;
  variant: "text" | "icon" | "label";
  appear?: boolean;
  children: ReactNode;
}) => {
  const [shown, setShown] = useState({ value, node: children });
  const [leaving, setLeaving] = useState<{ value: string; node: ReactNode } | null>(null);
  if (shown.value !== value) {
    setLeaving(shown);
    setShown({ value, node: children });
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(null), 280);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const entering = leaving !== null || appear;
  return (
    <span className={`app-update-swap app-update-swap--${variant}`}>
      {leaving ? (
        <span
          key={`out:${leaving.value}`}
          className="app-update-swap__layer app-update-swap__layer--out"
          aria-hidden
        >
          {leaving.node}
        </span>
      ) : null}
      <span
        key={`in:${value}`}
        className={`app-update-swap__layer${entering ? " app-update-swap__layer--in" : ""}`}
      >
        {children}
      </span>
    </span>
  );
};

const UpdateButton = ({
  action,
  busy,
  disabled,
}: {
  action: UpdateCardAction;
  busy: boolean;
  disabled: boolean;
}) => {
  const button = useRef<HTMLButtonElement>(null);
  const arc = useRef<SVGCircleElement>(null);
  const width = useRef<number | null>(null);
  const [ring, setRing] = useState(busy);
  const [afterRing, setAfterRing] = useState(false);

  // The ring completes its circle before it gives way to the next action.
  useEffect(() => {
    if (busy) {
      setRing(true);
      return;
    }
    if (!ring) return;
    const fill = arc.current?.animate(
      [{ strokeDasharray: "28 100" }, { strokeDasharray: "100 100" }],
      { duration: 210, easing: "cubic-bezier(.3,0,.2,1)", fill: "forwards" },
    );
    const done = () => {
      setRing(false);
      setAfterRing(true);
    };
    if (fill) void fill.finished.then(done, done);
    else done();
  }, [busy, ring]);

  // The capsule closes into the ring and opens around the next label on a spring.
  useLayoutEffect(() => {
    const element = button.current;
    if (!element) return;
    const next = element.getBoundingClientRect().width;
    const previous = width.current;
    width.current = next;
    if (previous === null || Math.abs(previous - next) < 0.5) return;
    const { easing, ms } = ring ? springEasing(0.38, 0.12) : springEasing(0.42, 0.16);
    element.animate([{ width: `${previous}px` }, { width: `${next}px` }], {
      duration: ms,
      easing,
    });
  }, [ring, action.label]);

  return (
    <button
      ref={button}
      type="button"
      className="app-update-card__button"
      data-primary={action.primary ? "" : undefined}
      data-ring={ring ? "" : undefined}
      data-update-transition={ring ? "live" : undefined}
      aria-busy={busy}
      disabled={busy || disabled}
      onClick={action.onClick}
    >
      {ring ? (
        <svg className="app-update-card__ring" viewBox="0 0 20 20" aria-hidden>
          <circle className="app-update-card__ring-track" cx="10" cy="10" r="7.5" />
          <circle
            ref={arc}
            className="app-update-card__ring-arc"
            cx="10"
            cy="10"
            r="7.5"
            pathLength={100}
          />
        </svg>
      ) : (
        <Swap value={action.label} variant="label" appear={afterRing}>
          {action.label}
        </Swap>
      )}
    </button>
  );
};

export const UpdateCard = ({
  tone,
  title,
  detail,
  action,
  busy = false,
  disabled = false,
  placement = "message",
}: {
  tone: UpdateCardTone;
  title: string;
  detail: string;
  action: UpdateCardAction | null;
  busy?: boolean;
  disabled?: boolean;
  /** In an agent's message, or pinned above the composer. */
  placement?: "message" | "composer";
}) => (
  <div
    className={`app-update-card app-update-card--${placement}`}
    data-tone={tone}
    style={{ "--app-update-press": PRESS_SPRING } as CSSProperties}
  >
    <div className="app-update-card__icon">
      <Swap value={tone} variant="icon">
        {ICONS[tone]}
      </Swap>
    </div>
    <div className="app-update-card__text">
      <div className="app-update-card__title" title={title}>
        {title}
      </div>
      <div className="app-update-card__detail">
        <Swap value={detail} variant="text">
          {detail}
        </Swap>
      </div>
    </div>
    {action ? <UpdateButton action={action} busy={busy} disabled={disabled} /> : null}
  </div>
);
