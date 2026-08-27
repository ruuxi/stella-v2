import { DEFAULT_LOCALE, type Locale } from "./locales";
import enCatalog from "./locales/en.json";

export type Catalog = Record<string, unknown>;

const EAGER: Record<Locale, Catalog | undefined> = {
  en: enCatalog as Catalog,
} as Record<Locale, Catalog | undefined>;

const LAZY_LOADERS = import.meta.glob<{ default: Catalog }>(
  "./locales/*.json",
);

const loaderForLocale = (locale: Locale) =>
  LAZY_LOADERS[`./locales/${locale}.json`];

const loadCache = new Map<Locale, Promise<Catalog>>();

export const loadCatalog = (locale: Locale): Promise<Catalog> => {
  const eager = EAGER[locale];
  if (eager) return Promise.resolve(eager);

  const cached = loadCache.get(locale);
  if (cached) return cached;

  const loader = loaderForLocale(locale);
  if (!loader) {
    return Promise.resolve(EAGER.en ?? {});
  }

  const promise = loader()
    .then((mod) => mod.default ?? {})
    .catch(() => EAGER.en ?? {});
  loadCache.set(locale, promise);
  return promise;
};

export const getEagerCatalog = (locale: Locale): Catalog | undefined =>
  EAGER[locale];

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
  template.replace(/\{(\w+)\}/g, (match, name) => {
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
  if (catalog !== EAGER[DEFAULT_LOCALE]) {
    const fallback = lookupPath(EAGER[DEFAULT_LOCALE], key);
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
      (PLURAL_CATEGORIES as ReadonlyArray<string>).includes(category) &&
      typeof form === "string",
  );
};

const pluralRulesCache = new Map<string, Intl.PluralRules>();

const pluralRulesFor = (locale: string): Intl.PluralRules | undefined => {
  const cached = pluralRulesCache.get(locale);
  if (cached) return cached;
  try {
    const rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
    return rules;
  } catch {

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

  if (catalog !== EAGER[DEFAULT_LOCALE]) {
    const fallback = lookupPath(EAGER[DEFAULT_LOCALE], key);
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
  if (catalog !== EAGER[DEFAULT_LOCALE]) {
    const fallback = lookupPath(EAGER[DEFAULT_LOCALE], key);
    if (Array.isArray(fallback)) {
      return fallback
        .filter((item): item is string => typeof item === "string")
        .map((item) => (params ? interpolate(item, params) : item));
    }
  }
  return [];
};
