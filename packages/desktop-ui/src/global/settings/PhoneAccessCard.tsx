import { type SVGProps, useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { ConnectHeroAnimation } from "@/global/integrations/ConnectHeroAnimation";
import { usePhoneAccessController } from "@/global/settings/hooks/use-phone-access-controller";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { useT, useTPlural } from "@/shared/i18n";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const APP_STORE_URL =
  "https://apps.apple.com/us/app/stella-your-ai/id6761148311";
const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.fromyou.stella";

type StorePlatform = "ios" | "android";

const STORE_OPTIONS: ReadonlyArray<{
  platform: StorePlatform;
  label: string;
  url: string;
}> = [
  { platform: "ios", label: "iOS", url: APP_STORE_URL },
  { platform: "android", label: "Android", url: PLAY_STORE_URL },
];

const AppleIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M11.18.01c-1.03.07-2.26.73-2.96 1.56-.65.73-1.17 1.82-.96 2.87 1.13.04 2.3-.64 2.97-1.47.62-.75 1.1-1.8.95-2.96Zm3.08 8.77c-.03-2.73 2.22-4.05 2.32-4.12-1.27-1.85-3.24-2.1-3.95-2.13-1.68-.17-3.28.99-4.13.99-.85 0-2.17-.97-3.56-.94-1.84.03-3.52 1.07-4.47 2.71-1.9 3.3-.48 8.19 1.38 10.87.91 1.32 1.99 2.8 3.42 2.74 1.37-.05 1.89-.88 3.54-.88s2.12.88 3.57.85c1.47-.03 2.4-1.32 3.3-2.64 1.05-1.53 1.48-3.01 1.51-3.09-.03-.01-2.93-1.12-2.95-4.34Z" />
  </svg>
);

const AndroidIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M17.52 15.34a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm-11.04 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm11.4-6.02 2-3.46a.42.42 0 0 0-.72-.42l-2.02 3.51A12.35 12.35 0 0 0 12 7.85c-1.85 0-3.59.39-5.14 1.1L4.84 5.44a.42.42 0 0 0-.72.42l2 3.46A10.72 10.72 0 0 0 0 18.76h24a10.72 10.72 0 0 0-6.12-9.44Z" />
  </svg>
);

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
  const [storePlatform, setStorePlatform] = useState<StorePlatform>("ios");
  const [storeQrDataUrls, setStoreQrDataUrls] = useState<
    Record<StorePlatform, string | null>
  >({ ios: null, android: null });

  useEffect(() => {
    let cancelled = false;
    STORE_OPTIONS.forEach(({ platform, url }) => {
      QRCode.toDataURL(url, {
        width: 140,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      })
        .then((dataUrl) => {
          if (!cancelled) {
            setStoreQrDataUrls((current) => ({
              ...current,
              [platform]: dataUrl,
            }));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setStoreQrDataUrls((current) => ({
              ...current,
              [platform]: null,
            }));
          }
        });
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
                  <div className="connect-pair-download">
                    <div
                      className="connect-store-selector"
                      role="group"
                      aria-label={t(
                        "settings.phoneAccess.steps.platformSelectorLabel",
                      )}
                    >
                      {STORE_OPTIONS.map(({ platform, label }) => {
                        const isSelected = platform === storePlatform;
                        return (
                          <button
                            key={platform}
                            type="button"
                            className="connect-store-option"
                            aria-pressed={isSelected}
                            data-active={isSelected || undefined}
                            onClick={() => setStorePlatform(platform)}
                          >
                            {platform === "ios" ? (
                              <AppleIcon />
                            ) : (
                              <AndroidIcon />
                            )}
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="connect-pair-qr-block">
                      {storeQrDataUrls[storePlatform] ? (
                        <img
                          src={storeQrDataUrls[storePlatform]}
                          alt={t(
                            storePlatform === "ios"
                              ? "settings.phoneAccess.steps.appStoreQrAlt"
                              : "settings.phoneAccess.steps.playStoreQrAlt",
                          )}
                          className="connect-pair-qr"
                        />
                      ) : (
                        <div className="connect-skeleton connect-pair-qr" />
                      )}
                    </div>
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
