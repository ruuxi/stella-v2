import { api } from "@/convex/api";
import { convexClient } from "@/platform/convex/convex-client";
import { signOutAuthSession } from "@/global/auth/services/auth-session";

type SignOutScope = "current_device" | "all_devices";

export const secureSignOut = async (scope: SignOutScope = "current_device") => {
  let revocationFailure: Error | null = null;
  if (scope === "all_devices") {
    await convexClient
      .action(api.auth.revokeActiveSessions, {})
      .catch((error) => {
        revocationFailure =
          error instanceof Error ? error : new Error(String(error));
      });
  }
  if (revocationFailure !== null) {
    throw revocationFailure;
  }
  await signOutAuthSession();
};
