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
  (convexUrl.endsWith(".convex.cloud")
    ? `${convexUrl.slice(0, -".convex.cloud".length)}.convex.site`
    : desktopPublicEnv.VITE_CONVEX_SITE_URL || "");

const deploymentSuffix = {
  "https://outgoing-bulldog-865.convex.cloud": "dev",
  "https://intent-jackal-330.convex.cloud": "prod",
  "https://basic-nightingale-118.convex.cloud": "basic-nightingale-118",
}[convexUrl];
const appsHost =
  process.env.VITE_STELLA_APPS_HOST ||
  process.env.NEXT_PUBLIC_STELLA_APPS_HOST ||
  (deploymentSuffix
    ? `https://stella-v2-apps-host-${deploymentSuffix}.lolruuxi.workers.dev`
    : "");
const appsAuthHost =
  process.env.VITE_STELLA_APPS_AUTH_HOST ||
  process.env.NEXT_PUBLIC_STELLA_APPS_AUTH_HOST ||
  (deploymentSuffix
    ? `https://stella-v2-apps-auth-${deploymentSuffix}.lolruuxi.workers.dev`
    : "");
if (!appsHost || !appsAuthHost) {
  throw new Error("Configure both Stella Apps host origins for this backend.");
}

const result = spawnSync(process.execPath, [viteBin, "build"], {
  cwd: desktopUi,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_STELLA_WEB_BUILD: "1",
    VITE_CONVEX_URL: convexUrl,
    VITE_CONVEX_SITE_URL: convexSiteUrl,
    VITE_TURNSTILE_SITE_KEY:
      process.env.VITE_TURNSTILE_SITE_KEY ||
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ||
      desktopPublicEnv.VITE_TURNSTILE_SITE_KEY ||
      "",
    VITE_STELLA_APPS_HOST: appsHost,
    VITE_STELLA_APPS_AUTH_HOST: appsAuthHost,
  },
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
