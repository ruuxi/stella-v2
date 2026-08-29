import { createAuthClient } from "better-auth/client";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import {
  anonymousClient,
  magicLinkClient,
  oneTimeTokenClient,
} from "better-auth/client/plugins";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import {
  captureRotatedSessionToken,
  readBrowserSessionToken,
} from "@/global/auth/services/auth-storage";

// `convexClient()` exposes `authClient.convex.token()`, which is the JWT
// `desktop/src/global/auth/services/auth-token.ts` actually consumes. The
// standalone `jwtClient()` was paired with a now-removed `jwt({...})` plugin
// in `backend/convex/auth.ts` (see comment there) and is intentionally absent.
// `oneTimeTokenClient()` replaces `crossDomainClient()`'s OTT surface. A
// browser shell redeems the handoff token through it and the `bearer` plugin
// returns the session credential in `set-auth-token`.
const plugins = [
  convexClient(),
  anonymousClient(),
  magicLinkClient(),
  oneTimeTokenClient(),
];

// Capture the full plugin-aware return type so signIn.anonymous(), etc. are typed.
type AuthClient = ReturnType<
  typeof createAuthClient<{ plugins: typeof plugins }>
>;

let _instance: AuthClient | null = null;

/** Lazy-initialized auth client. */
export const authClient = new Proxy({} as AuthClient, {
  get(_target, prop, receiver) {
    if (!_instance) {
      const baseURL = readConfiguredConvexSiteUrl(
        import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
      );
      if (!baseURL) {
        throw new Error(
          "Convex site URL is not set. Cannot initialize auth client.",
        );
      }
      _instance = createAuthClient({
        baseURL,
        plugins,
        // Neither shell has a cookie jar for the Convex site origin. Electron
        // routes session mutations through main, which owns the bearer; a
        // browser shell carries its own bearer from local storage. Sending
        // credentials would only invite an ambient third-party cookie.
        fetchOptions: {
          credentials: "omit",
          onRequest(context) {
            const token = readBrowserSessionToken();
            if (token) {
              context.headers.set("Authorization", `Bearer ${token}`);
            }
            return context;
          },
          onSuccess(context) {
            captureRotatedSessionToken(context.response);
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
