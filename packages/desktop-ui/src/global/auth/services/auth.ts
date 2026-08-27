import { api } from "@/convex/api";
import { convexClient } from "@/platform/convex/convex-client";
import { signOutAuthSession } from "@/global/auth/services/auth-session";
import { getDeviceIdOrNull } from "@/platform/electron/device";

type SignOutScope = "current_device" | "all_devices";

export const secureSignOut = async (scope: SignOutScope = "current_device") => {

  const deviceId = await getDeviceIdOrNull();
  const tasks: Promise<unknown>[] = [];

  let revocationFailure: Error | null = null;
  if (scope === "all_devices") {
    tasks.push(
      convexClient.action(api.auth.revokeActiveSessions, {}).catch((error) => {
        revocationFailure =
          error instanceof Error ? error : new Error(String(error));
      }),
    );
  }
  if (deviceId) {
    tasks.push(
      convexClient.mutation(api.agent.device_resolver.goOffline, {
        deviceId,
      }).catch((error) => {
        console.debug(
          "[auth] goOffline before sign-out failed (best-effort):",
          (error as Error).message,
        );
      }),
    );
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
  if (revocationFailure !== null) {
    throw revocationFailure;
  }
  await signOutAuthSession();
};
