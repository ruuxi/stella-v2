import type { ReactNode } from "react";
import styles from "./mock-window.module.css";

export type MockWindowTone = "default" | "sunken" | "dark";

/**
 * Chrome for every product-page mini-mock. Server-rendered: the mocks are
 * static frames, so nothing here needs hydration — motion (if any) is
 * CSS-only and defined by the caller.
 */
export function MockWindow({
  title,
  icon,
  trailing,
  tone = "default",
  chrome = true,
  className,
  style,
  children,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
  tone?: MockWindowTone;
  /** Set false for an information panel that must not pose as a real app
   *  window — keeps the surface tokens, drops the traffic lights. */
  chrome?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={className ? `${styles.window} ${className}` : styles.window}
      data-tone={tone === "default" ? undefined : tone}
      style={style}
    >
      {chrome ? (
        <div className={styles.titlebar}>
          <span className={styles.lights} />
          {title ? (
            <span className={styles.title}>
              {icon}
              {title}
            </span>
          ) : (
            <span className={styles.title} />
          )}
          <span className={styles.trail}>{trailing}</span>
        </div>
      ) : null}
      <div className={styles.body}>{children}</div>
    </div>
  );
}
