/**
 * Translation catalogs are JSON files keyed by locale. English (`en`) is
 * always bundled eagerly so the renderer has an immediate fallback even
 * before the active locale resolves; every other locale is loaded
 * lazily so we don't ship 27 catalogs in the initial bundle when the
 * user only ever sees one of them.
 *
 * Catalogs are nested objects:
 *
 *   { common: { continue: "Continue" }, settings: { tabs: { general: "General" } } }
 *
 * `t("settings.tabs.general")` walks the dot-notation path inside the
 * active catalog and falls back to the English catalog (and finally the
 * raw key) if the path is missing. Keep keys descriptive — they're the
 * developer-facing source of truth even when English copy ships untranslated.
 */

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

/**
 * Resolve `key` against `catalog` first, then English, then the key
 * itself. Interpolates `{name}` placeholders with `params`.
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
  if (catalog !== EAGER[DEFAULT_LOCALE]) {
    const fallback = lookupPath(EAGER[DEFAULT_LOCALE], key);
    if (typeof fallback === "string") {
      return params ? interpolate(fallback, params) : fallback;
    }
  }
  return key;
};

/**
 * CLDR plural categories, in the order `Intl.PluralRules` can emit them.
 * A pluralised catalog entry is an object keyed by these instead of a
 * bare string:
 *
 *   "newMessages": { "one": "{count} new message",
 *                    "other": "{count} new messages" }
 *
 * `other` is the only required category — every locale has it, and it is
 * what we fall back to when a translator hasn't supplied the narrower
 * form their language needs.
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

// `Intl.PluralRules` construction is not free and the same handful of
// locales are asked for over and over, so memoise per locale.
const pluralRulesCache = new Map<string, Intl.PluralRules>();

const pluralRulesFor = (locale: string): Intl.PluralRules | undefined => {
  const cached = pluralRulesCache.get(locale);
  if (cached) return cached;
  try {
    const rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
    return rules;
  } catch {
    // Unknown/unsupported tag — caller falls back to `other`.
    return undefined;
  }
};

const selectPluralForm = (
  forms: PluralForms,
  locale: string,
  count: number,
): string | undefined => {
  // `zero` is offered as an explicit override for count === 0 even in
  // locales whose CLDR rules never emit that category (English says
  // "other" for 0). Copy like "No unread messages" is a product
  // decision, not a grammatical one, so honour it when present.
  if (count === 0 && typeof forms.zero === "string") return forms.zero;

  const category = pluralRulesFor(locale)?.select(count);
  if (category) {
    const exact = forms[category as PluralCategory];
    if (typeof exact === "string") return exact;
  }
  return forms.other;
};

/**
 * Resolve a pluralised key against `catalog` using `locale`'s CLDR
 * plural rules, then English, then the key itself. `count` is
 * interpolated as `{count}` on top of any `params`, so callers don't
 * have to pass it twice.
 *
 * Never hand-roll `n === 1 ? "item" : "items"` — that is only correct
 * for English and a handful of its relatives. Languages in the catalog
 * need up to four distinct forms (Arabic, Polish, Russian, Czech,
 * Romanian, Hebrew, Welsh-style rules), and CJK/Thai/Vietnamese need
 * exactly one.
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
  // Tolerate a key that was authored as a plain string (or has not been
  // pluralised in this locale yet) rather than rendering the raw key.
  if (typeof value === "string") return interpolate(value, withCount);

  if (catalog !== EAGER[DEFAULT_LOCALE]) {
    const fallback = lookupPath(EAGER[DEFAULT_LOCALE], key);
    if (isPluralForms(fallback)) {
      // English rules, because the English copy is what we're rendering.
      const form = selectPluralForm(fallback, DEFAULT_LOCALE, count);
      if (typeof form === "string") return interpolate(form, withCount);
    }
    if (typeof fallback === "string") return interpolate(fallback, withCount);
  }
  return key;
};

/**
 * Resolve a key whose value is an array of strings (e.g. plan feature
 * lists). Falls back to English when the active catalog hasn't translated
 * the array yet.
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
