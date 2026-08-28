import { CATALOG_LOADERS } from "./catalog-registry.generated";
import type { Catalog } from "./catalog-types";
import { DEFAULT_LOCALE, type Locale } from "./locales";

export type { Catalog };

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

export const getEnglishCatalog = (): Catalog => {
  const cached = catalogCache.get(DEFAULT_LOCALE);
  if (cached) return cached;
  const loader = CATALOG_LOADERS[DEFAULT_LOCALE];
  const catalog = loader ? unwrap(loader()) : {};
  catalogCache.set(DEFAULT_LOCALE, catalog);
  return catalog;
};

export const getCatalog = (locale: Locale): Catalog => readCatalog(locale);

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
      (PLURAL_CATEGORIES as readonly string[]).includes(category) &&
      typeof form === "string",
  );
};

const pluralRulesCache = new Map<string, Intl.PluralRules | null>();

const pluralRulesFor = (locale: string): Intl.PluralRules | undefined => {
  const cached = pluralRulesCache.get(locale);
  if (cached !== undefined) return cached ?? undefined;
  try {

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

  if (count === 0 && typeof forms.zero === "string") return forms.zero;

  const category = pluralRulesFor(locale)?.select(count);
  if (category) {
    const exact = forms[category as PluralCategory];
    if (typeof exact === "string") return exact;
  }
  return forms.other;
};

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

  if (typeof value === "string") return interpolate(value, withCount);

  const english = getEnglishCatalog();
  if (catalog !== english) {
    const fallback = lookupPath(english, key);
    if (isPluralForms(fallback)) {

      const form = selectPluralForm(fallback, DEFAULT_LOCALE, count);
      if (typeof form === "string") return interpolate(form, withCount);
    }
    if (typeof fallback === "string") return interpolate(fallback, withCount);
  }
  return key;
};

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
