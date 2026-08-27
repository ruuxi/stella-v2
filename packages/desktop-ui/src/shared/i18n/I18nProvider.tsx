import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  type Catalog,
  getEagerCatalog,
  loadCatalog,
  translate,
  translateArray,
  translatePlural,
  type TranslateParams,
} from "./catalogs";
import { uiState } from "@/platform/ui-state";
import {
  DEFAULT_LOCALE,
  isRtlLocale,
  isSupportedLocale,
  LOCALE_STORAGE_KEY,
  type Locale,
  localeDir,
  resolveBestLocale,
  SUPPORTED_LOCALES,
} from "./locales";

type I18nContextValue = {

  locale: Locale;

  isRTL: boolean;

  setLocale: (locale: Locale) => void;

  t: (key: string, params?: TranslateParams) => string;

  tArray: (key: string, params?: TranslateParams) => string[];

  tPlural: (key: string, count: number, params?: TranslateParams) => string;

  supportedLocales: ReadonlyArray<Locale>;
};

const I18nContext = createContext<I18nContextValue | null>(null);

const readPersistedLocale = (): Locale | null => {
  if (typeof window === "undefined") return null;
  const stored = uiState.getItem(LOCALE_STORAGE_KEY);
  return isSupportedLocale(stored) ? stored : null;
};

const writePersistedLocale = (locale: Locale) => {
  if (typeof window === "undefined") return;
  uiState.setItem(LOCALE_STORAGE_KEY, locale);
};

const navigatorLanguages = (): string[] => {
  if (typeof navigator === "undefined") return [];
  const list: string[] = [];
  const languages = navigator.languages;
  if (Array.isArray(languages)) {
    list.push(...languages);
  }
  if (typeof navigator.language === "string") {
    list.push(navigator.language);
  }
  return list;
};

const initialLocale = (): Locale =>
  resolveBestLocale([readPersistedLocale(), ...navigatorLanguages()]);

const applyDocumentLocale = (locale: Locale) => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("lang", locale);
  root.setAttribute("dir", localeDir(locale));
  root.dataset.stellaLocale = locale;
  root.dataset.stellaTextDir = localeDir(locale);
};

export interface I18nProviderProps {
  children: ReactNode;
}

type PersistRemoteLocale = (locale: Locale) => void | Promise<unknown>;

export interface I18nProviderBaseProps extends I18nProviderProps {
  remotePreference?: unknown;
  persistRemoteLocale?: PersistRemoteLocale;
}

export function I18nProviderBase({
  children,
  remotePreference,
  persistRemoteLocale,
}: I18nProviderBaseProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [catalog, setCatalog] = useState<Catalog | undefined>(() =>
    getEagerCatalog(locale),
  );

  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);

  useEffect(() => {
    let cancelled = false;
    void loadCatalog(locale).then((next) => {
      if (cancelled) return;
      setCatalog(next);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: StorageEvent) => {
      if (event.key !== LOCALE_STORAGE_KEY || !event.newValue) return;
      if (!isSupportedLocale(event.newValue)) return;
      if (event.newValue === locale) return;
      setLocaleState(event.newValue);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [locale]);

  useEffect(() => {
    if (remotePreference === undefined) return;
    if (!remotePreference) return;
    if (typeof remotePreference !== "string") return;
    if (!isSupportedLocale(remotePreference)) return;
    if (remotePreference === locale) return;
    setLocaleState(remotePreference);
    writePersistedLocale(remotePreference);
  }, [remotePreference, locale]);

  const setLocale = useCallback(
    (next: Locale) => {
      if (!isSupportedLocale(next)) return;
      setLocaleState(next);
      writePersistedLocale(next);

      void Promise.resolve(persistRemoteLocale?.(next)).catch(() => {

      });
    },
    [persistRemoteLocale],
  );

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
      t,
      tArray,
      tPlural,
      supportedLocales: SUPPORTED_LOCALES,
    }),
    [locale, setLocale, t, tArray, tPlural],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function LocalI18nProvider({ children }: I18nProviderProps) {
  return <I18nProviderBase>{children}</I18nProviderBase>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used inside an <I18nProvider>");
  }
  return ctx;
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

const FALLBACK: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  isRTL: false,
  setLocale: () => {

  },
  t: (key, params) => translate(getEagerCatalog(DEFAULT_LOCALE), key, params),
  tArray: (key, params) =>
    translateArray(getEagerCatalog(DEFAULT_LOCALE), key, params),
  tPlural: (key, count, params) =>
    translatePlural(
      getEagerCatalog(DEFAULT_LOCALE),
      DEFAULT_LOCALE,
      key,
      count,
      params,
    ),
  supportedLocales: SUPPORTED_LOCALES,
};

export const i18nFallback = FALLBACK;
