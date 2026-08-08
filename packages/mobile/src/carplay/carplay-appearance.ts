/**
 * CarPlay-safe wrapper around `Appearance.setColorScheme`.
 *
 * RN's native `RCTAppearance.setColorScheme:` crashes the WHOLE app with an
 * uncaught NSException whenever a CarPlay scene is connected
 * ("-[CPTemplateApplicationScene windows]: unrecognized selector" — it
 * iterates `connectedScenes` assuming every scene is a UIWindowScene). That
 * was the build-96 field crash: app launches with the car attached, the
 * stored theme finishes loading, `setColorScheme` fires → SIGABRT →
 * relaunch → loop.
 *
 * While CarPlay is (or is likely) connected we park the requested scheme and
 * apply it after the car disconnects (with a small delay so the CarPlay scene
 * has actually left `connectedScenes`), or after the launch grace window if
 * the persisted connected-flag turns out to be stale. Cosmetic tradeoff:
 * native chrome (keyboard, popovers, glass) may lag the JS theme while
 * driving — vastly better than a crash loop in the car.
 *
 * The real fix is the react-native patch guarding the scene class in
 * RCTAppearance.mm, but that is native code and needs a new binary; this
 * wrapper is pure JS so it can ride an expo-updates OTA to existing builds.
 */

import { Appearance, type ColorSchemeName } from "react-native";
import {
  CARPLAY_APPEARANCE_GRACE_MS,
  shouldDeferColorScheme,
} from "./carplay-appearance-policy";
import {
  carPlayLog,
  carPlaySession,
  readPersistedCarPlayConnected,
} from "./carplay-session";

/** Delay after disconnect before touching UIKit — lets the CPTemplate scene
 * actually leave `connectedScenes` before setColorScheme walks it. */
const POST_DISCONNECT_DELAY_MS = 1500;

const jsStartedAt = Date.now();
type SettableScheme = ColorSchemeName | "unspecified";
let pendingScheme: SettableScheme | null = null;
let installed = false;

function applyNow(scheme: SettableScheme) {
  // RN types setColorScheme as accepting ColorSchemeName; "unspecified" is the
  // documented native value for clearing the override.
  Appearance.setColorScheme(scheme as ColorSchemeName);
}

function flushPending(reason: string) {
  if (pendingScheme == null) return;
  if (
    shouldDeferColorScheme({
      connected: carPlaySession.isConnected(),
      persistedConnected: readPersistedCarPlayConnected(),
      msSinceJsStart: Date.now() - jsStartedAt,
    })
  ) {
    return;
  }
  const scheme = pendingScheme;
  pendingScheme = null;
  carPlayLog(`applying deferred color scheme '${String(scheme)}' (${reason})`);
  applyNow(scheme);
}

function ensureInstalled() {
  if (installed) return;
  installed = true;
  carPlaySession.onConnectionChange((connected) => {
    if (connected) return;
    setTimeout(() => flushPending("carplay disconnected"), POST_DISCONNECT_DELAY_MS);
  });
  // Stale-flag fallback: if the persisted flag said "connected" but no head
  // unit confirms within the grace window, apply anyway.
  setTimeout(
    () => flushPending("launch grace elapsed"),
    CARPLAY_APPEARANCE_GRACE_MS + 500,
  );
}

/**
 * Drop-in replacement for `Appearance.setColorScheme` that never runs the
 * crashing native path while a CarPlay scene is (or is likely) attached.
 */
export function setColorSchemeSafely(scheme: SettableScheme) {
  const defer = shouldDeferColorScheme({
    connected: carPlaySession.isConnected(),
    persistedConnected: readPersistedCarPlayConnected(),
    msSinceJsStart: Date.now() - jsStartedAt,
  });
  if (!defer) {
    pendingScheme = null;
    applyNow(scheme);
    return;
  }
  carPlayLog(
    `deferring Appearance.setColorScheme('${String(scheme)}') — CarPlay scene connected/likely`,
  );
  pendingScheme = scheme;
  ensureInstalled();
}
