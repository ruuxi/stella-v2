import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  addStorefrontChangeListener,
  getStorefrontCountryCode,
  isStorefrontModuleAvailable,
} from "../../modules/stella-storefront";

/**
 * Region gating for the mobile subscription surface.
 *
 * Eligibility for in-app subscription purchase is decided ONLY by the App
 * Store storefront country reported by StoreKit (see the native module). US
 * storefront -> eligible; every other storefront, plus "unknown" (no App
 * Store account, StoreKit unavailable, non-iOS, module missing), fails closed
 * to ineligible. Device language/locale and IP are never consulted.
 *
 * The value is re-read on mount, whenever the app returns to the foreground,
 * and whenever StoreKit reports a storefront change, so the UI re-gates
 * without a restart.
 */
export const US_STOREFRONT_CODE = "USA";

// Dev-only storefront override so both the eligible and ineligible UI paths
// can be exercised in the simulator without an App Store account. It is
// honored ONLY when `__DEV__` is true, so it is dead code in release builds
// and can never become a production bypass. `undefined` = no override,
// `null` = force "unknown", a string = force that storefront code.
let debugStorefrontOverride;

export function setDebugStorefrontOverride(codeOrNull) {
  if (!__DEV__) return;
  debugStorefrontOverride =
    codeOrNull == null ? codeOrNull : String(codeOrNull).trim().toUpperCase();
}

export function getDebugStorefrontOverride() {
  return __DEV__ ? debugStorefrontOverride : undefined;
}

async function resolveStorefrontCountryCode() {
  if (__DEV__ && debugStorefrontOverride !== undefined) {
    return debugStorefrontOverride;
  }
  return getStorefrontCountryCode();
}

/**
 * @returns {{
 *   status: "loading" | "eligible" | "ineligible",
 *   countryCode: string | null,
 *   moduleAvailable: boolean,
 *   refresh: () => void,
 * }}
 */
export function useStorefrontEligibility() {
  const [state, setState] = useState({ status: "loading", countryCode: null });
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const code = await resolveStorefrontCountryCode();
    if (!mountedRef.current) return;
    setState({
      status: code === US_STOREFRONT_CODE ? "eligible" : "ineligible",
      countryCode: code ?? null,
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    const appStateSub = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh();
    });
    const storefrontSub = addStorefrontChangeListener(() => {
      void refresh();
    });

    return () => {
      mountedRef.current = false;
      appStateSub.remove();
      storefrontSub.remove();
    };
  }, [refresh]);

  return {
    status: state.status,
    countryCode: state.countryCode,
    moduleAvailable: isStorefrontModuleAvailable(),
    refresh: () => void refresh(),
  };
}
