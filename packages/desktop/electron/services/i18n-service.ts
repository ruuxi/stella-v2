import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  LOCALE_STORAGE_KEY,
  type Locale,
} from "../../../desktop-ui/src/shared/i18n/locales.js";

export type MainCatalog = Record<string, unknown>;
export type MainTranslateParams = Record<string, string | number>;

const catalogDirCandidates = (): string[] => [
  path.join(__dirname, "i18n-locales"),
  path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "desktop-ui",
    "src",
    "shared",
    "i18n",
    "locales",
  ),
];

const catalogCache = new Map<Locale, MainCatalog>();

const readCatalogFile = (locale: Locale): MainCatalog => {
  for (const dir of catalogDirCandidates()) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, `${locale}.json`), "utf-8");
    } catch {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as MainCatalog;
      }
    } catch (error) {
      console.warn(
        `[i18n] Malformed catalog for "${locale}":`,
        (error as Error).message,
      );
    }
  }
  return {};
};

const catalogFor = (locale: Locale): MainCatalog => {
  const cached = catalogCache.get(locale);
  if (cached) return cached;
  const loaded = readCatalogFile(locale);
  catalogCache.set(locale, loaded);
  return loaded;
};

const lookupPath = (catalog: MainCatalog, key: string): unknown => {
  let cursor: unknown = catalog;
  for (const segment of key.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
    if (cursor === undefined) return undefined;
  }
  return cursor;
};

const interpolate = (template: string, params: MainTranslateParams): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });

let activeLocale: Locale = DEFAULT_LOCALE;

const localeListeners = new Set<(locale: Locale) => void>();

export const getMainLocale = (): Locale => activeLocale;

export const translateForLocale = (
  locale: Locale,
  key: string,
  params?: MainTranslateParams,
): string => {
  const value = lookupPath(catalogFor(locale), key);
  if (typeof value === "string") {
    return params ? interpolate(value, params) : value;
  }
  if (locale !== DEFAULT_LOCALE) {
    const fallback = lookupPath(catalogFor(DEFAULT_LOCALE), key);
    if (typeof fallback === "string") {
      return params ? interpolate(fallback, params) : fallback;
    }
  }
  return key;
};

export const t = (key: string, params?: MainTranslateParams): string =>
  translateForLocale(activeLocale, key, params);

export const onMainLocaleChanged = (
  listener: (locale: Locale) => void,
): (() => void) => {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
};

export const setMainLocale = (candidate: string | null | undefined): void => {
  const next = isSupportedLocale(candidate) ? candidate : DEFAULT_LOCALE;
  if (next === activeLocale) return;
  activeLocale = next;
  for (const listener of localeListeners) {
    try {
      listener(next);
    } catch (error) {
      console.warn("[i18n] Locale listener failed:", (error as Error).message);
    }
  }
};

type UiStateLocaleChanges = Record<string, string | null>;

export const bindUiStateLocale = (source: {
  get: (key: string) => string | null;
}): void => {
  setMainLocale(source.get(LOCALE_STORAGE_KEY));
};

export const applyUiStateLocaleChanges = (
  changes: UiStateLocaleChanges,
): void => {
  if (!Object.hasOwn(changes, LOCALE_STORAGE_KEY)) return;
  setMainLocale(changes[LOCALE_STORAGE_KEY]);
};
