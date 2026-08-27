import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { jwtClient, magicLinkClient } from "better-auth/client/plugins";
import { env } from "../config/env";
import { assert } from "./assert";
import { nativeBearerClient } from "./native-auth-client";

export {
  clearMobileAuthStorage,
  MOBILE_SESSION_TOKEN_KEY,
} from "./native-auth-client";

const plugins = [
  nativeBearerClient({
    scheme: env.mobileScheme,
  }),
  convexClient(),
  magicLinkClient(),
  jwtClient(),
];

type AuthClient = ReturnType<typeof createAuthClient<{ plugins: typeof plugins }>>;

let instance: AuthClient | null = null;

export const authClient = new Proxy({} as AuthClient, {
  get(_target, prop, receiver) {
    if (!instance) {
      assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
      instance = createAuthClient({
        baseURL: env.convexSiteUrl,
        plugins,
      });
    }

    return Reflect.get(instance, prop, receiver);
  },
});
