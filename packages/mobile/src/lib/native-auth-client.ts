import type {
  BetterFetch,
  BetterFetchPlugin,
  SuccessContext,
} from "@better-fetch/fetch";
import type { ClientStore } from "better-auth/client";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { verifyOneTimeToken } from "./verify-one-time-token";

export const MOBILE_SESSION_TOKEN_KEY = "stella-mobile_session_token";
export const MOBILE_SESSION_DATA_KEY = "stella-mobile_session_data";

type NativeAuthClientOptions = {
  scheme: string;
};

const parseStoredAuthJson = (value: string | null): unknown => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const readBearerToken = (): string =>
  SecureStore.getItem(MOBILE_SESSION_TOKEN_KEY)?.trim() ?? "";

export const clearMobileAuthStorage = async (): Promise<void> => {
  await Promise.all([
    SecureStore.deleteItemAsync(MOBILE_SESSION_TOKEN_KEY),
    SecureStore.deleteItemAsync(MOBILE_SESSION_DATA_KEY),
  ]);
};

const warmSessionFromCache = (store: ClientStore) => {
  const sessionAtom = store.atoms.session;
  if (!sessionAtom) return;
  const cached = parseStoredAuthJson(
    SecureStore.getItem(MOBILE_SESSION_DATA_KEY),
  ) as {
    user?: { id?: unknown };
    session?: { id?: unknown; expiresAt?: unknown };
  } | null;
  const expiresAt = cached?.session?.expiresAt;
  const expiresMs =
    typeof expiresAt === "string" || expiresAt instanceof Date
      ? new Date(expiresAt).getTime()
      : NaN;
  if (
    typeof cached?.user?.id === "string" &&
    typeof cached.session?.id === "string" &&
    expiresMs > Date.now()
  ) {
    sessionAtom.set({
      ...sessionAtom.get(),
      data: cached,
      error: null,
    });
  }
};

const toHeaderRecord = (headersInit: HeadersInit | undefined) =>
  Object.fromEntries(new Headers(headersInit).entries());

export const nativeBearerClient = ({ scheme }: NativeAuthClientOptions) => {
  let authFetch: BetterFetch | null = null;
  let store: ClientStore | null = null;

  const fetchPlugin: BetterFetchPlugin = {
    id: "stella-native-bearer",
    name: "Stella Native Bearer",
    hooks: {
      async onSuccess(context: SuccessContext<unknown>) {
        if (Platform.OS === "web") return;

        const sessionToken = context.response.headers
          .get("set-auth-token")
          ?.trim();
        if (sessionToken) {
          SecureStore.setItem(MOBILE_SESSION_TOKEN_KEY, sessionToken);
          store?.notify("$sessionSignal");
        }

        const requestUrl = context.request.url.toString();
        if (requestUrl.includes("/get-session")) {
          SecureStore.setItem(
            MOBILE_SESSION_DATA_KEY,
            JSON.stringify(context.data ?? null),
          );
        }

        const requestBody =
          typeof context.request.body === "string"
            ? context.request.body
            : "";
        const startsBrowserOAuth =
          Boolean((context.data as { redirect?: unknown } | null)?.redirect) &&
          (requestUrl.includes("/sign-in") ||
            requestUrl.includes("/link-social")) &&
          !requestBody.includes("idToken");
        if (!startsBrowserOAuth) return;

        const parsedBody = parseStoredAuthJson(requestBody) as {
          callbackURL?: unknown;
        } | null;
        const callbackURL =
          typeof parsedBody?.callbackURL === "string"
            ? parsedBody.callbackURL
            : Linking.createURL("", { scheme });
        const authorizationURL = (context.data as { url?: unknown } | null)
          ?.url;
        if (typeof authorizationURL !== "string" || !authorizationURL) {
          throw new Error("OAuth authorization URL was not returned.");
        }

        let WebBrowser: typeof import("expo-web-browser");
        try {
          WebBrowser = await import("expo-web-browser");
        } catch (error) {
          throw new Error('"expo-web-browser" is not installed.', {
            cause: error,
          });
        }
        if (Platform.OS === "android") {
          WebBrowser.dismissAuthSession();
        }

        const params = new URLSearchParams({ authorizationURL });
        const proxyURL = `${context.request.baseURL}/expo-authorization-proxy?${params.toString()}`;
        const result = await WebBrowser.openAuthSessionAsync(
          proxyURL,
          callbackURL,
        );
        if (result.type !== "success") return;

        const ott = new URL(result.url).searchParams.get("ott")?.trim();
        if (!ott) {
          throw new Error("OAuth callback did not include a one-time token.");
        }
        if (!authFetch) {
          throw new Error("Auth client is not initialized.");
        }
        await verifyOneTimeToken(authFetch, ott);
        if (!readBearerToken()) {
          throw new Error("OAuth session token exchange failed.");
        }
      },
    },
    async init(url, incomingOptions) {
      if (Platform.OS === "web") {
        return { url, options: incomingOptions };
      }

      const options = incomingOptions ?? {};
      const body = options.body as
        | {
            callbackURL?: unknown;
            newUserCallbackURL?: unknown;
            errorCallbackURL?: unknown;
            idToken?: unknown;
          }
        | undefined;
      const isNativeIdToken = body?.idToken !== undefined;
      const headers = toHeaderRecord(options.headers as HeadersInit | undefined);
      const bearerToken = readBearerToken();
      if (bearerToken && !headers.authorization) {
        headers.authorization = `Bearer ${bearerToken}`;
      }
      headers["x-skip-oauth-proxy"] = "true";
      if (!isNativeIdToken) {
        headers["expo-origin"] = Linking.createURL("", { scheme });
      }

      const rewriteCallback = (value: unknown) =>
        typeof value === "string" && value.startsWith("/")
          ? Linking.createURL(value, { scheme })
          : value;
      const rewrittenBody = body
        ? {
            ...body,
            callbackURL: rewriteCallback(body.callbackURL),
            newUserCallbackURL: rewriteCallback(body.newUserCallbackURL),
            errorCallbackURL: rewriteCallback(body.errorCallbackURL),
          }
        : options.body;

      if (url.includes("/sign-out")) {
        await clearMobileAuthStorage();
        store?.atoms.session?.set({
          ...store.atoms.session.get(),
          data: null,
          error: null,
          isPending: false,
        });
      }

      return {
        url,
        options: {
          ...options,
          body: rewrittenBody,
          credentials: "omit",
          headers,
        },
      };
    },
  };

  return {
    id: "stella-native-auth",
    getActions(fetch: BetterFetch, clientStore: ClientStore) {
      authFetch = fetch;
      store = clientStore;
      if (Platform.OS !== "web") {
        warmSessionFromCache(clientStore);
      }
      return {};
    },
    fetchPlugins: [fetchPlugin],
  };
};
