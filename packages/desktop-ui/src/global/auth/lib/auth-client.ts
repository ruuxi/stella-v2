import { createAuthClient } from "better-auth/client";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import {
  anonymousClient,
  magicLinkClient,
  oneTimeTokenClient,
} from "better-auth/client/plugins";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { getStellaInteriorBridge } from "@/platform/interior/interior-bridge";
import {
  captureRotatedSessionToken,
  clearBrowserSessionToken,
  readBrowserSessionToken,
} from "@/global/auth/services/auth-storage";

// `convexClient()` exposes `authClient.convex.token()`, which is the JWT
// `desktop/src/global/auth/services/auth-token.ts` actually consumes. The
// standalone `jwtClient()` was paired with a now-removed `jwt({...})` plugin
// in `backend/convex/auth.ts` (see comment there) and is intentionally absent.
// `oneTimeTokenClient()` replaces `crossDomainClient()`'s OTT surface. A
// browser shell redeems the handoff token through it and the `bearer` plugin
// returns the session credential in `set-auth-token`.
const createPlugins = () => [
  convexClient(),
  anonymousClient(),
  magicLinkClient(),
  oneTimeTokenClient(),
];

// Capture the full plugin-aware return type so signIn.anonymous(), etc. are typed.
type AuthClient = ReturnType<
  typeof createAuthClient<{ plugins: ReturnType<typeof createPlugins> }>
>;

let _instance: AuthClient | null = null;

/** Lazy-initialized auth client. */
export const authClient = new Proxy({} as AuthClient, {
  get(_target, prop, receiver) {
    if (getStellaInteriorBridge()) {
      throw new Error("Use the trusted Stella shell for account changes.");
    }
    if (!_instance) {
      const plugins = createPlugins();
      const convexBaseURL = readConfiguredConvexSiteUrl(
        import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
      );
      if (!convexBaseURL) {
        throw new Error(
          "Convex site URL is not set. Cannot initialize auth client.",
        );
      }
      const configuredAppsAuthOrigin = (
        import.meta.env.VITE_STELLA_APPS_AUTH_HOST as string | undefined
      )
        ?.trim()
        .replace(/\/+$/, "");
      const usesTrustedCookieAuth =
        !window.electronAPI &&
        Boolean(configuredAppsAuthOrigin) &&
        window.location.origin === configuredAppsAuthOrigin;
      if (usesTrustedCookieAuth) clearBrowserSessionToken();
      _instance = createAuthClient({
        baseURL: usesTrustedCookieAuth
          ? configuredAppsAuthOrigin
          : convexBaseURL,
        plugins,
        // Neither shell has a cookie jar for the Convex site origin. Electron
        // routes session mutations through main, which owns the bearer; a
        // browser shell carries its own bearer from local storage. Sending
        // credentials would only invite an ambient third-party cookie.
        fetchOptions: {
          credentials: usesTrustedCookieAuth ? "include" : "omit",
          onRequest(context) {
            if (usesTrustedCookieAuth) return context;
            const token = readBrowserSessionToken();
            if (token) {
              context.headers.set("Authorization", `Bearer ${token}`);
            }
            return context;
          },
          onSuccess(context) {
            if (!usesTrustedCookieAuth) {
              captureRotatedSessionToken(context.response);
            }
          },
        },
        sessionOptions: {
          refetchOnWindowFocus: false,
        },
      });
    }
    return Reflect.get(_instance, prop, receiver);
  },
});
