/**
 * Shared "realistic Stella window" used by the capabilities demo.
 *
 * One faithful mock of the current shell instead of per-scene
 * approximations, so what users watch in onboarding is what they get in
 * the app:
 *
 *  - the app's own shifting gradient behind everything, in whatever
 *    theme the user picked two phases earlier;
 *  - a transparent top bar carrying the traffic-light inset, the
 *    conversation controls (history / home / New chat) on the left, and
 *    Settings plus the display-panel toggle on the right;
 *  - no left sidebar — the shell redesign removed it, moving navigation
 *    into the top bar and the right-hand display panel;
 *  - a single centered column holding the Cormorant greeting over a
 *    centered composer, which on send drops to the bottom and hands the
 *    column to the message stream — the real home-to-chat morph.
 *
 * Everything is presentation-only: demos drive visibility through the
 * `use-choreography` cues and pass state down as props.
 */

import type { CSSProperties, ReactNode } from "react";
import {
  ArrowUp,
  AudioLines,
  Check,
  History,
  House,
  Mic,
  PanelRight,
  Plus,
  Settings,
} from "@/ui/icons";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import { useTheme } from "@/context/theme-context";
import { ShiftingGradient } from "@/shell/background/ShiftingGradient";
import "./demo-shell.css";

export function DemoShell({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const { gradientMode, gradientColor } = useTheme();
  return (
    <div
      className={`odemo-shell${className ? ` ${className}` : ""}`}
      style={style}
      aria-hidden="true"
    >
      {/* The real window backdrop, scoped to the mock — same component and
          same props `FullShell` passes, so the demo can't drift from the
          theme the user just chose. It paints once per mount (no animation
          loop) and self-downgrades to a CSS gradient on low-power machines. */}
      <ShiftingGradient
        contained
        lightweight={false}
        mode={gradientMode}
        colorMode={gradientColor}
      />
      <div className="odemo-shell__topbar">
        <span className="odemo-shell__lights">
          <span />
          <span />
          <span />
        </span>
        <span className="odemo-shell__controls">
          <span className="odemo-shell__icon-btn">
            <History size={12} strokeWidth={1.85} />
          </span>
          <span className="odemo-shell__icon-btn">
            <House size={12} strokeWidth={1.85} />
          </span>
          <span className="odemo-shell__icon-btn odemo-shell__new-chat">
            <Plus size={12} strokeWidth={1.85} />
            New chat
          </span>
        </span>
        <span className="odemo-shell__topbar-spacer" />
        <span className="odemo-shell__controls">
          <span className="odemo-shell__icon-btn">
            <Settings size={12} strokeWidth={1.75} />
          </span>
          <span className="odemo-shell__icon-btn">
            <PanelRight size={12} strokeWidth={1.75} />
          </span>
        </span>
      </div>
      <main className="odemo-shell__main">{children}</main>
    </div>
  );
}

/* ── Chat column ─────────────────────────────────────────────────── */

/**
 * The message stream plus its composer. `started` runs the home-to-chat
 * morph: the greeting fades and the trailing spacer collapses, gliding
 * the composer from its centered home position down to the bottom.
 */
export function DemoChat({
  started,
  greeting = "What's on your mind?",
  composer,
  children,
}: {
  started?: boolean;
  greeting?: string;
  composer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="odemo-chat" data-started={started || undefined}>
      <div className="odemo-chat__stream">
        {/* Declared first so arriving messages paint over the greeting
            while it is still fading out. */}
        <div className="odemo-chat__greeting">{greeting}</div>
        {children}
      </div>
      {composer}
      <span className="odemo-chat__tail" aria-hidden="true" />
    </div>
  );
}

export function DemoBubble({
  role,
  visible,
  children,
}: {
  role: "user" | "assistant";
  visible: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="odemo-bubble"
      data-role={role}
      data-visible={visible || undefined}
    >
      {children}
    </div>
  );
}

/**
 * The inline working indicator: small Stella mark plus a shimmering
 * status line on an inset pill, exactly where it lives in the real chat.
 */
export function DemoWorking({
  visible,
  label,
}: {
  visible: boolean;
  label: string;
}) {
  return (
    <div className="odemo-working" data-visible={visible || undefined}>
      <StellaLogoIcon size={11} aria-hidden />
      <span className="odemo-working__label">{label}</span>
    </div>
  );
}

/**
 * One agent-activity receipt row — "Opening opentable.com", "Reserved
 * 8:00 PM" — on the same soft panel surface the real in-chat work cards
 * use. `running` shimmers, `done` settles with a check.
 */
export function DemoWorkCard({
  visible,
  done,
  icon,
  children,
}: {
  visible: boolean;
  done: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="odemo-workcard"
      data-visible={visible || undefined}
      data-done={done || undefined}
    >
      <span className="odemo-workcard__icon">{icon}</span>
      <span className="odemo-workcard__label">{children}</span>
      <span className="odemo-workcard__check">
        <Check size={11} />
      </span>
    </div>
  );
}

/* ── Composer ────────────────────────────────────────────────────── */

export function DemoComposer({
  value,
  typing,
  sending,
  placeholder = "Do anything",
}: {
  value: string;
  typing?: boolean;
  /** Briefly highlights the send button as the prompt "goes out". */
  sending?: boolean;
  placeholder?: string;
}) {
  const empty = value.length === 0;
  return (
    <div className="odemo-composer" data-filled={!empty || undefined}>
      <span className="odemo-composer__add">
        <Plus size={12} strokeWidth={1.75} />
      </span>
      <span className="odemo-composer__input">
        {empty ? (
          <span className="odemo-composer__placeholder">{placeholder}</span>
        ) : (
          <>
            {value}
            {typing ? <span className="odemo-composer__caret" /> : null}
          </>
        )}
      </span>
      <span className="odemo-composer__mic">
        <Mic size={12} strokeWidth={1.75} />
      </span>
      {empty ? (
        <span className="odemo-composer__voice">
          <AudioLines size={13} strokeWidth={1.75} />
        </span>
      ) : (
        <span
          className="odemo-composer__send"
          data-sending={sending || undefined}
        >
          <ArrowUp size={12} strokeWidth={1.75} />
        </span>
      )}
    </div>
  );
}
