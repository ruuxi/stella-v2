const DEFAULT_DEV_CLOUD_APPS_HOST =
  "https://stella-v2-apps-host-dev.lolruuxi.workers.dev";

const configuredAppsHost = (
  import.meta.env.VITE_STELLA_APPS_HOST as string | undefined
)?.trim();
const allowDevelopmentAppsHostHarness =
  import.meta.env.VITE_STELLA_DEV_APPS_HOST_HARNESS === "1";

export const resolveCloudAppsHost = (
  configuredHost: string | undefined,
  isDev: boolean | undefined,
  allowDevelopmentHarness: boolean | undefined = false,
): string | null => {
  const normalized = configuredHost?.trim().replace(/\/+$/, "");
  if (normalized) {
    if (
      normalized === DEFAULT_DEV_CLOUD_APPS_HOST &&
      isDev !== true &&
      allowDevelopmentHarness !== true
    ) {
      return null;
    }
    return normalized;
  }
  return isDev === true ? DEFAULT_DEV_CLOUD_APPS_HOST : null;
};

export const CLOUD_APPS_HOST = resolveCloudAppsHost(
  configuredAppsHost,
  import.meta.env.DEV,
  allowDevelopmentAppsHostHarness,
);

export const cloudAppUrl = (slug: string): string | null =>
  CLOUD_APPS_HOST
    ? `${CLOUD_APPS_HOST}/apps/${encodeURIComponent(slug)}/`
    : null;
