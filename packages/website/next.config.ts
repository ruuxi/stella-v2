import type { NextConfig } from "next";
import path from "path";
import { loadEnv } from "vite";

const desktopPublicEnv = loadEnv(
  process.env.NODE_ENV || "production",
  path.resolve(__dirname, "../desktop-ui"),
  "VITE_",
);
const publicConvexUrl =
  process.env.NEXT_PUBLIC_CONVEX_URL || desktopPublicEnv.VITE_CONVEX_URL;
const publicConvexSiteUrl =
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL ||
  (publicConvexUrl?.endsWith(".convex.cloud")
    ? `${publicConvexUrl.slice(0, -".convex.cloud".length)}.convex.site`
    : desktopPublicEnv.VITE_CONVEX_SITE_URL);
const publicTurnstileSiteKey =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ||
  desktopPublicEnv.VITE_TURNSTILE_SITE_KEY;

const REVALIDATING_ASSET_CACHE =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

const nextConfig: NextConfig = {
  experimental: {
    // Keep route and component CSS in import-order chunks instead of merging
    // unrelated route styles into the homepage's paint-blocking stylesheet.
    cssChunking: "strict",
  },
  env: {
    ...(publicConvexUrl ? { NEXT_PUBLIC_CONVEX_URL: publicConvexUrl } : {}),
    ...(publicConvexSiteUrl
      ? { NEXT_PUBLIC_CONVEX_SITE_URL: publicConvexSiteUrl }
      : {}),
    ...(publicTurnstileSiteKey
      ? { NEXT_PUBLIC_TURNSTILE_SITE_KEY: publicTurnstileSiteKey }
      : {}),
  },
  turbopack: {
    // Dependencies and the lockfile live at the workspace root.
    root: path.resolve(__dirname, "../.."),
  },
  images: {
    // Serve AVIF first (smallest), then WebP, then fall back to the source.
    formats: ["image/avif", "image/webp"],
    // Whitelist the quality levels used via the `quality` prop (default is [75]).
    qualities: [75, 82],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.fal.media",
      },
    ],
    // Keep generated variants warm in the optimizer cache. Browser caching is
    // controlled separately below because public source filenames are mutable.
    minimumCacheTTL: 31536000,
  },
  async redirects() {
    return [
      // The "Agents" page was renamed to "One chat"; keep old links alive.
      { source: "/agents", destination: "/one-chat", permanent: true },
      { source: "/agents.md", destination: "/one-chat.md", permanent: true },
      // The dedicated "Stella Go" landing page was retired. Send its old URL
      // (and any inbound ad/link traffic) to the homepage with a 301 so it
      // never 404s (a 404 would get Google Ads disapproved). An explicit 301
      // (rather than Next's default 308 for `permanent`) is what Google Ads /
      // Search expect for a retired page.
      { source: "/go", destination: "/", statusCode: 301 },
    ];
  },
  async headers() {
    return [
      {
        // The hosted Turnstile page hands tokens to the app that opened it;
        // it must never be embedded by another site.
        source: "/challenge",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        source: "/chat",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://www.google-analytics.com https://www.googletagmanager.com https://www.google.com https://*.doubleclick.net; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        source: "/chat-app/assets/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        source: "/chat-app/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        // These files are deployed assets, but their public URLs are not
        // content-hashed. Cache them for repeat visits without marking them
        // immutable, so a same-name replacement is picked up within a day.
        source:
          "/:asset(stella-logo|stella-logo-ui|stella-wallpaper).:ext(png|jpg|svg)",
        headers: [{ key: "Cache-Control", value: REVALIDATING_ASSET_CACHE }],
      },
      {
        // Next appends a content hash to these URLs in generated metadata, but
        // keep the direct, unhashed route bounded rather than immutable.
        source: "/:asset(icon|apple-icon).png",
        headers: [{ key: "Cache-Control", value: REVALIDATING_ASSET_CACHE }],
      },
      {
        source:
          "/:folder(mock-app-icons|doc-mocks|app-mocks|demos)/:path*.:ext(png|jpg|jpeg|webp|avif|svg)",
        headers: [{ key: "Cache-Control", value: REVALIDATING_ASSET_CACHE }],
      },
    ];
  },
};

export default nextConfig;
