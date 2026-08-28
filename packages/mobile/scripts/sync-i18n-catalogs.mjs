#!/usr/bin/env node
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

mkdirSync(outLocales, { recursive: true });

const localesSource = readFileSync(join(desktopI18n, "locales.ts"), "utf8");
if (/^\s*import\s/m.test(localesSource)) {
  throw new Error(
    "desktop locales.ts grew an import; it can no longer be copied verbatim.",
  );
}
writeFileSync(
  join(outDir, "locales.ts"),
  localesSource,
);

const catalogDir = join(desktopI18n, "locales");
const catalogFiles = readdirSync(catalogDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

for (const stale of readdirSync(outLocales)) {
  if (!catalogFiles.includes(stale)) rmSync(join(outLocales, stale));
}
for (const name of catalogFiles) {

  const parsed = JSON.parse(readFileSync(join(catalogDir, name), "utf8"));
  writeFileSync(
    join(outLocales, name),
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
}

const entries = catalogFiles
  .map((name) => {
    const locale = name.slice(0, -".json".length);
    return `  ${JSON.stringify(locale)}: () =>\n    require("./locales/${name}") as Catalog,`;
  })
  .join("\n");

writeFileSync(
  join(outDir, "catalog-registry.generated.ts"),
  `import type { Catalog } from "./catalog-types";

export const CATALOG_LOADERS: Record<string, () => Catalog> = {
${entries}
};
`,
);

console.log(
  `[i18n] synced ${catalogFiles.length} catalogs + locales.ts into src/i18n/`,
);
