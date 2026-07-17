import type { DesktopUpdateSnapshot } from "@stella/contracts/desktop/update";
import type { ElectronUpdatesApi } from "@/shared/types/electron";

export type ApplyDesktopUpdateResult =
  | { action: "download"; snapshot: DesktopUpdateSnapshot }
  | { action: "restart" }
  | { action: "retry"; snapshot: DesktopUpdateSnapshot }
  | { action: "none" };

export const applyDesktopUpdate = async (
  snapshot: DesktopUpdateSnapshot,
  updates: ElectronUpdatesApi | undefined = window.electronAPI?.updates,
): Promise<ApplyDesktopUpdateResult> => {
  if (!updates) return { action: "none" };
  if (snapshot.status === "available") {
    return { action: "download", snapshot: await updates.download() };
  }
  if (snapshot.status === "downloaded") {
    await updates.restartAndInstall();
    return { action: "restart" };
  }
  if (snapshot.status === "error") {
    return { action: "retry", snapshot: await updates.check() };
  }
  return { action: "none" };
};
