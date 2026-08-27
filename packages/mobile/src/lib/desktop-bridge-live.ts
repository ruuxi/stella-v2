import { AppState, type AppStateStatus } from "react-native";
import {
  bridgeSupportsLocalChatPush,
  clearCachedDesktopBridge,
  openDesktopBridgeEventSocket,
  parseDesktopTaskDecoration,
  resolveDesktopBridge,
  type DesktopTaskDecoration,
} from "./desktop-bridge-chat";
import type { StoredPhoneAccess } from "./phone-access";

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

const UNSUPPORTED_RECHECK_MS = 10 * 60_000;

export type DesktopBridgeLiveHandle = {
  close: () => void;
};

export type DesktopBridgeLiveConnectionDetails = {

  reconnected: boolean;

  foregroundResume: boolean;
};

export type DesktopLocalChatUpdatedPayload = {
  conversationId?: string;
  event?: {
    _id?: string;
    timestamp?: number;
    type?: string;
  };
};

export function openDesktopBridgeLive(options: {
  access: StoredPhoneAccess;
  onLocalChatUpdated: (payload: DesktopLocalChatUpdatedPayload) => void;
  onConnectedChange: (
    connected: boolean,
    details: DesktopBridgeLiveConnectionDetails,
  ) => void;

  onThreadActivityUpdated?: (payload: { conversationId?: string }) => void;

  onTaskDecorationUpdated?: (decoration: DesktopTaskDecoration) => void;
}): DesktopBridgeLiveHandle {
  let closed = false;
  let attempt = 0;
  let socket: { close: () => void } | null = null;
  let connecting = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let unsupportedUntil = 0;
  let connected = false;
  let hasConnectedOnce = false;
  let foregroundResumePending = false;
  const isBackgrounded = () =>
    AppState.currentState === "background" ||
    AppState.currentState === "inactive";

  const setConnected = (next: boolean) => {
    if (connected === next) return;
    connected = next;
    const reconnected = next && hasConnectedOnce;
    if (next) hasConnectedOnce = true;
    const foregroundResume = reconnected && foregroundResumePending;
    if (next) foregroundResumePending = false;
    options.onConnectedChange(next, { reconnected, foregroundResume });
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

    if (isBackgrounded()) return;
    if (Date.now() < unsupportedUntil) return;
    connecting = true;
    try {
      const bridge = await resolveDesktopBridge(options.access);
      if (!bridgeSupportsLocalChatPush(bridge)) {

        unsupportedUntil = Date.now() + UNSUPPORTED_RECHECK_MS;
        return;
      }
      if (closed || socket) return;
      let opened: { close: () => void } | null = null;
      opened = await openDesktopBridgeEventSocket(bridge, {
        channels: [
          "localChat:updated",
          ...(options.onThreadActivityUpdated
            ? ["localChat:threadActivityUpdated"]
            : []),
          ...(options.onTaskDecorationUpdated
            ? ["localChat:taskDecorationUpdated"]
            : []),
        ],
        onEvent: (channel, data) => {
          if (channel === "localChat:updated") {
            const raw = data as {
              conversationId?: unknown;
              event?: { _id?: unknown; timestamp?: unknown; type?: unknown };
            } | null;
            const event = raw?.event;
            options.onLocalChatUpdated({
              ...(typeof raw?.conversationId === "string"
                ? { conversationId: raw.conversationId }
                : {}),
              ...(event
                ? {
                    event: {
                      ...(typeof event._id === "string"
                        ? { _id: event._id }
                        : {}),
                      ...(typeof event.timestamp === "number"
                        ? { timestamp: event.timestamp }
                        : {}),
                      ...(typeof event.type === "string"
                        ? { type: event.type }
                        : {}),
                    },
                  }
                : {}),
            });
            return;
          }
          if (channel === "localChat:threadActivityUpdated") {
            const conversationId =
              data && typeof data === "object" && "conversationId" in data
                ? String(
                    (data as { conversationId?: unknown }).conversationId ?? "",
                  ).trim()
                : "";
            options.onThreadActivityUpdated?.(
              conversationId ? { conversationId } : {},
            );
            return;
          }
          if (channel === "localChat:taskDecorationUpdated") {
            options.onTaskDecorationUpdated?.(parseDesktopTaskDecoration(data));
          }
        },
        onClose: (details) => {

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

      if (hasConnectedOnce) foregroundResumePending = true;
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
