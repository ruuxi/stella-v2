import type { ActionCtx } from "../_generated/server";
import { isAnonymousIdentity } from "../auth";
import { jsonResponse } from "./cors";

const DEFAULT_SIGN_IN_MESSAGE = "Sign in to Stella to use this feature.";
const DEFAULT_SIGN_IN_ACTION =
  "Ask the user to open the Stella desktop app and finish signing in, then retry the same request.";

type AuthRequiredOptions = {
  message?: string;
  action?: string;
  docsUrl?: string;
  realm?: string;
};

type SignedInIdentity = NonNullable<
  Awaited<ReturnType<ActionCtx["auth"]["getUserIdentity"]>>
>;

type SignedInAccountResult =
  | { ok: false; response: Response }
  | { ok: true; identity: SignedInIdentity; ownerId: string };

export const authRequiredResponse = (
  origin: string | null,
  options: AuthRequiredOptions = {},
): Response => {
  const message = options.message ?? DEFAULT_SIGN_IN_MESSAGE;
  const response = jsonResponse(
    {
      error: message,
      code: "auth_required",
      action: options.action ?? DEFAULT_SIGN_IN_ACTION,
      ...(options.docsUrl ? { docsUrl: options.docsUrl } : {}),
    },
    401,
    origin,
  );
  response.headers.set(
    "WWW-Authenticate",
    `Bearer realm="${options.realm ?? "stella"}", error="invalid_token", error_description="${message.replace(/"/g, "'")}"`,
  );
  return response;
};

export const requireSignedInAccountAction = async (
  ctx: ActionCtx,
  origin: string | null,
  options?: AuthRequiredOptions,
): Promise<SignedInAccountResult> => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || isAnonymousIdentity(identity)) {
    return { ok: false, response: authRequiredResponse(origin, options) };
  }
  return { ok: true, identity, ownerId: identity.tokenIdentifier };
};
