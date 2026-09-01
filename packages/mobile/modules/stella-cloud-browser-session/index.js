import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

const StellaCloudBrowserSession =
  Platform.OS === "ios"
    ? requireOptionalNativeModule("StellaCloudBrowserSession")
    : null;

export function isCloudBrowserSessionCaptureAvailable() {
  return Boolean(StellaCloudBrowserSession);
}

export async function captureCloudBrowserCookies(url) {
  if (!StellaCloudBrowserSession) {
    throw new Error("Cloud browser session capture is unavailable.");
  }
  return await StellaCloudBrowserSession.captureCookies(url);
}
