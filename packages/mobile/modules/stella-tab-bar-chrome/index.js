import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

/**
 * JS bridge to the native `StellaTabBarChrome` module, which clears the
 * page background behind the hosted system tab bar and sets its titles in
 * the app font, by walking the hosted view subtree. iOS-only; elsewhere, or
 * on a build without the native code, every call is a no-op.
 */
const StellaTabBarChrome =
  Platform.OS === "ios" ? requireOptionalNativeModule("StellaTabBarChrome") : null;

/**
 * `viewTag` is the React node handle of the host view. Call once the host
 * has laid out, and again after anything that re-creates the bar's labels.
 */
export function applyTabBarChrome({
  viewTag,
  titleFontFamily,
  titleSize,
  iconPointSize = 0,
  scale = 1,
}) {
  if (!StellaTabBarChrome || viewTag == null) return;
  try {
    StellaTabBarChrome.apply(
      viewTag,
      titleFontFamily ?? null,
      titleSize,
      iconPointSize,
      scale,
    );
  } catch {
    /* an older native build without the module: keep the system look */
  }
}
