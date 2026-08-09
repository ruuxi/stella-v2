/**
 * Mobile translation runtime.
 *
 * This is a deliberate mirror of
 * `packages/desktop-ui/src/shared/i18n/catalogs.ts`: same nested-object
 * catalogs, same dot-path lookup, same `{name}` interpolation, same
 * English-then-raw-key fallback chain, and the same CLDR plural handling
 * via `Intl.PluralRules`. A key means exactly the same thing on both
 * platforms, so `t("mobile.account.title")` resolves identically.
 *
 * The ONLY difference is how a catalog is obtained. The desktop uses
 * Vite's `import.meta.glob`, which Metro does not have — mobile reads from
 * the generated static require registry instead (see
 * `scripts/sync-i18n-catalogs.mjs`).
 */

import { CATALOG_LOADERS } from "./catalog-registry.generated";
import type { Catalog } from "./catalog-types";
import { DEFAULT_LOCALE, type Locale } from "./locales";

export type { Catalog };

// A JSON `require` may hand back either the object itself or an ES-module
// namespace with the object on `.default`, depending on how the bundle was
// transformed. Normalise both.
const unwrap = (mod: unknown): Catalog => {
  if (mod && typeof mod === "object" && "default" in (mod as object)) {
    const inner = (mod as { default: unknown }).default;
    if (inner && typeof inner === "object") return inner as Catalog;
  }
  return (mod ?? {}) as Catalog;
};

const catalogCache = new Map<Locale, Catalog>();

const readCatalog = (locale: Locale): Catalog => {
  const cached = catalogCache.get(locale);
  if (cached) return cached;
  const loader = CATALOG_LOADERS[locale];
  if (!loader) return getEnglishCatalog();
  let catalog: Catalog;
  try {
    catalog = unwrap(loader());
  } catch {
    catalog = getEnglishCatalog();
  }
  catalogCache.set(locale, catalog);
  return catalog;
};

/**
 * English is the fallback for every lookup, so it is loaded on first use and
 * then held for the life of the process.
 */
export const getEnglishCatalog = (): Catalog => {
  const cached = catalogCache.get(DEFAULT_LOCALE);
  if (cached) return cached;
  const loader = CATALOG_LOADERS[DEFAULT_LOCALE];
  const catalog = loader ? unwrap(loader()) : {};
  catalogCache.set(DEFAULT_LOCALE, catalog);
  return catalog;
};

export const getCatalog = (locale: Locale): Catalog => readCatalog(locale);

/**
 * Catalogs are plain JSON and `require` is synchronous under Metro, so
 * there is nothing to await — but the async shape matches the desktop
 * provider's contract and keeps the parse off the very first render.
 */
export const loadCatalog = (locale: Locale): Promise<Catalog> =>
  Promise.resolve(readCatalog(locale));

const lookupPath = (catalog: Catalog | undefined, key: string): unknown => {
  if (!catalog) return undefined;
  let cursor: unknown = catalog;
  for (const segment of key.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
    if (cursor === undefined) return undefined;
  }
  return cursor;
};

export type TranslateParams = Record<string, string | number>;

const interpolate = (template: string, params: TranslateParams): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });

/**
 * Resolve `key` against `catalog` first, then English, then the key itself.
 * Interpolates `{name}` placeholders with `params`.
 */
export const translate = (
  catalog: Catalog | undefined,
  key: string,
  params?: TranslateParams,
): string => {
  const value = lookupPath(catalog, key);
  if (typeof value === "string") {
    return params ? interpolate(value, params) : value;
  }
  const english = getEnglishCatalog();
  if (catalog !== english) {
    const fallback = lookupPath(english, key);
    if (typeof fallback === "string") {
      return params ? interpolate(fallback, params) : fallback;
    }
  }
  return key;
};

/**
 * CLDR plural categories, in the order `Intl.PluralRules` can emit them.
 * A pluralised catalog entry is an object keyed by these instead of a bare
 * string:
 *
 *   "lineCount": { "one": "{count} line", "other": "{count} lines" }
 *
 * `other` is the only required category.
 */
const PLURAL_CATEGORIES = [
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
] as const;

type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

type PluralForms = Partial<Record<PluralCategory, string>>;

const isPluralForms = (value: unknown): value is PluralForms => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    ([category, form]) =>
      (PLURAL_CATEGORIES as ReadonlyArray<string>).includes(category) &&
      typeof form === "string",
  );
};

const pluralRulesCache = new Map<string, Intl.PluralRules | null>();

const pluralRulesFor = (locale: string): Intl.PluralRules | undefined => {
  const cached = pluralRulesCache.get(locale);
  if (cached !== undefined) return cached ?? undefined;
  try {
    // Hermes ships `Intl.PluralRules` on both platforms; older engines (and
    // JSC without ICU) may not, hence the guard + null memo.
    if (typeof Intl === "undefined" || typeof Intl.PluralRules !== "function") {
      pluralRulesCache.set(locale, null);
      return undefined;
    }
    const rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
    return rules;
  } catch {
    pluralRulesCache.set(locale, null);
    return undefined;
  }
};

const selectPluralForm = (
  forms: PluralForms,
  locale: string,
  count: number,
): string | undefined => {
  // `zero` is an explicit product override for count === 0 even where CLDR
  // never emits that category (English says "other" for 0).
  if (count === 0 && typeof forms.zero === "string") return forms.zero;

  const category = pluralRulesFor(locale)?.select(count);
  if (category) {
    const exact = forms[category as PluralCategory];
    if (typeof exact === "string") return exact;
  }
  return forms.other;
};

/**
 * Resolve a pluralised key using `locale`'s CLDR plural rules, then English,
 * then the key itself. `count` is interpolated as `{count}` on top of
 * `params`.
 *
 * Never hand-roll `n === 1 ? "item" : "items"` — that is only correct for
 * English and its close relatives.
 */
export const translatePlural = (
  catalog: Catalog | undefined,
  locale: string,
  key: string,
  count: number,
  params?: TranslateParams,
): string => {
  const withCount: TranslateParams = { ...params, count };

  const value = lookupPath(catalog, key);
  if (isPluralForms(value)) {
    const form = selectPluralForm(value, locale, count);
    if (typeof form === "string") return interpolate(form, withCount);
  }
  // Tolerate a key authored as a plain string rather than rendering the key.
  if (typeof value === "string") return interpolate(value, withCount);

  const english = getEnglishCatalog();
  if (catalog !== english) {
    const fallback = lookupPath(english, key);
    if (isPluralForms(fallback)) {
      // English rules, because English copy is what we're rendering.
      const form = selectPluralForm(fallback, DEFAULT_LOCALE, count);
      if (typeof form === "string") return interpolate(form, withCount);
    }
    if (typeof fallback === "string") return interpolate(fallback, withCount);
  }
  return key;
};

/**
 * Resolve a key whose value is an array of strings. Falls back to English,
 * then an empty array.
 */
export const translateArray = (
  catalog: Catalog | undefined,
  key: string,
  params?: TranslateParams,
): string[] => {
  const value = lookupPath(catalog, key);
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => (params ? interpolate(item, params) : item));
  }
  const english = getEnglishCatalog();
  if (catalog !== english) {
    const fallback = lookupPath(english, key);
    if (Array.isArray(fallback)) {
      return fallback
        .filter((item): item is string => typeof item === "string")
        .map((item) => (params ? interpolate(item, params) : item));
    }
  }
  return [];
};
