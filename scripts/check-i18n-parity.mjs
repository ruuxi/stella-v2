#!/usr/bin/env node
/**
 * Reports key drift between `en.json` and every other translation catalog.
 *
 *   node scripts/check-i18n-parity.mjs            # report and exit non-zero on drift
 *   node scripts/check-i18n-parity.mjs --json     # machine-readable report
 *
 * CI enforcement lives in
 * `packages/desktop-ui/tests/runtime/i18n/catalog-parity.test.ts`, which also
 * checks placeholders, plural categories and leaf kinds. This script exists for
 * the human loop: it prints the exact missing/extra paths per locale so a
 * backfill can be written straight from its output.
 *
 * The mobile catalogs under `packages/mobile/src/i18n/locales` are generated
 * copies of the desktop ones (see packages/mobile/scripts/sync-i18n-catalogs.mjs),
 * so they are checked here too — drift there means the copies are stale and
 * `bun run i18n:sync` has not been run.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CATALOG_ROOTS = [
  {
    name: "desktop-ui",
    dir: join(repoRoot, "packages/desktop-ui/src/shared/i18n/locales"),
  },
  {
    name: "mobile (generated)",
    dir: join(repoRoot, "packages/mobile/src/i18n/locales"),
  },
];

const PLURAL_CATEGORIES = new Set([
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
]);

/** A plural node is a LEAF: which categories a language needs is a property
 * of the language, not of the key, so its forms are never compared as paths. */
const isPluralNode = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(
      ([category, form]) =>
        PLURAL_CATEGORIES.has(category) && typeof form === "string",
    )
  );
};

const leafPaths = (node, prefix = "", out = new Set()) => {
  if (
    typeof node === "string" ||
    Array.isArray(node) ||
    isPluralNode(node) ||
    node === null ||
    typeof node !== "object"
  ) {
    out.add(prefix);
    return out;
  }
  for (const [key, child] of Object.entries(node)) {
    leafPaths(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
};

const readCatalog = (dir, locale) =>
  JSON.parse(readFileSync(join(dir, `${locale}.json`), "utf8"));

const checkRoot = ({ name, dir }) => {
  const locales = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
  if (!locales.includes("en")) {
    throw new Error(`${name}: no en.json in ${dir}`);
  }

  const english = leafPaths(readCatalog(dir, "en"));
  const report = [];
  for (const locale of locales) {
    if (locale === "en") continue;
    const translated = leafPaths(readCatalog(dir, locale));
    const missing = [...english].filter((path) => !translated.has(path)).sort();
    const extra = [...translated].filter((path) => !english.has(path)).sort();
    if (missing.length || extra.length) report.push({ locale, missing, extra });
  }
  return {
    name,
    dir,
    localeCount: locales.length,
    keyCount: english.size,
    report,
  };
};

const results = CATALOG_ROOTS.map(checkRoot);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const { name, localeCount, keyCount, report } of results) {
    console.log(
      `\n${name}: ${localeCount} catalogs, ${keyCount} keys in en.json`,
    );
    if (report.length === 0) {
      console.log("  ✓ every catalog matches en.json exactly");
      continue;
    }
    for (const { locale, missing, extra } of report) {
      console.log(
        `  ✗ ${locale}: ${missing.length} missing, ${extra.length} extra`,
      );
      for (const path of missing) console.log(`      - missing ${path}`);
      for (const path of extra) console.log(`      + extra   ${path}`);
    }
  }
}

if (results.some((result) => result.report.length > 0)) process.exitCode = 1;
