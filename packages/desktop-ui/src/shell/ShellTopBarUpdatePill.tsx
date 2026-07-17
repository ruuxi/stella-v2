import { useCallback } from "react";
import { Download, RefreshCw } from "@/ui/icons";
import { showToast } from "@/ui/toast";
import { useWindowType } from "@/shared/hooks/use-window-type";
import { useDesktopUpdate } from "@/global/updates/use-desktop-update";
import { applyDesktopUpdate } from "@/global/updates/apply-desktop-update";
import "./shell-topbar-update-pill.css";

export const ShellTopBarUpdatePill = () => {
  const isMiniWindow = useWindowType() === "mini";
  const { snapshot } = useDesktopUpdate();

  const handleUpdate = useCallback(async () => {
    try {
      const result = await applyDesktopUpdate(snapshot);
      if (result.action === "download") {
        showToast({
          title: "Downloading Stella update",
          description: `Version ${snapshot.availableVersion ?? "available"} will be ready to install shortly.`,
        });
      } else if (result.action === "retry") {
        showToast({
          title: "Checking for updates",
          description: "Stella is checking the isolated desktop v2 channel.",
        });
      }
    } catch (error) {
      showToast({
        title: "Desktop update failed",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "error",
      });
    }
  }, [snapshot]);

  if (isMiniWindow) return null;
  if (
    snapshot.status === "disabled" ||
    snapshot.status === "idle" ||
    snapshot.status === "checking"
  ) {
    return null;
  }

  const isDownloading = snapshot.status === "downloading";
  const isDownloaded = snapshot.status === "downloaded";
  const isError = snapshot.status === "error";
  const percent = Math.round(snapshot.progress?.percent ?? 0);
  const label = isDownloading
    ? `Downloading ${percent}%`
    : isDownloaded
      ? "Restart to update"
      : isError
        ? "Retry update"
        : "Update";
  const title = isDownloaded
    ? `Restart Stella and install version ${snapshot.downloadedVersion ?? snapshot.availableVersion ?? "available"}`
    : isError
      ? (snapshot.error ?? "Retry the desktop update check")
      : `Download Stella ${snapshot.availableVersion ?? "update"}`;

  return (
    <div
      className="shell-topbar-update-pill"
      data-state={
        isDownloading
          ? "active"
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
        disabled={isDownloading}
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
