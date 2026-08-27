import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

const StellaStorefront =
  Platform.OS === "ios"
    ? requireOptionalNativeModule("StellaStorefront")
    : null;

export function isStorefrontModuleAvailable() {
  return Boolean(StellaStorefront);
}

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
