import { useSyncExternalStore } from "react";
import type { LinkWalletCardView } from "@stella/contracts/link-wallet";
import { getElectronApi } from "@/platform/electron/electron";
import { isConnectRequestVisibleToSurface } from "@/features/chat/connector-connect-scope";

let queue: LinkWalletCardView[] = [];
const listeners = new Set<() => void>();
let initialized = false;

const CONNECTED_LINGER_MS = 3500;
const ERROR_LINGER_MS = 7000;
const APPROVAL_LINGER_MS = 12_000;

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

const isDismissReason = (message: string | undefined): boolean =>
  message === "declined" || message === "cancelled" || message === "timeout";

const initialize = () => {
  if (initialized) return;
  initialized = true;
  const systemApi = getElectronApi()?.system;
  if (!systemApi?.onLinkWalletCard) return;
  systemApi.onLinkWalletCard((_event, data) => {
    if (data.phase === "error" && isDismissReason(data.message)) {
      removeRequest(data.requestId);
      return;
    }
    const existing = queue.find((entry) => entry.requestId === data.requestId);
    if (existing) {
      queue = queue.map((entry) =>
        entry.requestId === data.requestId ? data : entry,
      );
    } else {
      queue = [...queue, data];
    }
    emitChange();
    if (data.phase === "connected" || data.phase === "error") {
      window.setTimeout(
        () => removeRequest(data.requestId),
        data.phase === "connected" ? CONNECTED_LINGER_MS : ERROR_LINGER_MS,
      );
    }
    if (data.phase === "awaiting_approval") {
      window.setTimeout(
        () => removeRequest(data.requestId),
        APPROVAL_LINGER_MS,
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

export const useLinkWalletCard = (
  conversationId?: string | null,
): LinkWalletCardView | null => {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    snapshot.find((entry) =>
      isConnectRequestVisibleToSurface(entry, conversationId),
    ) ?? null
  );
};

export const respondToLinkWallet = (
  requestId: string,
  action: "accept" | "decline" | "cancel",
) => {
  void getElectronApi()?.system.respondLinkWallet({ requestId, action });
};
