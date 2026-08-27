import { useEffect } from "react";
import { showToast } from "@/ui/toast";
import { useT } from "@/shared/i18n";

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
