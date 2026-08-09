import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { ConnectHeroAnimation } from "@/global/integrations/ConnectHeroAnimation";
import { usePhoneAccessController } from "@/global/settings/hooks/use-phone-access-controller";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { useT, useTPlural } from "@/shared/i18n";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const APP_STORE_URL =
  "https://apps.apple.com/us/app/stella-your-ai/id6761148311";

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const formatCountdown = (expiresAt: number, t: Translate) => {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) {
    return t("settings.phoneAccess.expired");
  }
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return t("settings.phoneAccess.timeLeft", {
    time: `${minutes}:${String(seconds).padStart(2, "0")}`,
  });
};

export function PhoneAccessConnectCard() {
  const t = useT();
  const tPlural = useTPlural();
  const {
    hasConnectedAccount,
    desktopDeviceId,
    deviceLoadError,
    activePairing,
    qrDataUrl,
    pairedDevices,
    isCreating,
    removingMobileDeviceId,
    createPairing,
    removePhone,
  } = usePhoneAccessController({ qrCodeWidth: 140 });
  const [error, setError] = useState<string | null>(null);
  const visibleError = error ?? deviceLoadError;
  const [appStoreQrDataUrl, setAppStoreQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(APP_STORE_URL, {
      width: 140,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setAppStoreQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setAppStoreQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreate = useCallback(async () => {
    setError(null);
    try {
      await createPairing();
    } catch (e) {
      setError(toErrorMessage(e, t("settings.phoneAccess.errors.createPairing")));
    }
  }, [createPairing, t]);

  const handleCopy = useCallback(() => {
    if (activePairing) {
      void navigator.clipboard.writeText(activePairing.pairingCode);
      showToast(t("settings.phoneAccess.toasts.codeCopied"));
    }
  }, [activePairing, t]);

  const handleRemovePhone = useCallback(async (mobileDeviceId: string) => {
    try {
      const didRemove = await removePhone(mobileDeviceId);
      if (didRemove) {
        showToast(t("settings.phoneAccess.toasts.phoneRemoved"));
      }
    } catch {
      showToast(t("settings.phoneAccess.toasts.removeFailed"));
    }
  }, [removePhone, t]);

  if (!hasConnectedAccount) {
    return (
      <div className="connect-detail-area">
        <div className="connect-detail-body connect-pair-centered">
          <ConnectHeroAnimation />
          <p className="connect-pair-headline">
            {t("settings.phoneAccess.signedOut.headline")}
          </p>
          <p className="connect-pair-sub">
            {t("settings.phoneAccess.signedOut.body")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="connect-detail-area">
      <div className="connect-detail-body connect-pair-centered">
        <ConnectHeroAnimation />
        {activePairing ? (
          <>
            <p className="connect-pair-headline">
              {t("settings.phoneAccess.pairing.headline")}
            </p>
            <p className="connect-pair-sub">
              {t("settings.phoneAccess.pairing.body")}
            </p>

            {visibleError && <div className="connect-error">{visibleError}</div>}

            <div className="connect-pair-qr-block">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={t("settings.phoneAccess.pairing.qrAlt")}
                  className="connect-pair-qr"
                />
              ) : (
                <div className="connect-skeleton connect-pair-qr" />
              )}
            </div>

            <div className="connect-pair-code-group">
              <span className="connect-pair-code">{activePairing.pairingCode}</span>
              <Button variant="ghost" size="small" onClick={handleCopy}>
                {t("settings.phoneAccess.copy")}
              </Button>
            </div>

            <span className="connect-pair-timer">
              {formatCountdown(activePairing.expiresAt, t)}
            </span>
          </>
        ) : (
          <>
            <p className="connect-pair-headline">
              {t("settings.phoneAccess.intro.headline")}
            </p>

            <ol className="connect-pair-steps">
              <li className="connect-pair-step">
                <p className="connect-pair-step-title">
                  <span className="connect-pair-step-num">1.</span>
                  {t("settings.phoneAccess.steps.download")}
                </p>
                <div className="connect-pair-step-visual">
                  <div className="connect-pair-qr-block">
                    {appStoreQrDataUrl ? (
                      <img
                        src={appStoreQrDataUrl}
                        alt={t("settings.phoneAccess.steps.downloadQrAlt")}
                        className="connect-pair-qr"
                      />
                    ) : (
                      <div className="connect-skeleton connect-pair-qr" />
                    )}
                  </div>
                </div>
              </li>

              <li className="connect-pair-step">
                <p className="connect-pair-step-title">
                  <span className="connect-pair-step-num">2.</span>
                  {t("settings.phoneAccess.steps.connect")}
                </p>
                <div className="connect-pair-step-visual">
                  <Button
                    variant="ghost"
                    onClick={() => void handleCreate()}
                    disabled={!desktopDeviceId || isCreating}
                    style={{
                      fontFamily: "var(--font-family-display)",
                      fontSize: 24,
                      fontWeight: 500,
                      letterSpacing: "0.01em",
                      padding: "10px 24px",
                      height: "auto",
                      textDecoration: "underline",
                      textUnderlineOffset: "4px",
                    }}
                  >
                    {isCreating
                      ? t("settings.phoneAccess.preparing")
                      : t("settings.phoneAccess.getCode")}
                  </Button>
                </div>
              </li>
            </ol>

            {visibleError && <div className="connect-error">{visibleError}</div>}
          </>
        )}

        {pairedDevices.length > 0 && (
          <div className="connect-paired-devices">
            <span className="connect-pair-meta">
              {tPlural(
                "settings.phoneAccess.pairedCount",
                pairedDevices.length,
              )}
            </span>
            {pairedDevices.map((device) => (
              <div key={device.mobileDeviceId} className="connect-paired-device">
                <span className="connect-paired-device-name">
                  {device.displayName?.trim() || t("settings.phoneAccess.deviceFallback")}
                </span>
                <button
                  type="button"
                  className="connect-bot-link"
                  onClick={() => void handleRemovePhone(device.mobileDeviceId)}
                  disabled={removingMobileDeviceId === device.mobileDeviceId}
                >
                  {removingMobileDeviceId === device.mobileDeviceId
                    ? t("settings.phoneAccess.removing")
                    : t("settings.phoneAccess.remove")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
