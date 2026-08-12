import { useCallback } from "react";
import { Download, RefreshCw } from "@/ui/icons";
import { showToast } from "@/ui/toast";
import { useDesktopUpdate } from "@/global/updates/use-desktop-update";
import { applyDesktopUpdate } from "@/global/updates/apply-desktop-update";
import type { DesktopUpdateSnapshot } from "@stella/contracts/desktop/update";
import { useT } from "@/shared/i18n";
import "./shell-topbar-update-pill.css";

export const ShellTopBarUpdatePill = () => {
  const t = useT();
  const { snapshot: rawSnapshot } = useDesktopUpdate();
  // `useDesktopUpdate` is still a JavaScript boundary; Electron supplies the
  // shared desktop-update contract at runtime.
  const snapshot = rawSnapshot as DesktopUpdateSnapshot;

  const handleUpdate = useCallback(async () => {
    try {
      const result = await applyDesktopUpdate(snapshot);
      if (result.action === "download") {
        showToast({
          title: t("shell.updatePill.toasts.downloadedTitle"),
          description: t("shell.updatePill.toasts.downloadedDescription", {
            version:
              result.snapshot.downloadedVersion ??
              snapshot.availableVersion ??
              t("shell.updatePill.availableFallback"),
          }),
        });
      } else if (result.action === "retry") {
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

  if (
    snapshot.status === "disabled" ||
    snapshot.status === "idle" ||
    snapshot.status === "checking"
  ) {
    return null;
  }

  const isDownloading = snapshot.status === "downloading";
  const isDownloaded = snapshot.status === "downloaded";
  const isRestarting = snapshot.status === "restarting";
  const isError = snapshot.status === "error";
  const percent = Math.round(snapshot.progress?.percent ?? 0);
  const label = isDownloading
    ? t("shell.updatePill.downloading", { percent })
    : isRestarting
      ? t("shell.updatePill.restarting")
      : isDownloaded
        ? t("shell.updatePill.restartToUpdate")
        : isError
          ? t("shell.updatePill.retryUpdate")
          : t("shell.updatePill.update");
  const title = isRestarting
    ? t("shell.updatePill.restartingTitle")
    : isDownloaded
      ? // A restart that failed to take leaves the download in place and the
        // reason on the snapshot; that reason is the useful tooltip.
        (snapshot.error ??
        t("shell.updatePill.restartTitle", {
          version:
            snapshot.downloadedVersion ??
            snapshot.availableVersion ??
            t("shell.updatePill.availableFallback"),
        }))
      : isError
        ? (snapshot.error ?? t("shell.updatePill.retryTitle"))
        : t("shell.updatePill.downloadTitle", {
            version:
              snapshot.availableVersion ?? t("shell.updatePill.updateFallback"),
          });

  return (
    <div
      className="shell-topbar-update-pill"
      data-state={
        isDownloading
          ? "active"
          : isRestarting
            ? "restarting"
            : isDownloaded
              ? "downloaded"
              : isError
                ? "error"
                : "idle"
      }
    >
      <button
        type="button"
        className="shell-topbar-update-pill__main"
        onClick={() => void handleUpdate()}
        disabled={isDownloading || isRestarting}
        aria-label={label}
        title={title}
      >
        {isDownloaded || isError ? (
          <RefreshCw
            className="shell-topbar-update-pill__icon"
            size={12}
            strokeWidth={2}
            aria-hidden
          />
        ) : (
          <Download
            className="shell-topbar-update-pill__icon"
            size={12}
            strokeWidth={2}
            aria-hidden
          />
        )}
        <span className="shell-topbar-update-pill__label">{label}</span>
      </button>
    </div>
  );
};
