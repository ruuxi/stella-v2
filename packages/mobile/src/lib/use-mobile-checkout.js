import { useCallback, useRef, useState } from "react";
import * as WebBrowser from "expo-web-browser";
import * as Crypto from "expo-crypto";
import { getBackendClient } from "./backend";
import { userFacingError } from "./user-facing-error";

// Stripe requires an HTTPS return URL (the backend rejects custom schemes), so
// Checkout returns to the existing web billing page. The native app does not
// depend on reading that redirect: entitlement is confirmed by the live
// `billing.status` view once Stripe's webhook lands, never by the client's
// browser result.
const CHECKOUT_RETURN_URL = "https://stella.sh/billing";

/** The backend's `{ code, message }` for a refused call. */
function backendErrorData(error) {
  if (error && typeof error === "object" && typeof error.code === "string") {
    return { code: error.code, message: error.message };
  }
  return null;
}

function messageFromError(error) {
  const data = backendErrorData(error);
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
  const createCheckout = useCallback(
    ({ plan, returnUrl, source, appStoreCountry }) =>
      getBackendClient().call("billing.checkout", {
        plan,
        returnUrl,
        ...(source ? { source } : {}),
        ...(appStoreCountry ? { appStoreCountry } : {}),
      }),
    [],
  );
  const createPortal = useCallback(
    ({ returnUrl }) => getBackendClient().call("billing.portal", { returnUrl }),
    [],
  );
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState(null); // { code, message } | null
  const inFlightRef = useRef(false);
  const checkoutRequestRef = useRef(null);
  const portalRequestRef = useRef(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    checkoutRequestRef.current = null;
    portalRequestRef.current = null;
  }, []);

  const startCheckout = useCallback(
    async (plan, countryCode) => {
      // Guard duplicate taps / overlapping sessions.
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setError(null);
      setPhase("starting");
      try {
        const requestKey = `${plan}:${countryCode ?? ""}`;
        const request =
          checkoutRequestRef.current?.key === requestKey
            ? checkoutRequestRef.current
            : {
                key: requestKey,
                requestId: Crypto.randomUUID(),
              };
        checkoutRequestRef.current = request;
        const result = await createCheckout({
          plan,
          returnUrl: CHECKOUT_RETURN_URL,
          source: "ios",
          appStoreCountry: countryCode ?? undefined,
          requestId: request.requestId,
        });
        const url = result && result.url;
        if (!url) {
          throw new Error("Checkout could not be started. Please try again.");
        }
        setPhase("pending");
        await WebBrowser.openBrowserAsync(url, { dismissButtonStyle: "done" });
        checkoutRequestRef.current = null;
        // Remain "pending": the section flips to success when the plan
        // updates, or lets the user retry if they dismissed without paying.
      } catch (err) {
        const data = backendErrorData(err);
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
      const requestId = portalRequestRef.current ?? Crypto.randomUUID();
      portalRequestRef.current = requestId;
      const result = await createPortal({
        returnUrl: CHECKOUT_RETURN_URL,
        requestId,
      });
      const url = result && result.url;
      if (url) {
        await WebBrowser.openBrowserAsync(url, { dismissButtonStyle: "done" });
        portalRequestRef.current = null;
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
