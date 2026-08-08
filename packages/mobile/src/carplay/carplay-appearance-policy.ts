/**
 * Decision logic for deferring `Appearance.setColorScheme` while CarPlay is
 * (or is likely) connected. Pure — no react-native imports — so it stays unit
 * testable; the RN glue lives in ./carplay-appearance.
 *
 * Why this exists: RN's native `RCTAppearance.setColorScheme:` iterates
 * `UIApplication.connectedScenes` and calls `scene.windows` on every scene
 * with no class check (RCTAppearance.mm). A connected CarPlay head unit adds
 * a `CPTemplateApplicationScene`, which does not respond to `windows` →
 * uncaught NSException → SIGABRT that kills the whole app (build-96 field
 * crash: "-[CPTemplateApplicationScene windows]: unrecognized selector").
 *
 * The nasty case is a LAUNCH with the car already attached (including the
 * crash-relaunch loop): the theme store loads and applies before the CarPlay
 * JS session has received `didConnect`, so a live `isConnected()` check alone
 * misses it. We therefore also persist a "car was connected" flag in
 * NSUserDefaults (readable synchronously at next launch) and treat it as
 * connected for a grace window until the session confirms either way.
 */

/** How long a persisted connected-flag keeps deferring after JS start. */
export const CARPLAY_APPEARANCE_GRACE_MS = 20_000;

export type DeferColorSchemeArgs = {
  /** Live JS-session state: CarPlay confirmed connected right now. */
  connected: boolean;
  /** NSUserDefaults flag persisted by the last session's connect/disconnect. */
  persistedConnected: boolean;
  /** Milliseconds since this JS context started. */
  msSinceJsStart: number;
  graceMs?: number;
};

/** True when calling the native setColorScheme now risks the CarPlay crash. */
export function shouldDeferColorScheme({
  connected,
  persistedConnected,
  msSinceJsStart,
  graceMs = CARPLAY_APPEARANCE_GRACE_MS,
}: DeferColorSchemeArgs): boolean {
  if (connected) return true;
  // Launch race: last session said the car was attached and we haven't been
  // running long enough for the session to have confirmed a connect. Past the
  // grace window, treat the flag as stale (e.g. app was killed in the car
  // yesterday) and let the theme apply.
  return persistedConnected && msSinceJsStart < graceMs;
}
