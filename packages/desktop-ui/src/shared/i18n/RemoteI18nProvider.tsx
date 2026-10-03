import { useCallback } from "react";
import { useAuthBootstrapState } from "@/global/auth/BackendAuthProvider";
import { backendClient } from "@/platform/backend/backend-client";
import { useBackendValue } from "@/platform/backend/use-backend-view";
import {
  I18nProviderBase,
  type I18nProviderProps,
} from "./I18nProvider";
import type { Locale } from "./locales";

type PersistRemoteLocale = (locale: Locale) => void | Promise<unknown>;

export function I18nProvider({ children }: I18nProviderProps) {
  // Gate the remote locale subscription until runtime auth resolves so it does
  // not register against an unauthenticated client and churn on first paint.
  // The local locale (shared UI state + navigator) still renders first via
  // `I18nProviderBase`; the remote value is purely an override applied once it
  // resolves, and `undefined` (skip) leaves the local value in place.
  const { runtimeAuthReady } = useAuthBootstrapState();
  const preferences = useBackendValue(
    "preferences.get",
    runtimeAuthReady ? {} : "skip",
  );
  const persistRemoteLocale = useCallback<PersistRemoteLocale>(
    (locale) => backendClient.call("preferences.set", { locale }),
    [],
  );

  return (
    <I18nProviderBase
      remotePreference={preferences?.locale}
      persistRemoteLocale={persistRemoteLocale}
    >
      {children}
    </I18nProviderBase>
  );
}
