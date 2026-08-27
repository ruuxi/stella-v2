import { useSyncExternalStore } from "react";
import { getElectronApi } from "@/platform/electron/electron";
import { isConnectRequestVisibleToSurface } from "@/features/chat/connector-connect-scope";

export type ConnectorConnectCardPhase =
  | "offer"
  | "connecting"
  | "connected"
  | "error";

export type ConnectorConnectCardRequest = {
  requestId: string;
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  category?: string;
  reason?: string;

  kind?: "integration" | "browser-extension";

  conversationId?: string;
  phase: ConnectorConnectCardPhase;
  message?: string;
};

let queue: ConnectorConnectCardRequest[] = [];
const listeners = new Set<() => void>();
let initialized = false;

const CONNECTED_LINGER_MS = 3500;
const ERROR_LINGER_MS = 7000;

const emitChange = () => {
  for (const listener of listeners) {
    listener();
  }
};

const removeRequest = (requestId: string) => {
  if (!queue.some((entry) => entry.requestId === requestId)) return;
  queue = queue.filter((entry) => entry.requestId !== requestId);
  emitChange();
};

const initialize = () => {
  if (initialized) return;
  initialized = true;
  const systemApi = getElectronApi()?.system;
  if (
    !systemApi?.onConnectorConnectRequest ||
    !systemApi.onConnectorConnectUpdate
  ) {
    return;
  }
  systemApi.onConnectorConnectRequest((_event, data) => {
    if (queue.some((entry) => entry.requestId === data.requestId)) return;
    queue = [...queue, { ...data, phase: "offer" }];
    emitChange();
  });
  systemApi.onConnectorConnectUpdate((_event, data) => {
    const entry = queue.find((item) => item.requestId === data.requestId);
    if (!entry) return;
    if (
      data.phase === "declined" ||
      data.phase === "cancelled" ||
      data.phase === "timeout"
    ) {

      removeRequest(data.requestId);
      return;
    }
    const phase: ConnectorConnectCardPhase =
      data.phase === "connecting"
        ? "connecting"
        : data.phase === "connected"
          ? "connected"
          : "error";
    queue = queue.map((item) =>
      item.requestId === data.requestId
        ? { ...item, phase, message: data.message }
        : item,
    );
    emitChange();
    if (data.phase === "connected" || data.phase === "error") {
      window.setTimeout(
        () => removeRequest(data.requestId),
        data.phase === "connected" ? CONNECTED_LINGER_MS : ERROR_LINGER_MS,
      );
    }
  });
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  initialize();
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => queue;

export const useConnectorConnectRequest = (
  conversationId?: string | null,
): ConnectorConnectCardRequest | null => {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    snapshot.find((entry) =>
      isConnectRequestVisibleToSurface(entry, conversationId),
    ) ?? null
  );
};

export const respondToConnectorConnect = (
  requestId: string,
  action: "accept" | "decline" | "cancel",
) => {
  void getElectronApi()?.system.respondConnectorConnect({ requestId, action });
};
