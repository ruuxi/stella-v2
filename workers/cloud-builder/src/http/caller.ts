import { bearerCredential } from "../../../shared/bearer.js";
import { verifyUserToken } from "../auth-jwt.js";
import { RpcError } from "../owner-store/errors.js";
import type { OwnerCaller } from "../owner-store/registry.js";

type CallerEnv = Pick<Cloudflare.Env, "OWNER_GATES" | "CLOUD_BUILDER_PUBLIC_URL">;

export type VerifiedCaller = { ok: true; caller: OwnerCaller } | { ok: false; error: RpcError };

/**
 * A user JWT as the owner it speaks for. A missing or bad token is
 * `UNAUTHENTICATED`; a check that could not run is `UNAVAILABLE`.
 */
export const verifyCaller = async (env: CallerEnv, token: string): Promise<VerifiedCaller> => {
  if (!token) {
    return { ok: false, error: new RpcError("UNAUTHENTICATED", "Sign in to continue.") };
  }
  const verified = await verifyUserToken(token, env as unknown as Cloudflare.Env);
  if (verified.ok) return { ok: true, caller: verified.token };
  return {
    ok: false,
    error: verified.retryable
      ? new RpcError("UNAVAILABLE", "Stella couldn't check your sign-in. Try again shortly.")
      : new RpcError("UNAUTHENTICATED", "Your sign-in expired. Sign in again to continue."),
  };
};

/**
 * The caller behind the request's `Authorization: Bearer` JWT. Unless
 * `allowAnonymous`, an anonymous session is refused as `FORBIDDEN` with
 * `anonymousMessage`. Routes answer the error with `rpcErrorStatus`.
 */
export const requireCaller = async (
  request: Request,
  env: CallerEnv,
  options: { allowAnonymous: boolean; anonymousMessage?: string },
): Promise<VerifiedCaller> => {
  const verified = await verifyCaller(env, bearerCredential(request.headers.get("authorization")) ?? "");
  if (verified.ok && verified.caller.isAnonymous && !options.allowAnonymous) {
    return {
      ok: false,
      error: new RpcError("FORBIDDEN", options.anonymousMessage ?? "Sign in with an account to use this."),
    };
  }
  return verified;
};
