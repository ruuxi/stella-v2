/**
 * Builds the renderer for the browser (see `electron/source/build-web.ts`).
 *
 *   bun packages/desktop/scripts/build-web-renderer.ts [--out <dir>]
 *
 * Runs against the checkout it lives in. The default output is the website's
 * `public/chat-app/`; the desktop passes its own directory when it builds a
 * fork's renderer for upload.
 */

import path from "node:path";
import { buildWebRenderer, webBuildEnv } from "../electron/source/build-web.js";
import { loadSourceTools } from "../electron/source/tools.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const outFlag = process.argv.indexOf("--out");
const outDir =
  outFlag >= 0 && process.argv[outFlag + 1]
    ? path.resolve(process.argv[outFlag + 1]!)
    : path.join(repoRoot, "packages", "website", "public", "chat-app");

const { files } = await buildWebRenderer({
  tools: await loadSourceTools(),
  repoRoot,
  outDir,
  env: webBuildEnv(path.join(repoRoot, "packages", "desktop-ui")),
  cacheDir: path.join(repoRoot, "node_modules", ".cache", "stella-web-build"),
  log: (message) => console.log(message),
});
console.log(`Wrote ${files.length} files to ${path.relative(process.cwd(), outDir) || "."}`);
