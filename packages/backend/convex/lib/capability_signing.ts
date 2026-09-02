import { importPKCS8, SignJWT, type JWTPayload } from "jose";
import {
  GATEWAY_CAPABILITY_ALGORITHM,
  GATEWAY_CAPABILITY_AUDIENCE,
  type GatewayCapabilityClaims,
} from "@stella/contracts/gateway/capability";

/**
 * ES256 capability signing for Convex.
 *
 * Mirrors `signCapability` in `@stella/contracts/gateway/jwt` (WebCrypto)
 * using `jose`, which is already a Convex dependency. The protected header
 * (`{alg, typ, kid}`) and claim layout are identical, so the gateway verifies
 * tokens from either signer with the same JWKS. Kept separate from the
 * contracts module so the Convex typecheck does not depend on its
 * `BufferSource` typings; `tests/gateway/capability-signing.test.ts` proves
 * the two stay interchangeable.
 */

export type CapabilitySigningKey = {
  kid: string;
  key: CryptoKey;
};

export type UnsignedCapabilityClaims = Omit<
  GatewayCapabilityClaims,
  "aud" | "iat" | "exp" | "jti"
> & {
  jti?: string;
  iat?: number;
  exp?: number;
};

export const importCapabilitySigningKey = async (
  pkcs8Pem: string,
  kid: string,
): Promise<CapabilitySigningKey> => ({
  kid,
  key: await importPKCS8(pkcs8Pem, GATEWAY_CAPABILITY_ALGORITHM),
});

export const signCapability = async (
  claims: UnsignedCapabilityClaims,
  signingKey: CapabilitySigningKey,
  options: { ttlMs: number; now?: number },
): Promise<{ token: string; claims: GatewayCapabilityClaims }> => {
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const full: GatewayCapabilityClaims = {
    ...claims,
    aud: GATEWAY_CAPABILITY_AUDIENCE,
    jti: claims.jti ?? crypto.randomUUID(),
    iat: claims.iat ?? nowSeconds,
    exp: claims.exp ?? nowSeconds + Math.ceil(options.ttlMs / 1000),
  };
  // The payload is passed whole (no jose setters) so the serialized claim
  // order matches the contracts signer byte for byte.
  const token = await new SignJWT(full as unknown as JWTPayload)
    .setProtectedHeader({
      alg: GATEWAY_CAPABILITY_ALGORITHM,
      typ: "JWT",
      kid: signingKey.kid,
    })
    .sign(signingKey.key);
  return { token, claims: full };
};
