/**
 * Main-process translations for OS-owned surfaces — tray menu, native
 * dialogs, notifications. The renderer has its own i18n (React context +
 * `import.meta.glob` catalog loading); neither of those works here, so this
 * module re-implements the *same* lookup semantics against the *same* JSON
 * catalogs:
 *
 *   - dot-path key (`desktop.tray.openStella`) walked through a nested object
 *   - `{name}` placeholders interpolated from `params`
 *   - miss in the active catalog falls back to English, then the raw key
 *
 * Catalog files are read from `<compiled electron dir>/i18n-locales/`. The
 * renderer's `src/` tree is not part of a packaged build (electron-builder
 * only ships `dist-electron/electron/**` plus the renderer's *built* output),
 * so `dev-electron-build.mjs` copies `desktop-ui/src/shared/i18n/locales/`
 * there alongside the bundles — the same pattern `copyPackagedRuntimeAssets`
 * already uses for main-process static assets. That directory sits inside
 * `app.asar` in a packaged build, which `fs.readFileSync` reads transparently.
 * The renderer source directory is kept as a second candidate so a tree that
 * has bundles but no copied catalogs still resolves in dev.
 *
 * The active locale is owned by the renderer and persisted in the shared UI
 * state store (`~/.stella/ui-state.json`, key `stella:locale`), which the main
 * process already owns via `registerUiStateKvHandlers`. `bindUiStateLocale`
 * seeds the locale from that store and every subsequent write flows through
 * `applyUiStateLocaleChanges`, so a language switch reaches the tray without a
 * restart.
 */

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

/** Directories searched, in order, for `<locale>.json`. */
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

/** The locale main-process surfaces are currently rendering in. */
export const getMainLocale = (): Locale => activeLocale;

/**
 * Resolve `key` against `locale`, then English, then the key itself.
 * Interpolates `{name}` placeholders with `params`.
 */
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

/** Translate `key` in the active locale. */
export const t = (key: string, params?: MainTranslateParams): string =>
  translateForLocale(activeLocale, key, params);

/**
 * Subscribe to locale changes. Long-lived native surfaces (the tray menu)
 * rebuild from here so switching language takes effect immediately instead of
 * staying stale until the next launch.
 */
export const onMainLocaleChanged = (
  listener: (locale: Locale) => void,
): (() => void) => {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
};

/**
 * Adopt `candidate` as the active locale. Unsupported/missing values fall
 * back to English. No-ops (and notifies nobody) when the locale is unchanged.
 */
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

/** Seed the active locale from the shared UI state store's current value. */
export const bindUiStateLocale = (source: {
  get: (key: string) => string | null;
}): void => {
  setMainLocale(source.get(LOCALE_STORAGE_KEY));
};

/**
 * React to a shared-UI-state change batch. Called for every applied batch
 * (renderer write, clear, or another host's write) so the main process tracks
 * the renderer's language picker in real time.
 */
export const applyUiStateLocaleChanges = (
  changes: UiStateLocaleChanges,
): void => {
  if (!Object.hasOwn(changes, LOCALE_STORAGE_KEY)) return;
  setMainLocale(changes[LOCALE_STORAGE_KEY]);
};
