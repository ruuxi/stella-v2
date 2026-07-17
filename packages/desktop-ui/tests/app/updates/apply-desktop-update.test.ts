import { describe, expect, it, vi } from "vitest";
import { applyDesktopUpdate } from "@/global/updates/apply-desktop-update";
import type { DesktopUpdateSnapshot } from "@stella/contracts/desktop/update";
import type { ElectronUpdatesApi } from "@/shared/types/electron";

const snapshot = (
  status: DesktopUpdateSnapshot["status"],
): DesktopUpdateSnapshot => ({
  status,
  channel: "latest-v2",
  currentVersion: "1.0.0",
  availableVersion: "1.0.1",
  downloadedVersion: status === "downloaded" ? "1.0.1" : null,
  releaseName: null,
  releaseDate: null,
  progress: null,
  checkedAt: null,
  error: status === "error" ? "network failed" : null,
});

const api = (): ElectronUpdatesApi => ({
  getState: vi.fn(async () => snapshot("idle")),
  check: vi.fn(async () => snapshot("available")),
  download: vi.fn(async () => snapshot("downloaded")),
  restartAndInstall: vi.fn(async () => ({ accepted: true })),
  onStateChanged: vi.fn(() => () => undefined),
});

describe("applyDesktopUpdate", () => {
  it("downloads an available packaged update", async () => {
    const updates = api();
    await expect(
      applyDesktopUpdate(snapshot("available"), updates),
    ).resolves.toMatchObject({ action: "download" });
    expect(updates.download).toHaveBeenCalledOnce();
  });

  it("restarts only after electron-updater reports the download complete", async () => {
    const updates = api();
    await expect(
      applyDesktopUpdate(snapshot("downloaded"), updates),
    ).resolves.toEqual({ action: "restart" });
    expect(updates.restartAndInstall).toHaveBeenCalledOnce();
  });

  it("retries the isolated feed check after an updater error", async () => {
    const updates = api();
    await expect(
      applyDesktopUpdate(snapshot("error"), updates),
    ).resolves.toMatchObject({ action: "retry" });
    expect(updates.check).toHaveBeenCalledOnce();
  });
});
