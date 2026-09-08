/**
 * Gate for the transcript "reconnecting" notice on desktop and mobile.
 *
 * Every socket close passes through `offline` before the automatic reconnect,
 * so mirroring the raw status paints a banner for the few hundred milliseconds
 * of each foreground return or network blip and shifts the whole transcript
 * with it. The notice only carries information once the socket has stayed
 * unhealthy long enough that the backoff has visibly failed.
 *
 * The window opens at the first `offline`, survives the `connecting` attempts
 * between retries, and closes as soon as the socket is `live` again. `idle`
 * and `blocked` close it too: teardown is not an outage, and a blocked socket
 * has its own immediate notice.
 */
export type CloudSocketStatus =
  | "idle"
  | "connecting"
  | "live"
  | "offline"
  | "blocked";

/** Continuous offline time before the notice may appear. */
export const CLOUD_OFFLINE_NOTICE_DELAY_MS = 5_000;

export type CloudOfflineWindow = {
  /** When the current unhealthy stretch began, or null while healthy. */
  since: number | null;
};

export const idleCloudOfflineWindow: CloudOfflineWindow = { since: null };

export function nextCloudOfflineWindow(
  window: CloudOfflineWindow,
  status: CloudSocketStatus,
  nowMs: number,
): CloudOfflineWindow {
  if (status === "offline") {
    return window.since === null ? { since: nowMs } : window;
  }
  if (status === "connecting") return window;
  return window.since === null ? window : idleCloudOfflineWindow;
}

export function shouldShowCloudOfflineNotice(
  window: CloudOfflineWindow,
  status: CloudSocketStatus,
  nowMs: number,
  delayMs: number = CLOUD_OFFLINE_NOTICE_DELAY_MS,
): boolean {
  return (
    status === "offline" &&
    window.since !== null &&
    nowMs - window.since >= delayMs
  );
}

/** Absolute time the notice becomes due, or null when nothing is pending. */
export function cloudOfflineNoticeDueAt(
  window: CloudOfflineWindow,
  status: CloudSocketStatus,
  delayMs: number = CLOUD_OFFLINE_NOTICE_DELAY_MS,
): number | null {
  return status === "offline" && window.since !== null
    ? window.since + delayMs
    : null;
}
