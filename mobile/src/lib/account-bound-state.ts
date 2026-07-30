import { clearCachedToken } from "./auth-token";
import { clearCachedDesktopBridge } from "./desktop-bridge-chat";
import { unregisterForPushNotifications } from "./notifications";
import {
  clearStoredPhoneAccess,
  listStoredPairedPhoneAccess,
} from "./phone-access";

/**
 * Clears paired-computer credentials that must never survive an account
 * boundary. Legacy local transcript stores are deliberately not touched.
 */
export async function clearAccountBoundBridgeState(): Promise<void> {
  clearCachedDesktopBridge();
  const paired = await listStoredPairedPhoneAccess().catch(() => []);
  await Promise.all(
    paired.map((access) =>
      clearStoredPhoneAccess(access.desktopDeviceId).catch(() => undefined),
    ),
  );
}

/** Clears all account-bound credentials and registrations. */
export async function clearAccountBoundMobileState(): Promise<void> {
  await unregisterForPushNotifications().catch(() => undefined);
  clearCachedToken();
  await clearAccountBoundBridgeState();
}
