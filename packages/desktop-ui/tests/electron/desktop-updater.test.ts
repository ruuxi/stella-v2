import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopUpdater,
  assertIsolatedV2UpdateFeed,
  type DesktopUpdaterClient,
} from "../../../desktop/electron/updates/desktop-updater";

class FakeUpdater implements DesktopUpdaterClient {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  allowPrerelease = true;
  disableWebInstaller = false;
  readonly events = new EventEmitter();
  readonly setFeedURL = vi.fn();
  readonly quitAndInstall = vi.fn();

  checkForUpdates = vi.fn(async () => {
    this.events.emit("checking-for-update");
    this.events.emit("update-available", {
      version: "1.0.1",
      releaseName: "Stella 1.0.1",
      releaseDate: "2026-07-16T00:00:00.000Z",
    });
  });

  downloadUpdate = vi.fn(async () => {
    this.events.emit("download-progress", {
      percent: 42.4,
      bytesPerSecond: 1_024,
      transferred: 424,
      total: 1_000,
    });
    this.events.emit("update-downloaded", { version: "1.0.1" });
  });

  on(event: string, listener: (...args: unknown[]) => void) {
    this.events.on(event, listener);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void) {
    this.events.removeListener(event, listener);
    return this;
  }
}

describe("DesktopUpdater", () => {
  it("hard-rejects the v1 feed and accepts only the isolated v2 path", () => {
    expect(() =>
      assertIsolatedV2UpdateFeed(
        "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/desktop/current.json",
      ),
    ).toThrow(/Refusing non-v2 desktop update feed/);
    expect(
      assertIsolatedV2UpdateFeed("http://127.0.0.1:8123/desktop-v2/stable", {
        allowLoopback: true,
      }),
    ).toBe("http://127.0.0.1:8123/desktop-v2/stable");
  });

  it("checks, downloads, reports progress, and delegates restart-and-install", async () => {
    const client = new FakeUpdater();
    const states: string[] = [];
    const updater = new DesktopUpdater({
      client,
      currentVersion: "1.0.0",
      enabled: true,
      startupDelayMs: 60_000,
      checkIntervalMs: 60_000,
      onStateChanged: (snapshot) => states.push(snapshot.status),
    });
    updater.start();

    await updater.checkNow();
    expect(updater.getState()).toMatchObject({
      status: "available",
      currentVersion: "1.0.0",
      availableVersion: "1.0.1",
    });
    expect(client.setFeedURL).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "latest-v2",
        url: expect.stringContaining("/desktop-v2/stable"),
      }),
    );
    expect(client.autoDownload).toBe(false);
    expect(client.allowDowngrade).toBe(false);

    await updater.download();
    expect(updater.getState()).toMatchObject({
      status: "downloaded",
      downloadedVersion: "1.0.1",
      progress: { percent: 100, transferred: 424, total: 1_000 },
    });
    expect(states).toContain("downloading");

    expect(updater.restartAndInstall()).toEqual({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.quitAndInstall).toHaveBeenCalledWith(false, true);
    updater.dispose();
  });

  it("stays disabled in unpackaged development", async () => {
    const client = new FakeUpdater();
    const updater = new DesktopUpdater({
      client,
      currentVersion: "0.0.0",
      enabled: false,
    });
    updater.start();
    expect(await updater.checkNow()).toMatchObject({ status: "disabled" });
    expect(client.checkForUpdates).not.toHaveBeenCalled();
    expect(client.setFeedURL).not.toHaveBeenCalled();
  });
});
