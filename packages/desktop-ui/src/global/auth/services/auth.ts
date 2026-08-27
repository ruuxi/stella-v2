import { api } from "@/convex/api";
import { convexClient } from "@/platform/convex/convex-client";
import { signOutAuthSession } from "@/global/auth/services/auth-session";
import { getDeviceIdOrNull } from "@/platform/electron/device";

type SignOutScope = "current_device" | "all_devices";

export const secureSignOut = async (scope: SignOutScope = "current_device") => {
  // Resolve the device id and fan both pre-sign-out mutations out in
  // parallel — they're independent (revoke is account-scoped, goOffline
  // is device-scoped) and `Promise.allSettled` keeps either failure
  // best-effort. They must complete before `signOutAuthSession` clears
  // the local auth token, so we await before tearing the session down.
  const deviceId = await getDeviceIdOrNull();
  const tasks: Promise<unknown>[] = [];
  // Revocation is NOT best-effort. It deletes every Better Auth session on the
  // account, and reporting success when it failed would leave the user
  // believing their other devices are signed out when they are still live. A
  // failure here propagates so the caller can surface it; the local sign-out
  // below is deliberately not attempted in that case.
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
