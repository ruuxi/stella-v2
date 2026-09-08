import { describe, expect, it } from "bun:test";
import {
  CLOUD_OFFLINE_NOTICE_DELAY_MS,
  cloudOfflineNoticeDueAt,
  idleCloudOfflineWindow,
  nextCloudOfflineWindow,
  shouldShowCloudOfflineNotice,
} from "@stella/contracts/cloud-connection-notice";

describe("cloud offline notice gate", () => {
  it("opens the window at the first offline and keeps it through retries", () => {
    let window = idleCloudOfflineWindow;
    window = nextCloudOfflineWindow(window, "live", 0);
    expect(window.since).toBeNull();
    window = nextCloudOfflineWindow(window, "offline", 1_000);
    expect(window.since).toBe(1_000);
    window = nextCloudOfflineWindow(window, "connecting", 1_250);
    window = nextCloudOfflineWindow(window, "offline", 1_800);
    expect(window.since).toBe(1_000);
  });

  it("closes the window on live, idle, or blocked", () => {
    const open = nextCloudOfflineWindow(idleCloudOfflineWindow, "offline", 5);
    for (const status of ["live", "idle", "blocked"] as const) {
      expect(nextCloudOfflineWindow(open, status, 10).since).toBeNull();
    }
  });

  it("never shows during a blip and shows only after the delay", () => {
    const open = nextCloudOfflineWindow(idleCloudOfflineWindow, "offline", 0);
    expect(shouldShowCloudOfflineNotice(open, "offline", 400)).toBe(false);
    expect(
      shouldShowCloudOfflineNotice(
        open,
        "offline",
        CLOUD_OFFLINE_NOTICE_DELAY_MS - 1,
      ),
    ).toBe(false);
    expect(
      shouldShowCloudOfflineNotice(
        open,
        "offline",
        CLOUD_OFFLINE_NOTICE_DELAY_MS,
      ),
    ).toBe(true);
    // Between retries the status is `connecting`; the banner waits for the
    // next `offline` rather than appearing mid-attempt.
    expect(
      shouldShowCloudOfflineNotice(
        open,
        "connecting",
        CLOUD_OFFLINE_NOTICE_DELAY_MS * 2,
      ),
    ).toBe(false);
    // A cold start that never went offline has no window at all.
    expect(
      shouldShowCloudOfflineNotice(
        idleCloudOfflineWindow,
        "connecting",
        CLOUD_OFFLINE_NOTICE_DELAY_MS * 2,
      ),
    ).toBe(false);
  });

  it("reports the due time only while offline", () => {
    const open = nextCloudOfflineWindow(idleCloudOfflineWindow, "offline", 100);
    expect(cloudOfflineNoticeDueAt(open, "offline")).toBe(
      100 + CLOUD_OFFLINE_NOTICE_DELAY_MS,
    );
    expect(cloudOfflineNoticeDueAt(open, "connecting")).toBeNull();
    expect(
      cloudOfflineNoticeDueAt(idleCloudOfflineWindow, "offline"),
    ).toBeNull();
  });
});
