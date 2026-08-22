import type { AuthConfig } from "convex/server";
import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import { resolveJwksRuntimeConfig } from "./lib/jwks_config";

const jwksRuntime = resolveJwksRuntimeConfig();

export default {
  providers: [
    getAuthConfigProvider(
      jwksRuntime.staticJwks ? { jwks: jwksRuntime.staticJwks } : undefined,
    ),
  ],
} satisfies AuthConfig;
