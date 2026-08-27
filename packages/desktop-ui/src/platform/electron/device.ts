import { getElectronApi } from "./electron";
import { writeLocalDeviceId } from "./device-id";
import {
  readConfiguredConvexSiteUrl,
  readConfiguredConvexUrl,
} from "@/shared/lib/convex-urls";

export { getDeviceIdOrNull, getOrCreateDeviceId } from "./device-id";

let configurePiRuntimePromise: Promise<void> | null = null;

const runConfigurePiRuntime = async () => {
  const api = getElectronApi();
  const convexUrl = readConfiguredConvexUrl(
    import.meta.env.VITE_CONVEX_URL as string | undefined,
  );
  const convexSiteUrl = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  );
  if (!api?.system?.configurePiRuntime || !convexUrl || !convexSiteUrl) {
    return;
  }
  const response = await api.system.configurePiRuntime({
    convexUrl,
    convexSiteUrl,
  });
  if (response?.deviceId) {
    writeLocalDeviceId(response.deviceId);
  }
};

export const configurePiRuntime = async () => {
  if (configurePiRuntimePromise) {
    return configurePiRuntimePromise;
  }
  const attempt = runConfigurePiRuntime();

  configurePiRuntimePromise = attempt.then(
    () => undefined,
    (err) => {
      configurePiRuntimePromise = null;
      console.debug(
        "[device] configurePiRuntime failed:",
        (err as Error).message,
      );
    },
  );
  return configurePiRuntimePromise;
};
