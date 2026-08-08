import * as SecureStore from "expo-secure-store";
import {
  deserializePersistedBridgeSession,
  serializePersistedBridgeSession,
  type PersistedBridgeSession,
} from "./bridge-session-codec";

const BRIDGE_SESSION_KEY_PREFIX = "stella-mobile_phone-access.bridge-session.";

const bridgeSessionKey = (desktopDeviceId: string) =>
  `${BRIDGE_SESSION_KEY_PREFIX}${desktopDeviceId}`;

export const savePersistedBridgeSession = async (
  desktopDeviceId: string,
  session: PersistedBridgeSession,
) => {
  try {
    await SecureStore.setItemAsync(
      bridgeSessionKey(desktopDeviceId),
      serializePersistedBridgeSession(session),
    );
  } catch {
    // Persistence is an optimization; the in-memory session still works.
  }
};

export const loadPersistedBridgeSession = async (
  desktopDeviceId: string,
): Promise<PersistedBridgeSession | null> => {
  try {
    const raw = await SecureStore.getItemAsync(
      bridgeSessionKey(desktopDeviceId),
    );
    return deserializePersistedBridgeSession(raw, Date.now());
  } catch {
    return null;
  }
};

/**
 * The last tunnel URL that worked, even if the session on it has expired —
 * hostnames are stable per desktop, so this seeds the parallel direct-probe
 * on reconnect (skipping the Convex status poll when the desktop is up).
 */
export const loadCachedBridgeBaseUrl = async (
  desktopDeviceId: string,
): Promise<string | null> => {
  try {
    const raw = await SecureStore.getItemAsync(
      bridgeSessionKey(desktopDeviceId),
    );
    if (!raw?.trim()) return null;
    const parsed = JSON.parse(raw) as { baseUrl?: unknown };
    return typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
      ? parsed.baseUrl.trim()
      : null;
  } catch {
    return null;
  }
};

export const clearPersistedBridgeSession = async (desktopDeviceId: string) => {
  try {
    await SecureStore.deleteItemAsync(bridgeSessionKey(desktopDeviceId));
  } catch {
    // best effort
  }
};
