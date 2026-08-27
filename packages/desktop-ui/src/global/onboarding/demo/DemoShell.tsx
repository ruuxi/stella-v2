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
      {

}
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
        {
}
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

export function DemoComposer({
  value,
  typing,
  sending,
  placeholder = "Do anything",
}: {
  value: string;
  typing?: boolean;

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
