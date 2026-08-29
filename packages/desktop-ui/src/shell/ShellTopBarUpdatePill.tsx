import { useCallback } from "react";
import { RefreshCw } from "@/ui/icons";
import { showToast } from "@/ui/toast";
import { useDesktopUpdate } from "@/global/updates/use-desktop-update";
import { applyDesktopUpdate } from "@/global/updates/apply-desktop-update";
import type { DesktopUpdateSnapshot } from "@stella/contracts/desktop/update";
import { useT } from "@/shared/i18n";
import "./shell-topbar-update-pill.css";

/**
 * The pill is a one-click affordance, never a progress readout: the update is
 * fetched in the background the moment it is published, so nothing is shown
 * while it checks or downloads. It appears only once the payload is staged and
 * a single click installs it.
 */
export const ShellTopBarUpdatePill = () => {
  const t = useT();
  const { snapshot: rawSnapshot } = useDesktopUpdate();
  // `useDesktopUpdate` is still a JavaScript boundary; Electron supplies the
  // shared desktop-update contract at runtime.
  const snapshot = rawSnapshot as DesktopUpdateSnapshot;

  const handleUpdate = useCallback(async () => {
    try {
      const result = await applyDesktopUpdate(snapshot);
      if (result.action === "retry") {
        showToast({
          title: t("shell.updatePill.toasts.checkingTitle"),
          description: t("shell.updatePill.toasts.checkingDescription"),
        });
      }
    } catch (error) {
      showToast({
        title: t("shell.updatePill.toasts.failedTitle"),
        description:
          error instanceof Error ? error.message : t("chat.tryAgainHint"),
        variant: "error",
      });
    }
  }, [snapshot, t]);

  const isDownloaded = snapshot.status === "downloaded";
  const isRestarting = snapshot.status === "restarting";
  const isError = snapshot.status === "error";
  if (!isDownloaded && !isRestarting && !isError) return null;

  const label = isRestarting
    ? t("shell.updatePill.restarting")
    : isError
      ? t("shell.updatePill.retryUpdate")
      : t("shell.updatePill.update");
  const title = isRestarting
    ? t("shell.updatePill.restartingTitle")
    : isError
      ? (snapshot.error ?? t("shell.updatePill.retryTitle"))
      : // A restart that failed to take leaves the download in place and the
        // reason on the snapshot; that reason is the useful tooltip.
        (snapshot.error ??
        t("shell.updatePill.restartTitle", {
          version:
            snapshot.downloadedVersion ??
            snapshot.availableVersion ??
            t("shell.updatePill.availableFallback"),
        }));

  return (
    <div
      className="shell-topbar-update-pill"
      data-state={isRestarting ? "restarting" : isError ? "error" : "downloaded"}
    >
      <button
        type="button"
        className="shell-topbar-update-pill__main"
        onClick={() => void handleUpdate()}
        disabled={isRestarting}
        aria-label={label}
        title={title}
      >
        <RefreshCw
          className="shell-topbar-update-pill__icon"
          size={12}
          strokeWidth={2}
          aria-hidden
        />
        <span className="shell-topbar-update-pill__label">{label}</span>
      </button>
    </div>
  );
};
