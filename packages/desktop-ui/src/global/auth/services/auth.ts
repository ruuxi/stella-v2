import { api } from "@/convex/api";
import { convexClient } from "@/platform/convex/convex-client";
import { signOutAuthSession } from "@/global/auth/services/auth-session";

type SignOutScope = "current_device" | "all_devices";

export const secureSignOut = async (scope: SignOutScope = "current_device") => {
  if (scope === "all_devices") {
    await convexClient
      .mutation(api.auth.revokeActiveSessions, {})
      .catch((error) => {
        console.debug(
          "[auth] Session revocation failed (best-effort):",
          (error as Error).message,
        );
      });
  }
  await signOutAuthSession();
};
