import { createContext, useCallback, useContext, useEffect, useMemo, useState, } from "react";
import { getEagerCatalog, loadCatalog, translate, translateArray, } from "./catalogs";
import { uiState } from "@/platform/ui-state";
import { DEFAULT_LOCALE, isRtlLocale, isSupportedLocale, LOCALE_STORAGE_KEY, localeDir, resolveBestLocale, SUPPORTED_LOCALES, } from "./locales";
const I18nContext = createContext(null);
const readPersistedLocale = () => {
    if (typeof window === "undefined")
        return null;
    const stored = uiState.getItem(LOCALE_STORAGE_KEY);
    return isSupportedLocale(stored) ? stored : null;
};
const writePersistedLocale = (locale) => {
    if (typeof window === "undefined")
        return;
    uiState.setItem(LOCALE_STORAGE_KEY, locale);
};
const navigatorLanguages = () => {
    if (typeof navigator === "undefined")
        return [];
    const list = [];
    const languages = navigator.languages;
    if (Array.isArray(languages)) {
        list.push(...languages);
    }
    if (typeof navigator.language === "string") {
        list.push(navigator.language);
    }
    return list;
};
const initialLocale = () => resolveBestLocale([readPersistedLocale(), ...navigatorLanguages()]);
const applyDocumentLocale = (locale) => {
    if (typeof document === "undefined")
        return;
    const root = document.documentElement;
    root.setAttribute("lang", locale);
    root.setAttribute("dir", localeDir(locale));
    root.dataset.stellaLocale = locale;
    root.dataset.stellaTextDir = localeDir(locale);
};
export function I18nProviderBase({ children, remotePreference, persistRemoteLocale, }) {
    const [locale, setLocaleState] = useState(initialLocale);
    const [catalog, setCatalog] = useState(() => getEagerCatalog(locale));
    // Keep <html lang/dir> in lockstep with the active locale so platform
    // affordances (form inputs, native context menus, browser hyphenation)
    // pick up the right script direction.
    useEffect(() => {
        applyDocumentLocale(locale);
    }, [locale]);
    // Lazily fetch the active locale's JSON. English is bundled eagerly.
    useEffect(() => {
        let cancelled = false;
        void loadCatalog(locale).then((next) => {
            if (cancelled)
                return;
            setCatalog(next);
        });
        return () => {
            cancelled = true;
        };
    }, [locale]);
    // Stay in sync across renderer windows on the same device.
    useEffect(() => {
        if (typeof window === "undefined")
            return;
        const handler = (event) => {
            if (event.key !== LOCALE_STORAGE_KEY || !event.newValue)
                return;
            if (!isSupportedLocale(event.newValue))
                return;
            if (event.newValue === locale)
                return;
            setLocaleState(event.newValue);
        };
        window.addEventListener("storage", handler);
        return () => window.removeEventListener("storage", handler);
    }, [locale]);
    // Pull the user's stored locale from Convex when signed in. Treats
    // the renderer-local UI-state value as an instant cache, then
    // upgrades once the server replies. The Convex query is the
    // external state we're syncing with — setting state in this effect
    // is exactly the "subscribe + setState" shape the lint rule
    // exempts.
    useEffect(() => {
        if (remotePreference === undefined)
            return;
        if (!remotePreference)
            return;
        if (typeof remotePreference !== "string")
            return;
        if (!isSupportedLocale(remotePreference))
            return;
        if (remotePreference === locale)
            return;
        setLocaleState(remotePreference);
        writePersistedLocale(remotePreference);
    }, [remotePreference, locale]);
    const setLocale = useCallback((next) => {
        if (!isSupportedLocale(next))
            return;
        setLocaleState(next);
        writePersistedLocale(next);
        // Best-effort remote sync; signed-out/local-only surfaces just keep the
        // shared-UI-state value.
        void Promise.resolve(persistRemoteLocale?.(next)).catch(() => {
            /* signed-out / network — preference still lives locally */
        });
    }, [persistRemoteLocale]);
    const t = useCallback((key, params) => translate(catalog, key, params), [catalog]);
    const tArray = useCallback((key, params) => translateArray(catalog, key, params), [catalog]);
    const value = useMemo(() => ({
        locale,
        isRTL: isRtlLocale(locale),
        setLocale,
        t,
        tArray,
        supportedLocales: SUPPORTED_LOCALES,
    }), [locale, setLocale, t, tArray]);
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function LocalI18nProvider({ children }) {
    return <I18nProviderBase>{children}</I18nProviderBase>;
}
export function useI18n() {
    const ctx = useContext(I18nContext);
    if (!ctx) {
        throw new Error("useI18n must be used inside an <I18nProvider>");
    }
    return ctx;
}
export function useT() {
    return useI18n().t;
}
export function useLocale() {
    return useI18n().locale;
}
const FALLBACK = {
    locale: DEFAULT_LOCALE,
    isRTL: false,
    setLocale: () => {
        /* no-op — provider missing */
    },
    t: (key, params) => translate(getEagerCatalog(DEFAULT_LOCALE), key, params),
    tArray: (key, params) => translateArray(getEagerCatalog(DEFAULT_LOCALE), key, params),
    supportedLocales: SUPPORTED_LOCALES,
};
/**
 * Static accessor for environments without a React tree (e.g. tests,
 * non-React modules). Always reads from the English fallback catalog.
 */
export const i18nFallback = FALLBACK;
