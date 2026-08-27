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

const POST_DISCONNECT_DELAY_MS = 1500;

const jsStartedAt = Date.now();
type SettableScheme = ColorSchemeName | "unspecified";
let pendingScheme: SettableScheme | null = null;
let installed = false;

function applyNow(scheme: SettableScheme) {

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

  setTimeout(
    () => flushPending("launch grace elapsed"),
    CARPLAY_APPEARANCE_GRACE_MS + 500,
  );
}

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
