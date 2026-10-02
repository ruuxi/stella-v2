import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { backendClient } from "@/platform/backend/backend-client";
import { useBackendView } from "@/platform/backend/use-backend-view";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { getOrCreateDeviceId } from "@/platform/electron/device";

type UsePhoneAccessControllerOptions = {
  qrCodeWidth?: number;
};

const DEFAULT_QR_CODE_WIDTH = 160;
const PHONE_ACCESS_PREPARE_ERROR =
  "Unable to prepare phone access on this desktop.";

export function usePhoneAccessController(
  options: UsePhoneAccessControllerOptions = {},
) {
  const { qrCodeWidth = DEFAULT_QR_CODE_WIDTH } = options;
  const { hasConnectedAccount } = useAuthSessionState();
  const [desktopDeviceId, setDesktopDeviceId] = useState<string | null>(null);
  const [deviceLoadError, setDeviceLoadError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [removingMobileDeviceId, setRemovingMobileDeviceId] = useState<
    string | null
  >(null);
  const [now, setNow] = useState(() => Date.now());
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const phoneAccessState = useBackendView(
    "phone.access",
    hasConnectedAccount && desktopDeviceId ? { desktopDeviceId } : "skip",
  ).value;

  useEffect(() => {
    if (!hasConnectedAccount) {
      setDesktopDeviceId(null);
      setDeviceLoadError(null);
      return;
    }

    let cancelled = false;
    const loadDeviceId = async () => {
      try {
        const nextDeviceId = await getOrCreateDeviceId();
        if (!cancelled) {
          setDesktopDeviceId(nextDeviceId ?? null);
          setDeviceLoadError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setDeviceLoadError(
            nextError instanceof Error
              ? nextError.message
              : PHONE_ACCESS_PREPARE_ERROR,
          );
        }
      }
    };

    void loadDeviceId();
    return () => {
      cancelled = true;
    };
  }, [hasConnectedAccount]);

  const hasActivePairing = Boolean(phoneAccessState?.activePairing);
  useEffect(() => {
    if (!hasActivePairing) {
      return;
    }
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasActivePairing]);

  const activePairing = useMemo(() => {
    const pairing = phoneAccessState?.activePairing ?? null;
    if (!pairing || pairing.expiresAt <= now) {
      return null;
    }
    return pairing;
  }, [now, phoneAccessState?.activePairing]);

  const pairingLink = useMemo(
    () =>
      activePairing
        ? `stella-mobile://stella?code=${encodeURIComponent(activePairing.pairingCode)}`
        : null,
    [activePairing],
  );

  useEffect(() => {
    if (!pairingLink) {
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(pairingLink, {
      width: qrCodeWidth,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) {
          setQrDataUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrDataUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [pairingLink, qrCodeWidth]);

  const createPairing = useCallback(async (): Promise<boolean> => {
    if (!desktopDeviceId || isCreating) {
      return false;
    }
    setIsCreating(true);
    try {
      await backendClient.call("phone.createPairing", { desktopDeviceId });
      return true;
    } finally {
      setIsCreating(false);
    }
  }, [desktopDeviceId, isCreating]);

  const removePhone = useCallback(
    async (mobileDeviceId: string): Promise<boolean> => {
      if (!desktopDeviceId || removingMobileDeviceId) {
        return false;
      }
      setRemovingMobileDeviceId(mobileDeviceId);
      try {
        await backendClient.call("phone.revoke", {
          desktopDeviceId,
          mobileDeviceId,
        });
        return true;
      } finally {
        setRemovingMobileDeviceId(null);
      }
    },
    [desktopDeviceId, removingMobileDeviceId],
  );

  return {
    hasConnectedAccount,
    desktopDeviceId,
    deviceLoadError,
    activePairing,
    pairingLink,
    qrDataUrl,
    pairedDevices: phoneAccessState?.pairedDevices ?? [],
    isCreating,
    removingMobileDeviceId,
    createPairing,
    removePhone,
  };
}
