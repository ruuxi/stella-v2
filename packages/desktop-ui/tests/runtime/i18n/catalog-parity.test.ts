/**
 * Guards the translation catalogs against the three ways they rot:
 *
 *  1. **Drift** — a key added to `en.json` and never backfilled, or a key
 *     deleted from English and left behind in 27 other files. Both are
 *     invisible at runtime because `translate()` silently falls back to
 *     English, so only a test catches them.
 *  2. **Broken interpolation** — a translator dropping `{count}` or
 *     renaming `{name}`, which renders a literal brace to the user.
 *  3. **Bad plural nodes** — a pluralised entry missing `other`, which is
 *     the one category every locale is required to have.
 *
 * Plural nodes are compared as *leaves*, not as subtrees: which
 * categories a language needs is a property of the language, not of the
 * key. Japanese legitimately has only `other`; Arabic legitimately has
 * all six.
 */

import { describe, expect, it } from "vitest";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "@/shared/i18n/locales";

const CATALOGS = import.meta.glob<{ default: Record<string, unknown> }>(
  "../../../src/shared/i18n/locales/*.json",
  { eager: true },
);

const PLURAL_CATEGORIES = new Set([
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
]);

const catalogFor = (locale: string): Record<string, unknown> => {
  const mod = CATALOGS[`../../../src/shared/i18n/locales/${locale}.json`];
  if (!mod) throw new Error(`no catalog file for locale "${locale}"`);
  return mod.default;
};

const isPluralNode = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    ([category, form]) =>
      PLURAL_CATEGORIES.has(category) && typeof form === "string",
  );
};

type Leaf = {
  path: string;
  kind: "string" | "array" | "plural";
  value: unknown;
};

