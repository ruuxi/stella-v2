"use client";

import Script from "next/script";
import { useEffect } from "react";

const GOOGLE_ADS_ID = "AW-18375048850";
const GOOGLE_ADS_SCRIPT_ID = "google-ads-tag";
const GOOGLE_ADS_LOAD_DELAY_MS = 3000;
const DOWNLOAD_CONVERSION_DESTINATION =
  "AW-18375048850/CrdSCMj5-d8cEJL987lE";
const SIGNUP_CONVERSION_DESTINATION = "AW-18375048850/6cIuCJjxhuAcEJL987lE";
const SIGNUP_REPORTED_KEY = "stella-google-ads-signup-reported";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * Google tag (gtag.js) for the Google Ads account. Mounted once in the root
 * layout so every page — including the /fix/* landing pages — carries it.
 * Loading unconditionally (rather than only for ad-attributed visits) keeps
 * the Ads-side tag health check green and lets conversions fire on pages the
 * visitor reaches after the initial ad click.
 */
export function GoogleAdsTag() {
  useEffect(() => {
    let timer = 0;

    const load = () => {
      if (timer) window.clearTimeout(timer);
      timer = 0;
      window.removeEventListener("pointerdown", load);
      window.removeEventListener("keydown", load);
      window.removeEventListener("touchstart", load);

      if (document.getElementById(GOOGLE_ADS_SCRIPT_ID)) return;
      const script = document.createElement("script");
      script.id = GOOGLE_ADS_SCRIPT_ID;
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`;
      document.head.appendChild(script);
    };

    const schedule = () => {
      timer = window.setTimeout(load, GOOGLE_ADS_LOAD_DELAY_MS);
    };

    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });

    // An engaged visitor should never wait for the fallback timer. The queue
    // below is already live, so a click-triggered conversion is retained while
    // the external script downloads.
    window.addEventListener("pointerdown", load, { once: true, passive: true });
    window.addEventListener("keydown", load, { once: true });
    window.addEventListener("touchstart", load, { once: true, passive: true });

    return () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("load", schedule);
      window.removeEventListener("pointerdown", load);
      window.removeEventListener("keydown", load);
      window.removeEventListener("touchstart", load);
    };
  }, []);

  return (
    /* Install Google's queue immediately after hydration. Conversion calls
       made before gtag.js arrives are retained and drained by the library. */
    <Script id="google-ads-config" strategy="afterInteractive">
      {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = gtag;
          gtag('js', new Date());
          gtag('config', '${GOOGLE_ADS_ID}');
        `}
    </Script>
  );
}

/**
 * Call gtag even if gtag.js hasn't finished loading yet: install the standard
 * queueing stub (gtag.js drains `dataLayer` entries pushed as Arguments
 * objects) and dispatch through it.
 */
function gtagSafe(...args: unknown[]): void {
  if (typeof window.gtag !== "function") {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() {
      // gtag.js requires the real Arguments object, not an array.
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer?.push(arguments);
    };
  }
  window.gtag(...args);
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

/**
 * Report the Google Ads "Sign-up" conversion. Called wherever a sign-in /
 * sign-up observably completes on the website: the magic-link flow finishing,
 * the social-OAuth return token verifying, and the terminal
 * `/auth/callback?done=true` page. Deduped per browser so returning sign-ins
 * don't re-count.
 */
export function reportGoogleAdsSignup() {
  if (typeof window === "undefined") return;

  try {
    if (window.localStorage.getItem(SIGNUP_REPORTED_KEY)) return;
    window.localStorage.setItem(SIGNUP_REPORTED_KEY, String(Date.now()));
  } catch {
    // Storage blocked — still report; Google dedupes per ad click server-side.
  }

  gtagSafe("event", "conversion", {
    send_to: SIGNUP_CONVERSION_DESTINATION,
    value: 1.0,
    currency: "USD",
  });
}
