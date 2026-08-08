const cleanUrl = (value: string | undefined): string =>
  (value ?? "").trim().replace(/\/+$/, "");

const deriveConvexSiteUrl = () => {
  const explicit = cleanUrl(process.env.EXPO_PUBLIC_CONVEX_SITE_URL);
  if (explicit) {
    return explicit;
  }

  const convexUrl = cleanUrl(process.env.EXPO_PUBLIC_CONVEX_URL);
  if (!convexUrl) {
    return "";
  }

  if (convexUrl.includes(".convex.site")) {
    return convexUrl;
  }

  if (convexUrl.includes(".convex.cloud")) {
    return convexUrl.replace(".convex.cloud", ".convex.site");
  }

  return "";
};

export const env = {
  convexSiteUrl: deriveConvexSiteUrl(),
  convexUrl: cleanUrl(process.env.EXPO_PUBLIC_CONVEX_URL),
  siteUrl: cleanUrl(process.env.EXPO_PUBLIC_SITE_URL) || "https://stella.sh",
  mobileScheme:
    process.env.EXPO_PUBLIC_STELLA_MOBILE_SCHEME?.trim() || "stella-mobile",
};

export const hasMobileConfig = Boolean(env.convexSiteUrl);
