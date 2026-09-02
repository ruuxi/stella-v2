import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import {
  anonymousClient,
  jwtClient,
  magicLinkClient,
} from "better-auth/client/plugins";
import { env } from "../config/env";
import { assert } from "./assert";
import { nativeBearerClient } from "./native-auth-client";

export {
  clearMobileAuthStorage,
  MOBILE_SESSION_TOKEN_KEY,
} from "./native-auth-client";

// `nativeBearerClient` replaces `expoClient`. React Native has no cookie jar,
// so the Expo plugin emulated one in SecureStore and mirrored `Set-Cookie`
// through a custom header. The bearer plugin on the backend returns one opaque
// signed token in `set-auth-token` instead, and this plugin is what stores it
// and attaches `Authorization: Bearer` (including the `origin` header the
// backend's trusted-origin check needs, via `expo-origin`).
const plugins = [
  nativeBearerClient({
    scheme: env.mobileScheme,
  }),
  convexClient(),
  anonymousClient(),
  magicLinkClient(),
  jwtClient(),
];

type AuthClient = ReturnType<
  typeof createAuthClient<{ plugins: typeof plugins }>
>;

let instance: AuthClient | null = null;

export const authClient = new Proxy({} as AuthClient, {
  get(_target, prop, receiver) {
    if (!instance) {
      assert(
        env.convexSiteUrl,
        "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.",
      );
      instance = createAuthClient({
        baseURL: env.convexSiteUrl,
        plugins,
      });
    }

    return Reflect.get(instance, prop, receiver);
  },
});
