import { useCallback, useEffect, useState } from "react";
import { useT } from "@/shared/i18n";
import { Maximize2, Minus, Square, X } from "@/ui/icons";
import {
  WindowsMaximizeIcon,
  WindowsRestoreIcon,
} from "@/shell/ShellTopBarWindowsIcons";

const MAXIMIZE_STATE_SYNC_DELAY_MS = 50;

export const WindowControls = ({
  useWindowsIcons,
  hidden,
}: {
  useWindowsIcons: boolean;
  hidden: boolean;
}) => {
  const t = useT();
  const [isMaximized, setIsMaximized] = useState(false);

  const updateMaximizedState = useCallback(() => {
    const promise = window.electronAPI?.window.isMaximized?.();
    if (!promise) return;
    void promise.then((maximized) => setIsMaximized(Boolean(maximized)));
  }, []);

  useEffect(() => {
    updateMaximizedState();
  }, [updateMaximizedState]);

  return (
    <div
      className="shell-topbar-window-controls"
      data-hidden={hidden ? "true" : undefined}
      aria-hidden={hidden}
    >
      <button
        type="button"
        className="shell-topbar-wc-btn"
        onClick={() => window.electronAPI?.window.minimize?.()}
        aria-label={t("shell.windowControls.minimize")}
      >
        <Minus size={13} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="shell-topbar-wc-btn"
        onClick={() => {
          window.electronAPI?.window.maximize?.();
          window.setTimeout(updateMaximizedState, MAXIMIZE_STATE_SYNC_DELAY_MS);
        }}
        aria-label={
          isMaximized
            ? t("shell.windowControls.restore")
            : t("shell.windowControls.maximize")
        }
      >
        {useWindowsIcons ? (
          isMaximized ? (
            <WindowsRestoreIcon />
          ) : (
            <WindowsMaximizeIcon />
          )
        ) : isMaximized ? (
          <Square size={11} strokeWidth={1.8} />
        ) : (
          <Maximize2 size={12} strokeWidth={1.8} />
        )}
      </button>
      <button
        type="button"
        className="shell-topbar-wc-btn shell-topbar-wc-close"
        onClick={() => window.electronAPI?.window.close?.()}
        aria-label={t("common.close")}
      >
        <X size={13} strokeWidth={1.8} />
      </button>
    </div>
  );
};
