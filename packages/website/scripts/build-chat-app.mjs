import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const websiteDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(websiteDir, "../..");
const viteBin = path.join(repoRoot, "node_modules/vite/bin/vite.js");
const desktopUi = path.join(repoRoot, "packages/desktop-ui");
const desktopPublicEnv = loadEnv("production", desktopUi, "VITE_");

const convexUrl =
  process.env.VITE_CONVEX_URL ||
  process.env.NEXT_PUBLIC_CONVEX_URL ||
  desktopPublicEnv.VITE_CONVEX_URL ||
  "";
const convexSiteUrl =
  process.env.VITE_CONVEX_SITE_URL ||
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL ||
  desktopPublicEnv.VITE_CONVEX_SITE_URL ||
  (convexUrl.endsWith(".convex.cloud")
    ? `${convexUrl.slice(0, -".convex.cloud".length)}.convex.site`
    : "");

const result = spawnSync(process.execPath, [viteBin, "build"], {
  cwd: desktopUi,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_STELLA_WEB_BUILD: "1",
    VITE_CONVEX_URL: convexUrl,
    VITE_CONVEX_SITE_URL: convexSiteUrl,
    VITE_STELLA_APPS_HOST:
      process.env.VITE_STELLA_APPS_HOST ||
      process.env.NEXT_PUBLIC_STELLA_APPS_HOST ||
      "https://stella-v2-apps-host-basic-nightingale-118.lolruuxi.workers.dev",
    VITE_STELLA_APPS_AUTH_HOST:
      process.env.VITE_STELLA_APPS_AUTH_HOST ||
      process.env.NEXT_PUBLIC_STELLA_APPS_AUTH_HOST ||
      process.env.NEXT_PUBLIC_STELLA_APPS_HOST ||
      "https://stella-v2-apps-host-basic-nightingale-118.lolruuxi.workers.dev",
  },
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
