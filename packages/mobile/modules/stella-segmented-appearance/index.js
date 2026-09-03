import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

/**
 * JS bridge to the native `StellaSegmentedAppearance` module, which colours
 * UIKit's segmented control (the sidebar tab bar) through the UIAppearance
 * proxy. iOS-only; on other platforms, or a build without the native code,
 * every call is a no-op.
 */
const StellaSegmentedAppearance =
  Platform.OS === "ios"
    ? requireOptionalNativeModule("StellaSegmentedAppearance")
    : null;

/**
 * Applies to segmented controls created after the call. Colours are
 * "#RRGGBB" or "#RRGGBBAA"; pass null to restore the system default.
 */
export function applySegmentedControlAppearance({ background, selected }) {
  if (!StellaSegmentedAppearance) return;
  try {
    StellaSegmentedAppearance.apply(background ?? null, selected ?? null);
  } catch {
    /* an older native build without the module: keep the system look */
  }
}
