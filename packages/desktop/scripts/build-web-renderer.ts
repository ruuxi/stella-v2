/**
 * Builds the renderer for the browser (see `electron/source/build-web.ts`).
 *
 *   bun packages/desktop/scripts/build-web-renderer.ts [--out <dir>] [--static-home]
 *
 * Runs against the checkout it lives in. The default output is the website's
 * `public/chat-app/`; the desktop passes its own directory when it builds a
 * fork's renderer for upload. `--static-home` puts the static Home
 * (desktop-ui/web-static-home.html) in the page and links the entry's
 * stylesheets from it, for the shared build only.
 */

import path from "node:path";
import { buildWebRenderer, webBuildEnv, type StaticHomeRoot } from "../electron/source/build-web.js";
import { deriveTokens, getThemeById, resolveThemeColors, THEME_CSS_VARS } from "../../theme/index.ts";
import { loadSourceTools } from "../electron/source/tools.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const outFlag = process.argv.indexOf("--out");
const outDir =
  outFlag >= 0 && process.argv[outFlag + 1]
    ? path.resolve(process.argv[outFlag + 1]!)
    : path.join(repoRoot, "packages", "website", "public", "chat-app");

const firstVisitRoot = (isDark: boolean): StaticHomeRoot => {
  const custom = getThemeById("custom");
  if (!custom) return { attributes: {}, properties: [] };
  const { colors, baseThemeId, forcedMode, flat } = resolveThemeColors(custom, isDark, custom.base);
  const dark = forcedMode ? forcedMode === "dark" : isDark;
  const tokens = deriveTokens(colors, dark, { flat });
  return {
    attributes: {
      "data-theme": custom.id,
      ...(baseThemeId && baseThemeId !== custom.id ? { "data-base-theme": baseThemeId } : {}),
    },
    properties: THEME_CSS_VARS.map(([name, key]) => [name, tokens[key]]),
  };
};

const { files } = await buildWebRenderer({
  tools: await loadSourceTools(),
  repoRoot,
  outDir,
  env: webBuildEnv(path.join(repoRoot, "packages", "desktop-ui")),
  cacheDir: path.join(repoRoot, "node_modules", ".cache", "stella-web-build"),
  log: (message) => console.log(message),
  staticHome: process.argv.includes("--static-home")
    ? { firstVisit: { dark: firstVisitRoot(true), light: firstVisitRoot(false) } }
    : undefined,
});
console.log(`Wrote ${files.length} files to ${path.relative(process.cwd(), outDir) || "."}`);
