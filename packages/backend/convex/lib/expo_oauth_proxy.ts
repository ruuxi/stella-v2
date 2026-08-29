import { expo } from "@better-auth/expo";

/**
 * Keep Expo's OAuth authorization proxy without its cookie-in-URL redirect
 * hook.
 *
 * The upstream Expo server plugin appends the full session cookie to native
 * callback URLs as `?cookie=...`. Stella's one-time-token plugin turns the
 * completed OAuth session into a short-lived `?ott=...`, which the native
 * client exchanges for a bearer token. Removing only Expo's after-hook keeps
 * `/expo-authorization-proxy`, origin handling, and trusted-origin setup while
 * ensuring the long-lived credential never enters a URL.
 */
export const expoOAuthProxy = () => {
  const { hooks: _cookieRedirectHook, ...proxyOnly } = expo();
  return proxyOnly;
};
