import { type SVGProps, useEffect, useState } from "react";
import QRCode from "qrcode";
import { useT } from "@/shared/i18n";
import "./GetTheApp.css";

const APP_STORE_URL =
  "https://apps.apple.com/us/app/stella-your-ai/id6761148311";
const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.fromyou.stella";

type StorePlatform = "ios" | "android";

const STORE_OPTIONS: ReadonlyArray<{
  platform: StorePlatform;
  label: string;
  url: string;
  altKey: string;
}> = [
  {
    platform: "ios",
    label: "iOS",
    url: APP_STORE_URL,
    altKey: "global.integrations.getApp.appStoreQrAlt",
  },
  {
    platform: "android",
    label: "Android",
    url: PLAY_STORE_URL,
    altKey: "global.integrations.getApp.playStoreQrAlt",
  },
];

const QR_SIZE = 152;

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

/**
 * The phone app's store link as a QR code, for iOS or Android. Shared by the
 * Connect dialog and onboarding; there is nothing to pair, so this is all a
 * phone needs from the computer.
 */
export function GetTheApp() {
  const t = useT();
  const [platform, setPlatform] = useState<StorePlatform>("ios");
  const [qr, setQr] = useState<Record<StorePlatform, string | null>>({
    ios: null,
    android: null,
  });

  useEffect(() => {
    let cancelled = false;
    for (const option of STORE_OPTIONS) {
      QRCode.toDataURL(option.url, {
        width: QR_SIZE * 2,
        margin: 1,
        color: { dark: "#000000", light: "#ffffff" },
      })
        .then((dataUrl) => {
          if (!cancelled) {
            setQr((current) => ({ ...current, [option.platform]: dataUrl }));
          }
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const active = STORE_OPTIONS.find((option) => option.platform === platform)!;

  return (
    <div className="get-app">
      <div
        className="get-app__platforms"
        role="radiogroup"
        aria-label={t("global.integrations.getApp.platformLabel")}
      >
        {STORE_OPTIONS.map((option) => {
          const selected = option.platform === platform;
          return (
            <button
              key={option.platform}
              type="button"
              role="radio"
              aria-checked={selected}
              className="get-app__platform"
              data-active={selected || undefined}
              onClick={() => setPlatform(option.platform)}
            >
              {option.platform === "ios" ? <AppleIcon /> : <AndroidIcon />}
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
      <div className="get-app__qr">
        {qr[platform] ? (
          <img src={qr[platform]!} alt={t(active.altKey)} draggable={false} />
        ) : (
          <span className="get-app__qr-placeholder" />
        )}
      </div>
    </div>
  );
}
