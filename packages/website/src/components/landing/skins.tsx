"use client";

import type { CSSProperties, ReactNode } from "react";
import { StellaCharacter } from "./stella-character";
import { ThemeGradient, windowThemeStyle, type WindowThemeKey } from "./window-theme";
import s from "./skins.module.css";

export function WindowBar({ status, compact = false }: { status?: ReactNode; compact?: boolean }) {
  return (
    <div className={s.bar} data-compact={compact ? "1" : "0"}>
      <span className={s.lights}>
        <i />
        <i />
        <i />
      </span>
      <span className={s.activity}>
        <StellaCharacter size={20} className={s.mark} state={status ? "working" : "idle"} />
        {status ? <span className={s.status}>{status}</span> : null}
      </span>
      <span className={s.account}>
        Account <small>Pro</small>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M15 4v16" />
        </svg>
      </span>
    </div>
  );
}

export function Composer({ placeholder = "Do anything" }: { placeholder?: string }) {
  return (
    <div className={s.composer}>
      <span className={s.plus}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </span>
      <span className={s.placeholder}>{placeholder}</span>
      <svg className={s.mic} viewBox="0 0 24 24" aria-hidden="true">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
      <span className={s.send}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 19V5M6 11l6-6 6 6" />
        </svg>
      </span>
    </div>
  );
}

export const DEFAULT_LIGHT: WindowThemeKey = { id: "default", dark: false };

export function WindowFrame({
  theme = DEFAULT_LIGHT,
  backdrop,
  className,
  style,
  children,
}: {
  theme?: WindowThemeKey;
  backdrop?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={className ? `${s.stella} ${className}` : s.stella}
      data-dark={theme.dark ? "1" : "0"}
      style={{ ...windowThemeStyle(theme), ...style }}
    >
      <div className={s.backdrop}>{backdrop ?? <ThemeGradient theme={theme} />}</div>
      {children}
    </div>
  );
}

export function StellaSkin({ theme, backdrop }: { theme?: WindowThemeKey; backdrop?: ReactNode }) {
  return (
    <WindowFrame theme={theme} backdrop={backdrop}>
      <WindowBar />
      <div className={s.stellaColumn}>
        <p className={s.stamp}>Today 9:12 AM</p>
        <p className={s.me}>Clean up my Downloads folder?</p>
        <p className={s.her}>Done. 214 files sorted into 9 folders, and 3.2 GB of old installers moved to the Bin.</p>
        <p className={s.stamp}>Today 7:42 PM</p>
        <p className={s.me}>Find us a table for four on Friday around 8</p>
        <p className={s.her}>Booked Lucia for 8pm Friday. It&apos;s in your calendar, and I let Sam and Priya know.</p>
        <p className={s.me}>Perfect. Can you move my 9am to Monday?</p>
        <p className={s.her}>Done. Dr. Okafor confirmed Monday at 9.</p>
        <Composer />
      </div>
    </WindowFrame>
  );
}
