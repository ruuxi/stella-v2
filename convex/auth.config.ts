import type { AuthConfig } from "convex/server";
import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";

const staticJwks = process.env.JWKS?.trim();

export default {
  providers: [
    getAuthConfigProvider(staticJwks ? { jwks: staticJwks } : undefined),
  ],
} satisfies AuthConfig;
