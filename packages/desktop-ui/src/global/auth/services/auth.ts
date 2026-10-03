import { authClient } from "@/global/auth/lib/auth-client";
import { signOutAuthSession } from "@/global/auth/services/auth-session";

type SignOutScope = "current_device" | "all_devices";

/**
 * Revoke every Better Auth session on the account. Electron routes it through
 * main, which owns the bearer; a browser shell calls Better Auth directly.
 */
const revokeAllSessions = async () => {
  const revoke = window.electronAPI?.system?.revokeAuthSessions;
  if (revoke) {
    await revoke();
    return;
  }
  const result = await authClient.revokeSessions();
  if (result.error) {
    throw new Error(result.error.message ?? "Session revocation failed.");
  }
};

export const secureSignOut = async (scope: SignOutScope = "current_device") => {
  // Revocation is NOT best-effort. It deletes every Better Auth session row on
  // the account, and reporting success when it failed would leave the user
  // believing their other devices are signed out while those sessions are
  // still live. A failure propagates instead, and the local sign-out below is
  // deliberately not attempted in that case.
  if (scope === "all_devices") {
    await revokeAllSessions();
  }
  await signOutAuthSession();
};
