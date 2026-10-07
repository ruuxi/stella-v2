/**
 * The static launch splash (`#stella-launch` in `index.html`) covers the
 * window from the first paint until the shell is ready to be looked at.
 *
 * "Ready" deliberately means *live*, not merely mounted: the shell mounts a
 * few hundred milliseconds before auth resolves and the active conversation
 * is selected, and revealing it early lets the user watch the composer
 * enable and the conversation list fill in. Holding the splash until the
 * root layout reports liveness turns that into a single reveal.
 *
 * Liveness can be slow or never arrive (offline, a first-ever install that
 * has to create its anonymous account over the network), so the hold is
 * bounded: after `LAUNCH_SPLASH_MAX_HOLD_MS` the splash drops regardless and
 * the shell shows in whatever state it is in.
 */

const LAUNCH_SPLASH_ID = "stella-launch";

/** Matches the `opacity` transition on `.stella-launch` in `index.html`. */
const LAUNCH_SPLASH_EXIT_MS = 260;

/**
 * Upper bound on how long the shell may stay hidden behind the splash while
 * waiting for liveness. A returning user on a normal connection reaches a
 * selected conversation in roughly 1.3s from first paint, so this only fires
 * on cold first installs (anonymous sign-up is a network round-trip), offline
 * starts, or a slow network.
 */
export const LAUNCH_SPLASH_MAX_HOLD_MS = 2_000;

let dismissed = false;
let holdTimer: number | null = null;

const clearHoldTimer = () => {
  if (holdTimer === null) return;
  window.clearTimeout(holdTimer);
  holdTimer = null;
};

/**
 * Fade the splash out and remove it. Idempotent: every later call is a
 * no-op, so any number of "the shell is live" signals may race freely.
 */
export function dismissLaunchSplash(): void {
  clearHoldTimer();
  if (dismissed) return;
  dismissed = true;
  const launch = document.getElementById(LAUNCH_SPLASH_ID);
  if (!launch) return;
  launch.dataset.exiting = "true";
  window.setTimeout(() => {
    launch.remove();
  }, LAUNCH_SPLASH_EXIT_MS);
}

/**
 * Keep the splash up until `dismissLaunchSplash()` is called by whoever
 * knows the shell is live, but never longer than the bounded hold. Call once
 * when the real shell mounts; extra calls do not extend the deadline.
 */
export function holdLaunchSplashUntilLive(): void {
  if (dismissed || holdTimer !== null) return;
  holdTimer = window.setTimeout(() => {
    holdTimer = null;
    dismissLaunchSplash();
  }, LAUNCH_SPLASH_MAX_HOLD_MS);
}

/** Test-only: reset module state between cases. */
export function resetLaunchSplashForTests(): void {
  clearHoldTimer();
  dismissed = false;
}
