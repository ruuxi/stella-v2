"use client";

import Script from "next/script";
import { useEffect, useSyncExternalStore } from "react";

const GOOGLE_ADS_ID = "AW-18375048850";
const DOWNLOAD_CONVERSION_DESTINATION =
  "AW-18375048850/CrdSCMj5-d8cEJL987lE";
const ATTRIBUTION_KEY = "stella-google-ads-attribution";
const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const GOOGLE_CLICK_IDS = ["gclid", "gbraid", "wbraid"] as const;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

function hasGoogleAdsClickId() {
  const params = new URLSearchParams(window.location.search);
  return GOOGLE_CLICK_IDS.some((key) => params.has(key));
}

function hasCurrentAttribution() {
  try {
    const expiresAt = Number(window.localStorage.getItem(ATTRIBUTION_KEY));
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  } catch {
    return false;
  }
}

function subscribeNoop() {
  return () => {};
}

function shouldEnableMeasurement() {
  return hasGoogleAdsClickId() || hasCurrentAttribution();
}

export function GoogleAdsTag() {
  const enabled = useSyncExternalStore(
    subscribeNoop,
    shouldEnableMeasurement,
    () => false,
  );

  useEffect(() => {
    if (hasGoogleAdsClickId()) {
      try {
        window.localStorage.setItem(
          ATTRIBUTION_KEY,
          String(Date.now() + ATTRIBUTION_WINDOW_MS),
        );
      } catch {
        // Measurement is optional; downloads must work when storage is blocked.
      }
    }
  }, []);

  if (!enabled) return null;

  return (
    <>
      <Script
        id="google-ads-tag"
        src={`https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`}
        strategy="afterInteractive"
      />
      <Script id="google-ads-config" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = gtag;
          gtag('js', new Date());
          gtag('config', '${GOOGLE_ADS_ID}');
        `}
      </Script>
    </>
  );
}

export function reportGoogleAdsDownload(url: string) {
  if (typeof window === "undefined") return;

  if (typeof window.gtag !== "function") {
    window.location.assign(url);
    return;
  }

  let redirected = false;
  const redirect = () => {
    if (redirected) return;
    redirected = true;
    window.location.assign(url);
  };

  window.setTimeout(redirect, 800);
  window.gtag("event", "conversion", {
    send_to: DOWNLOAD_CONVERSION_DESTINATION,
    event_callback: redirect,
  });
}
