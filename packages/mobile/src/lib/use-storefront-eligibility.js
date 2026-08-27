import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  addStorefrontChangeListener,
  getStorefrontCountryCode,
  isStorefrontModuleAvailable,
} from "../../modules/stella-storefront";

export const US_STOREFRONT_CODE = "USA";

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
