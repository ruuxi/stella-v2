import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

export const nativeOttRedirect = () => ({
  id: "stella-native-ott-redirect",
  hooks: {
    after: [
      {
        matcher: (ctx) =>
          Boolean(
            ctx.path?.startsWith("/callback") ||
              ctx.path?.startsWith("/oauth2/callback") ||
              ctx.path?.startsWith("/magic-link/verify"),
          ),
        handler: createAuthMiddleware(async (ctx) => {
          const token = ctx.context.responseHeaders?.get("set-ott")?.trim();
          const redirectTo = ctx.context.responseHeaders?.get("location");
          if (!token || !redirectTo) return;

          const redirectUrl = new URL(redirectTo);
          redirectUrl.searchParams.set("ott", token);
          ctx.context.responseHeaders?.delete("set-ott");
          throw ctx.redirect(redirectUrl.toString());
        }),
      },
    ],
  },
}) satisfies BetterAuthPlugin;
