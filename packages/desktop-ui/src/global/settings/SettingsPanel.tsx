import { useEffect, useRef, type ReactNode } from "react";

export function SettingsPanel({
  children,
  scrollResetKey,
}: {
  children: ReactNode;
  /**
   * When this value changes (e.g. the active tab key), the inner scroll
   * region jumps back to the top. Keeps the fixed-height dialog from
   * carrying one tab's scroll offset into the next tab.
   */
  scrollResetKey?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [scrollResetKey]);

  return (
    <div className="settings-panel-wrap">
      <div ref={scrollRef} className="settings-panel">
        {children}
      </div>
    </div>
  );
}
