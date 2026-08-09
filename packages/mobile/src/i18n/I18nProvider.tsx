/**
 * Mobile i18n provider. Same surface as the desktop's `I18nProvider`
 * (`t`, `tArray`, `tPlural`, `locale`, `isRTL`, `setLocale`) so a component
 * ported between platforms needs no rewrite.
 *
 * Differences forced by the platform:
 *   - persistence is AsyncStorage, not the renderer's UI-state store (same
 *     key, `stella:locale`, so it stays conceptually one preference);
 *   - the device hint comes from `deviceLanguageTags()` rather than
 *     `navigator.languages`;
 *   - `setLocale` may need an app reload for RTL — see `./rtl`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  type Catalog,
  getCatalog,
  getEnglishCatalog,
  translate,
  translateArray,
  translatePlural,
  type TranslateParams,
} from "./catalogs";
import { deviceLanguageTags } from "./device-locale";
import {
  DEFAULT_LOCALE,
  isRtlLocale,
  isSupportedLocale,
  LOCALE_STORAGE_KEY,
  type Locale,
  resolveBestLocale,
  SUPPORTED_LOCALES,
} from "./locales";
import { applyLayoutDirection, needsDirectionFlip, syncLayoutDirection } from "./rtl";

type I18nContextValue = {
  /** Currently active locale (BCP-47). */
  locale: Locale;
  /** True when the active locale renders right-to-left. */
  isRTL: boolean;
  /**
   * Update the locale. Persists immediately. Switching between an LTR and
   * an RTL locale flips the native layout direction, which React Native can
   * only apply after an app reload — `setLocale` performs that reload.
   * Check `localeChangeReloads(next)` first if you need to warn the user.
   */
  setLocale: (locale: Locale) => void;
  /** True when moving to `next` will reload the app to flip RTL/LTR. */
  localeChangeReloads: (next: Locale) => boolean;
  /** Translate a dotted key. Falls back to English, then the raw key. */
  t: (key: string, params?: TranslateParams) => string;
  /** Resolve an array-valued key. Falls back to English, then `[]`. */
  tArray: (key: string, params?: TranslateParams) => string[];
  /**
   * Resolve a pluralised key against the active locale's CLDR plural rules.
   * `count` is interpolated as `{count}` automatically.
   */
  tPlural: (key: string, count: number, params?: TranslateParams) => string;
  /** All supported locales — handy for picker rendering. */
  supportedLocales: ReadonlyArray<Locale>;
};

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Synchronous best guess from the device alone. The persisted override is
 * async on this platform, so it is applied a tick later; English is bundled
 * and every catalog resolves through it, so the first frame is never blank.
 */
const initialLocale = (): Locale => resolveBestLocale(deviceLanguageTags());

export interface I18nProviderProps {
  children: ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [catalog, setCatalog] = useState<Catalog>(() => getEnglishCatalog());

  // Apply the persisted override once storage answers. Reading external
  // state and setting it is the subscribe-then-setState shape.
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(LOCALE_STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (isSupportedLocale(stored)) setLocaleState(stored);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setCatalog(getCatalog(locale));
  }, [locale]);

  // Keep the native layout direction aligned on launch (and after an OTA
  // that changed the stored locale). No-op when it already matches.
  useEffect(() => {
    syncLayoutDirection(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    if (!isSupportedLocale(next)) return;
    setLocaleState(next);
    void AsyncStorage.setItem(LOCALE_STORAGE_KEY, next).catch(() => undefined);
    // Persist first, then flip: the reload re-reads the stored value.
    void applyLayoutDirection(next);
  }, []);

  const t = useCallback(
    (key: string, params?: TranslateParams) => translate(catalog, key, params),
    [catalog],
  );

  const tArray = useCallback(
    (key: string, params?: TranslateParams) =>
      translateArray(catalog, key, params),
    [catalog],
  );

  const tPlural = useCallback(
    (key: string, count: number, params?: TranslateParams) =>
      translatePlural(catalog, locale, key, count, params),
    [catalog, locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      isRTL: isRtlLocale(locale),
      setLocale,
      localeChangeReloads: needsDirectionFlip,
      t,
      tArray,
      tPlural,
      supportedLocales: SUPPORTED_LOCALES,
    }),
    [locale, setLocale, t, tArray, tPlural],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

const FALLBACK: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  isRTL: false,
  setLocale: () => {
    /* no-op — provider missing */
  },
  localeChangeReloads: () => false,
  t: (key, params) => translate(getEnglishCatalog(), key, params),
  tArray: (key, params) => translateArray(getEnglishCatalog(), key, params),
  tPlural: (key, count, params) =>
    translatePlural(
      getEnglishCatalog(),
      DEFAULT_LOCALE,
      key,
      count,
      params,
    ),
  supportedLocales: SUPPORTED_LOCALES,
};

/**
 * Reading i18n outside the provider falls back to English rather than
 * throwing. On mobile the alternative is a fatal render error in release
 * (see the boot-crash ErrorBoundary in `app/_layout.tsx`), and untranslated
 * English is strictly better than a dead app.
 */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext) ?? FALLBACK;
}

export function useT() {
  return useI18n().t;
}

export function useTPlural() {
  return useI18n().tPlural;
}

export function useLocale(): Locale {
  return useI18n().locale;
}

/**
 * Static accessor for non-React modules (helpers, tests). Always English.
 */
export const i18nFallback = FALLBACK;
