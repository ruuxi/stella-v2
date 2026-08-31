import type { NextConfig } from "next";
import path from "path";

const REVALIDATING_ASSET_CACHE =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

const nextConfig: NextConfig = {
  experimental: {
    // Keep route and component CSS in import-order chunks instead of merging
    // unrelated route styles into the homepage's paint-blocking stylesheet.
    cssChunking: "strict",
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
        // These files are deployed assets, but their public URLs are not
        // content-hashed. Cache them for repeat visits without marking them
        // immutable, so a same-name replacement is picked up within a day.
        source:
          "/:asset(stella-logo|stella-logo-ui|stella-wallpaper).:ext(png|jpg|svg)",
        headers: [
          { key: "Cache-Control", value: REVALIDATING_ASSET_CACHE },
        ],
      },
      {
        // Next appends a content hash to these URLs in generated metadata, but
        // keep the direct, unhashed route bounded rather than immutable.
        source: "/:asset(icon|apple-icon).png",
        headers: [
          { key: "Cache-Control", value: REVALIDATING_ASSET_CACHE },
        ],
      },
      {
        source:
          "/:folder(mock-app-icons|doc-mocks|app-mocks|demos)/:path*.:ext(png|jpg|jpeg|webp|avif|svg)",
        headers: [
          { key: "Cache-Control", value: REVALIDATING_ASSET_CACHE },
        ],
      },
    ];
  },
};

export default nextConfig;
