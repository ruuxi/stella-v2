import Constants from "expo-constants";

type StellaExtra = {
  convexUrl?: string;
  convexSiteUrl?: string;
  interiorManifestUrl?: string;
  interiorFallbackUrl?: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as StellaExtra;
const clean = (value: string | undefined) =>
  (value ?? "").trim().replace(/\/+$/, "");

export const mobileConfig = {
  convexUrl:
    clean(process.env.EXPO_PUBLIC_CONVEX_URL) ||
    clean(extra.convexUrl) ||
    "https://flexible-panther-999.convex.cloud",
  convexSiteUrl:
    clean(process.env.EXPO_PUBLIC_CONVEX_SITE_URL) ||
    clean(extra.convexSiteUrl) ||
    "https://flexible-panther-999.convex.site",
  manifestUrl:
    clean(extra.interiorManifestUrl) ||
    "https://stella-v2-interior-dev.lolruuxi.workers.dev/api/interior/manifest",
  fallbackUrl:
    clean(extra.interiorFallbackUrl) ||
    "https://stella-v2-interior-dev.lolruuxi.workers.dev/apps/stella-interior",
  scheme: "stella-mobile",
};