const leaves = (node: unknown, prefix = "", out: Leaf[] = []): Leaf[] => {
  if (typeof node === "string") {
    out.push({ path: prefix, kind: "string", value: node });
    return out;
  }
  if (Array.isArray(node)) {
    out.push({ path: prefix, kind: "array", value: node });
    return out;
  }
  if (isPluralNode(node)) {
    out.push({ path: prefix, kind: "plural", value: node });
    return out;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, child] of Object.entries(
      node as Record<string, unknown>,
    )) {
      leaves(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
};

const leafMap = (catalog: Record<string, unknown>): Map<string, Leaf> =>
  new Map(leaves(catalog).map((leaf) => [leaf.path, leaf]));

/** Every `{placeholder}` a template expects, order-insensitive. */
const placeholders = (leaf: Leaf): Set<string> => {
  const templates: string[] =
    leaf.kind === "string"
      ? [leaf.value as string]
      : leaf.kind === "array"
        ? (leaf.value as unknown[]).filter(
            (item): item is string => typeof item === "string",
          )
        : Object.values(leaf.value as Record<string, string>);

  const found = new Set<string>();
  for (const template of templates) {
    for (const match of template.matchAll(/\{(\w+)\}/g)) {
      found.add(match[1]);
    }
  }
  return found;
};

const english = catalogFor(DEFAULT_LOCALE);
const englishLeaves = leafMap(english);
const otherLocales = SUPPORTED_LOCALES.filter(
  (locale) => locale !== DEFAULT_LOCALE,
);
const CLOUD_AUTHORITY_MEMORY_DESCRIPTION =
  "Include saved memories and your profile in Stella’s model context. The cloud copy is authoritative and encrypted in transit and at rest; Stella may also keep a local copy. Turning this off excludes memory from future turns but does not delete it.";
const CLOUD_HOME_PREFIX = "mobile.cloudHome.";
const MAX_CLOUD_HOME_ENGLISH_MATCHES = 8;

describe("i18n catalog parity", () => {
  it("ships exactly one catalog per supported locale, and no orphans", () => {
    const onDisk = Object.keys(CATALOGS)
      .map((path) =>
        path
          .split("/")
          .pop()
          ?.replace(/\.json$/, ""),
      )
      .filter((name): name is string => Boolean(name))
      .sort();
    expect(onDisk).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it("has a non-trivial English catalog to compare against", () => {
    // Cheap canary: if the glob or the leaf walker breaks, every other
    // assertion here passes vacuously.
    expect(englishLeaves.size).toBeGreaterThan(100);
  });

  it.each(otherLocales)("%s has no missing or extra keys", (locale) => {
    const translated = leafMap(catalogFor(locale));

    const missing = [...englishLeaves.keys()]
      .filter((path) => !translated.has(path))
      .sort();
    const extra = [...translated.keys()]
      .filter((path) => !englishLeaves.has(path))
      .sort();

    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it.each(otherLocales)("%s matches English leaf kinds", (locale) => {
    const translated = leafMap(catalogFor(locale));
    const mismatched = [...englishLeaves.entries()]
      .filter(([path, leaf]) => {
        const other = translated.get(path);
        return other && other.kind !== leaf.kind;
      })
      .map(
        ([path, leaf]) =>
          `${path}: en=${leaf.kind} ${locale}=${translated.get(path)?.kind}`,
      )
      .sort();

    expect(mismatched).toEqual([]);
  });

  it.each(SUPPORTED_LOCALES)(
    "%s preserves every interpolation placeholder",
    (locale) => {
      const translated = leafMap(catalogFor(locale));
      const broken: string[] = [];

      for (const [path, englishLeaf] of englishLeaves) {
        const leaf = translated.get(path);
        if (!leaf) continue; // key-set parity is asserted separately
        const expected = placeholders(englishLeaf);
        const actual = placeholders(leaf);

        const dropped = [...expected].filter((name) => !actual.has(name));
        const invented = [...actual].filter((name) => !expected.has(name));
        if (dropped.length || invented.length) {
          broken.push(
            `${path}: dropped=[${dropped.join(",")}] invented=[${invented.join(",")}]`,
          );
        }
      }

      expect(broken.sort()).toEqual([]);
    },
  );

  it.each(SUPPORTED_LOCALES)("%s has valid plural nodes", (locale) => {
    const translated = leafMap(catalogFor(locale));
    // The categories this language can actually produce. A form outside
    // this set is dead weight the runtime will never select.
    const usable = new Set([
      ...new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
      // `zero` is an allowed product-level override for count === 0 even
      // where CLDR does not emit it (see translatePlural).
      "zero",
    ]);

    const problems: string[] = [];
    for (const [path, leaf] of translated) {
      if (leaf.kind !== "plural") continue;
      const forms = leaf.value as Record<string, string>;

      if (typeof forms.other !== "string") {
        problems.push(`${path}: missing required "other" form`);
      }
      for (const category of Object.keys(forms)) {
        if (!usable.has(category)) {
          problems.push(
            `${path}: "${category}" is never selected for ${locale}`,
          );
        }
      }
      for (const [category, form] of Object.entries(forms)) {
        if (!form.trim()) problems.push(`${path}.${category} is empty`);
      }
    }

    expect(problems.sort()).toEqual([]);
  });

  it.each(SUPPORTED_LOCALES)("%s has no empty strings", (locale) => {
    const empty = [...leafMap(catalogFor(locale))]
      .filter(
        ([, leaf]) => leaf.kind === "string" && !(leaf.value as string).trim(),
      )
      .map(([path]) => path)
      .sort();
    expect(empty).toEqual([]);
  });

  it("pins the cloud-authority memory description in English", () => {
    expect(
      englishLeaves.get("settings.memory.description")?.value,
    ).toBe(CLOUD_AUTHORITY_MEMORY_DESCRIPTION);
  });

  it.each(otherLocales)(
    "%s localizes the cloud-authority memory description",
    (locale) => {
      const value = leafMap(catalogFor(locale)).get(
        "settings.memory.description",
      )?.value;

      expect(typeof value).toBe("string");
      expect(value).not.toBe(CLOUD_AUTHORITY_MEMORY_DESCRIPTION);
      expect((value as string).trim().length).toBeGreaterThan(40);
    },
  );

  it.each(otherLocales)(
    "%s does not ship the Cloud Home section as English filler",
    (locale) => {
      const translated = leafMap(catalogFor(locale));
      const cloudHomeLeaves = [...englishLeaves.entries()].filter(
        ([path, leaf]) =>
          path.startsWith(CLOUD_HOME_PREFIX) && leaf.kind === "string",
      );
      const exactEnglishMatches = cloudHomeLeaves
        .filter(
          ([path, englishLeaf]) =>
            translated.get(path)?.value === englishLeaf.value,
        )
        .map(([path]) => path)
        .sort();

      expect(cloudHomeLeaves).toHaveLength(53);
      expect(
        exactEnglishMatches.length,
        `English Cloud Home filler remains in ${locale}:\n${exactEnglishMatches.join("\n")}`,
      ).toBeLessThanOrEqual(MAX_CLOUD_HOME_ENGLISH_MATCHES);
    },
  );
});
