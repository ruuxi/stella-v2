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

  locale: Locale;

  isRTL: boolean;

  setLocale: (locale: Locale) => void;

  localeChangeReloads: (next: Locale) => boolean;

  t: (key: string, params?: TranslateParams) => string;

  tArray: (key: string, params?: TranslateParams) => string[];

  tPlural: (key: string, count: number, params?: TranslateParams) => string;

  supportedLocales: readonly Locale[];
};

const I18nContext = createContext<I18nContextValue | null>(null);

const initialLocale = (): Locale => resolveBestLocale(deviceLanguageTags());

export interface I18nProviderProps {
  children: ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [catalog, setCatalog] = useState<Catalog>(() => getEnglishCatalog());

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

  useEffect(() => {
    syncLayoutDirection(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    if (!isSupportedLocale(next)) return;
    setLocaleState(next);
    void AsyncStorage.setItem(LOCALE_STORAGE_KEY, next).catch(() => undefined);

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

export const i18nFallback = FALLBACK;
