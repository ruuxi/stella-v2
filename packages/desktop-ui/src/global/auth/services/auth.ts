import { api } from "@/convex/api";
import { convexClient } from "@/platform/convex/convex-client";
import { signOutAuthSession } from "@/global/auth/services/auth-session";

type SignOutScope = "current_device" | "all_devices";

export const secureSignOut = async (scope: SignOutScope = "current_device") => {
  // Revocation is NOT best-effort. It deletes every Better Auth session row on
  // the account and tombstones their ids, and reporting success when it failed
  // would leave the user believing their other devices are signed out while
  // those sessions are still live. A failure propagates instead, and the local
  // sign-out below is deliberately not attempted in that case.
  if (scope === "all_devices") {
    await convexClient.action(api.auth.revokeActiveSessions, {});
  }
  await signOutAuthSession();
};
