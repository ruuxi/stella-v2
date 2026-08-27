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
        if (!leaf) continue;
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

    const usable = new Set([
      ...new Intl.PluralRules(locale).resolvedOptions().pluralCategories,

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
});
