import { useAction } from "convex/react";
import { useEffect, useRef } from "react";
import { parseLinkSpendUsd } from "@stella/contracts/link-wallet";
import { api } from "@/convex/api";
import { getElectronApi } from "@/platform/electron/electron";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";

export function MobileWalletSpendNotificationsBridge() {
  const { hasConnectedAccount } = useAuthSessionState();
  const sendWalletSpendNotification = useAction(
    api.mobile_push.sendWalletSpendNotification,
  );
  const sentRef = useRef(new Set<string>());

  useEffect(() => {
    if (!hasConnectedAccount) {
      sentRef.current.clear();
      return;
    }
    const systemApi = getElectronApi()?.system;
    if (!systemApi?.onLinkWalletCard) return;
    return systemApi.onLinkWalletCard((_event, data) => {
      if (data.phase !== "awaiting_approval") return;
      if (sentRef.current.has(data.requestId)) return;
      sentRef.current.add(data.requestId);
      const amountCents = data.amountLabel
        ? parseLinkSpendUsd(data.amountLabel)
        : undefined;
      void sendWalletSpendNotification({
        merchantName: data.merchantName?.trim() || "a merchant",
        amountCents: amountCents ?? 0,
      }).catch((error: unknown) => {
        console.warn("[mobile-wallet] Failed to send spend notification:", error);
      });
    });
  }, [hasConnectedAccount, sendWalletSpendNotification]);

  return null;
}
