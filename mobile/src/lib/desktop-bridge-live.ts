import { AppState, type AppStateStatus } from "react-native";
import {
  bridgeSupportsLocalChatPush,
  clearCachedDesktopBridge,
  openDesktopBridgeEventSocket,
  resolveDesktopBridge,
} from "./desktop-bridge-chat";
import type { StoredPhoneAccess } from "./phone-access";

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** How long an unsupported desktop stays demoted before we re-check. */
const UNSUPPORTED_RECHECK_MS = 10 * 60_000;

export type DesktopBridgeLiveHandle = {
  close: () => void;
};

/**
 * Foreground-only push channel for transcript changes. Holds one WebSocket
 * subscribed to `localChat:updated` (the desktop broadcasts it on every
 * persisted chat event) and reports connection state so callers can suspend
 * their polling fallbacks while push is live.
 *
 * Capability-gated: only desktops that advertise `localchat-push` via
 * `mobile:hello` get a socket; against older desktops the handle stays
 * dormant (callers keep polling). Auto-reconnects with backoff while open,
 * closes in the background and reconnects on foreground.
 */
export function openDesktopBridgeLive(options: {
  access: StoredPhoneAccess;
  onLocalChatUpdated: () => void;
  onConnectedChange: (connected: boolean) => void;
}): DesktopBridgeLiveHandle {
  let closed = false;
  let attempt = 0;
  let socket: { close: () => void } | null = null;
  let connecting = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let unsupportedUntil = 0;
  let connected = false;
  const isBackgrounded = () =>
    AppState.currentState === "background" ||
    AppState.currentState === "inactive";

  const setConnected = (next: boolean) => {
    if (connected === next) return;
    connected = next;
    options.onConnectedChange(next);
  };

  const scheduleReconnect = () => {
    if (closed || retryTimer || isBackgrounded()) return;
    attempt += 1;
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 5),
    );
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  const connect = async () => {
    if (closed || connecting || socket) return;
    // "unknown" (cold launch) counts as foreground; only explicit
    // background/inactive states block connecting.
    if (isBackgrounded()) return;
    if (Date.now() < unsupportedUntil) return;
    connecting = true;
    try {
      const bridge = await resolveDesktopBridge(options.access);
      if (!bridgeSupportsLocalChatPush(bridge)) {
        // Older desktop — stay dormant (callers keep their polling fallback).
        // Foreground transitions re-attempt, so a desktop upgraded
        // mid-session is picked up after the recheck window.
        unsupportedUntil = Date.now() + UNSUPPORTED_RECHECK_MS;
        return;
      }
      if (closed || socket) return;
      let opened: { close: () => void } | null = null;
      opened = await openDesktopBridgeEventSocket(bridge, {
        channels: ["localChat:updated"],
        onEvent: (channel) => {
          if (channel === "localChat:updated") {
            options.onLocalChatUpdated();
          }
        },
        onClose: (details) => {
          // Only react if this socket is still the live one — a superseded
          // or deliberately dropped socket must not clobber shared state.
          if (socket !== opened) return;
          socket = null;
          setConnected(false);
          if (details.code === 4001) {
            clearCachedDesktopBridge(options.access.desktopDeviceId, {
              keepPersisted: true,
            });
          }
          scheduleReconnect();
        },
      });
      if (closed || socket || isBackgrounded()) {
        opened.close();
        return;
      }
      socket = opened;
      attempt = 0;
      setConnected(true);
    } catch {
      // The socket itself is the liveness probe. A failed open invalidates the
      // in-memory route so the next bounded retry performs discovery once.
      clearCachedDesktopBridge(options.access.desktopDeviceId, {
        keepPersisted: true,
      });
      setConnected(false);
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  };

  const appStateSubscription = AppState.addEventListener(
    "change",
    (next: AppStateStatus) => {
      if (closed) return;
      if (next === "active") {
        attempt = 0;
        void connect();
        return;
      }
      // Background/inactive: drop the socket — iOS will kill it anyway, and a
      // deliberate close gives us a clean reconnect on return.
      if (socket) {
        const current = socket;
        socket = null;
        current.close();
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      setConnected(false);
    },
  );

  void connect();

  return {
    close: () => {
      closed = true;
      appStateSubscription.remove();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (socket) {
        const current = socket;
        socket = null;
        current.close();
      }
      setConnected(false);
    },
  };
}
