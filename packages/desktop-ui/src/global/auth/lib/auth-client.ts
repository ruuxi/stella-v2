import { createAuthClient } from "better-auth/client";
import {
  anonymousClient,
  jwtClient,
  magicLinkClient,
  oneTimeTokenClient,
} from "better-auth/client/plugins";
import { backendUrl } from "@/platform/backend/backend-url";
import { getStellaInteriorBridge } from "@/platform/interior/interior-bridge";
import {
  captureRotatedSessionToken,
  clearBrowserSessionToken,
  readBrowserSessionToken,
} from "@/global/auth/services/auth-storage";

// Better Auth lives on the backend worker at `/api/auth`. `jwtClient()`
// exposes `authClient.token()`, the short-lived owner JWT that
// `services/auth-token.ts` hands to backend calls. `oneTimeTokenClient()`
// redeems the browser handoff token; the `bearer` plugin returns the session
// credential in `set-auth-token`.
const createPlugins = () => [
  jwtClient(),
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
      if (!backendUrl) {
        throw new Error(
          "Stella backend URL is not set. Cannot initialize auth client.",
        );
      }
      // The browser renderer is served by the backend worker itself, so a
      // first-party session cookie works there. Anywhere else the shell
      // carries its own bearer from local storage (Electron routes session
      // mutations through main, which owns the bearer).
      const usesTrustedCookieAuth =
        !window.electronAPI && window.location.origin === backendUrl;
      if (usesTrustedCookieAuth) clearBrowserSessionToken();
      _instance = createAuthClient({
        baseURL: backendUrl,
        plugins: createPlugins(),
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
