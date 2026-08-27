import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { getDeviceIdOrNull } from "@/platform/electron/device";

const DEVICE_ID_RETRY_LIMIT = 8;
const DEVICE_ID_RETRY_BASE_DELAY_MS = 2_000;

type AcknowledgeIntentArgs = Parameters<
  ReturnType<
    typeof useMutation<typeof api.mobile_access.acknowledgeConnectIntent>
  >
>[0];

type PhoneAccessState = {
  pairedDevices: Array<{ mobileDeviceId: string }>;
};

type BridgeRuntimeState = "unknown" | "started" | "stopped";

export function PhoneAccessBridge() {
  const { hasConnectedAccount } = useAuthSessionState();
  const acknowledgeIntent = useMutation(
    api.mobile_access.acknowledgeConnectIntent,
  );
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

  const phoneAccessState = useQuery(
    api.mobile_access.getPhoneAccessState,
    hasConnectedAccount && desktopDeviceId ? { desktopDeviceId } : "skip",
  ) as PhoneAccessState | undefined;

  const pairedDeviceCount = phoneAccessState?.pairedDevices.length;
  useEffect(() => {
    if (hasConnectedAccount && pairedDeviceCount === undefined) {

      return;
    }

    void requestBridgeState(
      hasConnectedAccount && (pairedDeviceCount ?? 0) > 0,
    ).catch((error) => {
      console.warn("[phone-access] Failed to reconcile bridge state:", error);
    });
  }, [hasConnectedAccount, pairedDeviceCount, requestBridgeState]);

  const intent = useQuery(
    api.mobile_access.watchIncomingConnectIntent,
    hasConnectedAccount && desktopDeviceId ? { desktopDeviceId } : "skip",
  ) as
    | {
        intentId: AcknowledgeIntentArgs["intentId"];
        mobileDeviceId: string;
        createdAt: number;
        expiresAt: number;
      }
    | null
    | undefined;
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
        await acknowledgeIntent({ intentId: intent.intentId });
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
  }, [acknowledgeIntent, intent, intentDeviceIsPaired, requestBridgeState]);

  return null;
}
