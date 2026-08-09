import { useEffect } from "react";
import { showToast } from "@/ui/toast";
import { useT } from "@/shared/i18n";

/**
 * Region/window capture runs entirely in the main process; when the capture
 * flow finishes but produces nothing (native capture failed end-to-end), the
 * main process broadcasts a failure signal instead of silently dropping the
 * result. This listener turns that into a visible toast so "I captured but
 * nothing showed up" never happens silently.
 */
export function CaptureErrorToastListener() {
  const t = useT();
  useEffect(() => {
    const off = window.electronAPI?.capture?.onRegionCaptureFailed?.(() => {
      showToast({
        title: t("shell.capture.failedTitle"),
        description: t("shell.capture.failedDescription"),
        variant: "error",
      });
    });
    return () => {
      off?.();
    };
  }, [t]);

  return null;
}
