"use client";

import Script from "next/script";

const GOOGLE_ADS_ID = "AW-18375048850";
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
