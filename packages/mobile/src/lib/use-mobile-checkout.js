import { useCallback, useRef, useState } from "react";
import * as WebBrowser from "expo-web-browser";
import { useAction } from "convex/react";
import {
  createBillingPortalSessionRef,
  createCheckoutSessionRef,
} from "./billing-refs";
import { userFacingError } from "./user-facing-error";

// Stripe requires an HTTPS return URL (the backend rejects custom schemes), so
// Checkout returns to the existing web billing page. The native app does not
// depend on reading that redirect: entitlement is confirmed by the reactive
// `getSubscriptionStatus` query once Stripe's webhook lands, never by the
// client's browser result.
const CHECKOUT_RETURN_URL = "https://stella.sh/billing";

function convexErrorData(error) {
  if (error && typeof error === "object" && "data" in error) {
    const data = error.data;
    if (data && typeof data === "object") return data;
  }
  return null;
}

function messageFromError(error) {
  const data = convexErrorData(error);
  if (data && typeof data.message === "string" && data.message.trim()) {
    return data.message.trim();
  }
  return userFacingError(error);
}

/**
 * Imperative side of the mobile subscription flow: create a Stripe Checkout
 * session, open it in the compliant external browser, and open the Stripe
 * customer portal. Purchase success is NOT inferred here — the calling section
 * observes the reactive entitlement and resolves the UI.
 *
 * Phases: "idle" -> "starting" -> "pending" (browser open / awaiting webhook)
 * and "error" on failure.
 */
export function useMobileCheckout() {
  const createCheckout = useAction(createCheckoutSessionRef);
  const createPortal = useAction(createBillingPortalSessionRef);
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState(null); // { code, message } | null
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  const startCheckout = useCallback(
    async (plan, countryCode) => {
      // Guard duplicate taps / overlapping sessions.
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setError(null);
      setPhase("starting");
      try {
        const result = await createCheckout({
          plan,
          returnUrl: CHECKOUT_RETURN_URL,
          source: "ios",
          appStoreCountry: countryCode ?? undefined,
        });
        const url = result && result.url;
        if (!url) {
          throw new Error("Checkout could not be started. Please try again.");
        }
        setPhase("pending");
        await WebBrowser.openBrowserAsync(url, { dismissButtonStyle: "done" });
        // Remain "pending": the section flips to success when the plan
        // updates, or lets the user retry if they dismissed without paying.
      } catch (err) {
        const data = convexErrorData(err);
        setError({
          code: data && typeof data.code === "string" ? data.code : null,
          message: messageFromError(err),
        });
        setPhase("error");
      } finally {
        inFlightRef.current = false;
      }
    },
    [createCheckout],
  );

  const openManage = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const result = await createPortal({ returnUrl: CHECKOUT_RETURN_URL });
      const url = result && result.url;
      if (url) {
        await WebBrowser.openBrowserAsync(url, { dismissButtonStyle: "done" });
      }
    } catch (err) {
      setError({ code: null, message: messageFromError(err) });
      setPhase("error");
    } finally {
      inFlightRef.current = false;
    }
  }, [createPortal]);

  return { phase, error, startCheckout, openManage, reset, setPhase };
}
