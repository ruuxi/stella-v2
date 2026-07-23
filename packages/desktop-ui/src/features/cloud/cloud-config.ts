export const CLOUD_APPS_HOST =
  (import.meta.env.VITE_STELLA_APPS_HOST as string | undefined)?.replace(
    /\/+$/,
    "",
  ) ?? "https://stella-v2-apps-host-dev.lolruuxi.workers.dev";

export const cloudAppUrl = (slug: string): string =>
  `${CLOUD_APPS_HOST}/apps/${encodeURIComponent(slug)}/`;
