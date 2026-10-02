import { useCallback, useEffect, useRef, useState } from "react";
import { backendClient } from "@/platform/backend/backend-client";
import { useBackendView } from "@/platform/backend/use-backend-view";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { getDeviceIdOrNull } from "@/platform/electron/device";

const DEVICE_ID_RETRY_LIMIT = 8;
const DEVICE_ID_RETRY_BASE_DELAY_MS = 2_000;

type BridgeRuntimeState = "unknown" | "started" | "stopped";

export function PhoneAccessBridge() {
  const { hasConnectedAccount } = useAuthSessionState();
  const [desktopDeviceId, setDesktopDeviceId] = useState<string | null>(null);
  const lastHandledIntentKeyRef = useRef<string | null>(null);
  const desiredBridgeStateRef = useRef<boolean | null>(null);
  const bridgeRuntimeStateRef = useRef<BridgeRuntimeState>("unknown");
  const bridgeReconcilePromiseRef = useRef<Promise<void> | null>(null);

  const reconcileBridgeState = useCallback(() => {
    if (bridgeReconcilePromiseRef.current) {
      return bridgeReconcilePromiseRef.current;
    }

    const reconcilePromise = Promise.resolve().then(async () => {
      while (desiredBridgeStateRef.current !== null) {
        const shouldRun = desiredBridgeStateRef.current;
        const currentState = bridgeRuntimeStateRef.current;
        if (
          (shouldRun && currentState === "started") ||
          (!shouldRun && currentState === "stopped")
        ) {
          return;
        }

        const systemApi = window.electronAPI?.system;
        if (shouldRun) {
          if (!systemApi?.startPhoneAccessSession) {
            return;
          }
          await systemApi.startPhoneAccessSession();
          bridgeRuntimeStateRef.current = "started";
        } else {
          if (!systemApi?.stopPhoneAccessSession) {
            return;
          }
          await systemApi.stopPhoneAccessSession();
          bridgeRuntimeStateRef.current = "stopped";
        }
      }
    });

    bridgeReconcilePromiseRef.current = reconcilePromise;
    const clearReconcilePromise = () => {
      if (bridgeReconcilePromiseRef.current === reconcilePromise) {
        bridgeReconcilePromiseRef.current = null;
      }
    };
    void reconcilePromise.then(clearReconcilePromise, clearReconcilePromise);
    return reconcilePromise;
  }, []);

  const requestBridgeState = useCallback(
    async (shouldRun: boolean) => {
      desiredBridgeStateRef.current = shouldRun;
      await reconcileBridgeState();
      return bridgeRuntimeStateRef.current ===
        (shouldRun ? "started" : "stopped");
    },
    [reconcileBridgeState],
  );

  useEffect(() => {
    if (!hasConnectedAccount) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    let attempts = 0;

    const loadDeviceId = async () => {
      if (cancelled || attempts >= DEVICE_ID_RETRY_LIMIT) {
        return;
      }
      attempts += 1;

      try {
        const nextDeviceId = await getDeviceIdOrNull();
        if (cancelled) {
          return;
        }
        if (nextDeviceId) {
          setDesktopDeviceId(nextDeviceId);
          return;
        }
      } catch (error) {
        if (!cancelled && attempts >= DEVICE_ID_RETRY_LIMIT) {
          console.warn(
            "[phone-access] Failed to load desktop device id:",
            error,
          );
        }
      }

      if (!cancelled && attempts < DEVICE_ID_RETRY_LIMIT) {
        timeoutId = window.setTimeout(() => {
          void loadDeviceId();
        }, DEVICE_ID_RETRY_BASE_DELAY_MS * attempts);
      }
    };

    void loadDeviceId();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [hasConnectedAccount]);

  const phoneAccessState = useBackendView(
    "phone.access",
    hasConnectedAccount && desktopDeviceId ? { desktopDeviceId } : "skip",
  ).value;

  const pairedDeviceCount = phoneAccessState?.pairedDevices.length;
  useEffect(() => {
    if (hasConnectedAccount && pairedDeviceCount === undefined) {
      // Do not tear down a retained bridge while the authoritative pairing
      // subscription is still loading.
      return;
    }

    void requestBridgeState(
      hasConnectedAccount && (pairedDeviceCount ?? 0) > 0,
    ).catch((error) => {
      console.warn("[phone-access] Failed to reconcile bridge state:", error);
    });
  }, [hasConnectedAccount, pairedDeviceCount, requestBridgeState]);

  // The view returns `expiresAt`; expiry is checked client-side below.
  const intent = useBackendView(
    "phone.connectIntent",
    hasConnectedAccount && desktopDeviceId ? { desktopDeviceId } : "skip",
  ).value;
  const intentDeviceIsPaired =
    phoneAccessState?.pairedDevices.some(
      (device) => device.mobileDeviceId === intent?.mobileDeviceId,
    ) ?? false;

  useEffect(() => {
    if (
      !intent?.intentId ||
      !intentDeviceIsPaired ||
      !window.electronAPI?.system.startPhoneAccessSession
    ) {
      return;
    }
    // Gate on the backend-provided expiry instead of passing a client clock
    // into the query: ignore intents that have already lapsed.
    if (
      typeof intent.expiresAt === "number" &&
      Date.now() > intent.expiresAt
    ) {
      return;
    }
    const intentKey = `${intent.intentId}:${intent.createdAt}`;
    if (lastHandledIntentKeyRef.current === intentKey) {
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        const started = await requestBridgeState(true);
        if (!started) {
          return;
        }
        await backendClient.call("phone.acknowledgeIntent", {
          intentId: intent.intentId,
        });
        if (!cancelled) {
          lastHandledIntentKeyRef.current = intentKey;
        }
      } catch (error) {
        console.warn("[phone-access] Failed to activate session:", error);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [intent, intentDeviceIsPaired, requestBridgeState]);

  return null;
}
