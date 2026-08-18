import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

/**
 * JS bridge to the native `StellaStorefront` module, which reads the current
 * App Store storefront country from StoreKit.
 *
 * The native module is iOS-only. On Android, web, or a JS-only build that was
 * never rebuilt with the native code, `requireOptionalNativeModule` returns
 * null and every helper here fails closed (returns null / no events) so a
 * missing storefront can never be mistaken for an eligible one.
 */
const StellaStorefront =
  Platform.OS === "ios"
    ? requireOptionalNativeModule("StellaStorefront")
    : null;

export function isStorefrontModuleAvailable() {
  return Boolean(StellaStorefront);
}

/**
 * Resolves the current storefront country as an uppercase ISO 3166-1 alpha-3
 * code (e.g. "USA"), or null when it cannot be established. Never throws.
 */
export async function getStorefrontCountryCode() {
  if (!StellaStorefront) return null;
  try {
    const code = await StellaStorefront.getStorefrontCountryCode();
    if (typeof code !== "string") return null;
    const normalized = code.trim().toUpperCase();
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Subscribes to runtime storefront changes. `listener` receives the new
 * uppercase country code (or null). Returns a subscription with `.remove()`.
 */
export function addStorefrontChangeListener(listener) {
  if (!StellaStorefront) {
    return { remove() {} };
  }
  try {
    return StellaStorefront.addListener("onStorefrontChange", (event) => {
      const raw = event ? event.countryCode : null;
      const code =
        typeof raw === "string" && raw.trim().length > 0
          ? raw.trim().toUpperCase()
          : null;
      listener(code);
    });
  } catch {
    return { remove() {} };
  }
}
