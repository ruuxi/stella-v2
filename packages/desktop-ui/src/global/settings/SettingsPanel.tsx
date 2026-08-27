import { useEffect, useRef, type ReactNode } from "react";

export function SettingsPanel({
  children,
  scrollResetKey,
}: {
  children: ReactNode;

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
