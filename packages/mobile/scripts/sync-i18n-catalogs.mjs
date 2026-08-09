#!/usr/bin/env node
/**
 * Copies the desktop translation catalogs into `packages/mobile/src/i18n/`
 * so Metro can resolve them from inside the mobile project root.
 *
 * WHY A COPY AND NOT A CROSS-PACKAGE IMPORT
 * -----------------------------------------
 * The desktop catalogs live at
 * `packages/desktop-ui/src/shared/i18n/locales/*.json`, which is OUTSIDE
 * Metro's `projectRoot` (`packages/mobile`). Reaching them directly would
 * need `watchFolders: [monorepoRoot]`, which makes Metro crawl the entire
 * repo (Electron main, Rust browser, native helpers, home-seed, …) on every
 * start, and it also depends on `packages/mobile` declaring a dependency on
 * `@stella/desktop-ui` — which it deliberately does not (nothing else in the
 * mobile app imports across package boundaries today).
 *
 * The copies are plain JSON inside `src/`, so they are:
 *   - resolvable by the stock Expo Metro config (no metro.config.js at all),
 *   - tracked by git (nothing in .gitignore covers them), which is what makes
 *     a production EAS build work: EAS uploads the git-tracked tree, so the
 *     catalogs are present before `npm install` or any build hook runs.
 *
 * `src/i18n/locales.ts` is ALSO copied verbatim (it is a dependency-free
 * module) so the supported-locale list, `matchSupportedLocale` matching
 * rules, RTL set and storage key can never drift from desktop.
 *
 * Run: `node scripts/sync-i18n-catalogs.mjs` (wired into the mobile
 * `start` / `ios` / `android` / `typecheck` scripts).
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(here, "..");
const desktopI18n = resolve(
  mobileRoot,
  "../desktop-ui/src/shared/i18n",
);

const outDir = join(mobileRoot, "src", "i18n");
const outLocales = join(outDir, "locales");

const banner = (source) =>
  `// GENERATED FILE — DO NOT EDIT.\n` +
  `// Copied from packages/desktop-ui/src/shared/i18n/${source}\n` +
  `// by packages/mobile/scripts/sync-i18n-catalogs.mjs.\n`;

mkdirSync(outLocales, { recursive: true });

// 1. locales.ts — verbatim copy (it imports nothing).
const localesSource = readFileSync(join(desktopI18n, "locales.ts"), "utf8");
if (/^\s*import\s/m.test(localesSource)) {
  throw new Error(
    "desktop locales.ts grew an import; it can no longer be copied verbatim.",
  );
}
writeFileSync(
  join(outDir, "locales.ts"),
  `${banner("locales.ts")}\n${localesSource}`,
);

// 2. The catalogs themselves.
const catalogDir = join(desktopI18n, "locales");
const catalogFiles = readdirSync(catalogDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

for (const stale of readdirSync(outLocales)) {
  if (!catalogFiles.includes(stale)) rmSync(join(outLocales, stale));
}
for (const name of catalogFiles) {
  // Re-serialise so a malformed catalog fails here rather than at runtime.
  const parsed = JSON.parse(readFileSync(join(catalogDir, name), "utf8"));
  writeFileSync(
    join(outLocales, name),
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
}

// 3. A static require registry. Metro has no `import.meta.glob` and cannot
//    resolve a `require()` whose argument is a variable, so the mapping from
//    locale tag to module has to exist literally in the source.
const entries = catalogFiles
  .map((name) => {
    const locale = name.slice(0, -".json".length);
    return `  ${JSON.stringify(locale)}: () =>\n    require("./locales/${name}") as Catalog,`;
  })
  .join("\n");

writeFileSync(
  join(outDir, "catalog-registry.generated.ts"),
  `${banner("locales/*.json")}
import type { Catalog } from "./catalog-types";

/**
 * Lazy thunks, one per catalog. Every catalog is inside the JS bundle
 * (Metro does not code-split for native), but only the ones actually asked
 * for are parsed and evaluated, so a cold start pays for English alone.
 */
export const CATALOG_LOADERS: Record<string, () => Catalog> = {
${entries}
};
`,
);

console.log(
  `[i18n] synced ${catalogFiles.length} catalogs + locales.ts into src/i18n/`,
);
