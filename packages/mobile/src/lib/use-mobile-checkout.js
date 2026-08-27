import { useCallback, useRef, useState } from "react";
import * as WebBrowser from "expo-web-browser";
import { useAction } from "convex/react";
import {
  createBillingPortalSessionRef,
  createCheckoutSessionRef,
} from "./billing-refs";
import { userFacingError } from "./user-facing-error";

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

export function useMobileCheckout() {
  const createCheckout = useAction(createCheckoutSessionRef);
  const createPortal = useAction(createBillingPortalSessionRef);
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState(null);
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  const startCheckout = useCallback(
    async (plan, countryCode) => {

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
