import {
  CONTROL_PLANE_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_ALGORITHM,
  GATEWAY_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_CLOCK_SKEW_S,
  GATEWAY_CAPABILITY_ISSUERS,
  isManagedModelAudience,
  type GatewayCapabilityClaims,
  type CapabilityAudience,
  type GatewayCapabilityIssuer,
  type GatewayJwks,
} from "./capability.js";

/**
 * Compact-JWS capability signing and verification on WebCrypto only, so the
 * same code runs in Convex, workerd, Node, and Bun. ES256 (ECDSA P-256 with
 * SHA-256). WebCrypto emits and expects the raw `r || s` signature layout,
 * which is exactly what JWS specifies, so no DER conversion is needed.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export const base64UrlDecode = (value: string): Uint8Array<ArrayBuffer> => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const pemToDer = (pem: string, label: string): Uint8Array<ArrayBuffer> => {
  const body = pem
    .replace(new RegExp(`-----BEGIN ${label}-----`), "")
    .replace(new RegExp(`-----END ${label}-----`), "")
    .replace(/\s+/g, "");
  if (!body) {
    throw new Error(`Expected a PEM block labeled ${label}.`);
  }
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

export type CapabilitySigningKey = {
  kid: string;
  key: CryptoKey;
};

export const importCapabilitySigningKey = async (
  pkcs8Pem: string,
  kid: string,
): Promise<CapabilitySigningKey> => {
  const der = pemToDer(pkcs8Pem, "PRIVATE KEY");
  const key = await crypto.subtle.importKey("pkcs8", der, ECDSA_P256, false, [
    "sign",
  ]);
  return { kid, key };
};

export type CapabilityVerificationKeys = Map<
  string,
  { key: CryptoKey; issuer: GatewayCapabilityIssuer }
>;

export const importCapabilityVerificationKeys = async (
  jwks: GatewayJwks,
): Promise<CapabilityVerificationKeys> => {
  const keys: CapabilityVerificationKeys = new Map();
  for (const entry of jwks.keys) {
    const key = await crypto.subtle.importKey(
      "jwk",
      entry.jwk,
      ECDSA_P256,
      false,
      ["verify"],
    );
    keys.set(entry.kid, { key, issuer: entry.issuer });
  }
  return keys;
};

export type UnsignedCapabilityClaims = Omit<
  GatewayCapabilityClaims,
  "aud" | "iat" | "exp" | "jti"
> & {
  aud?: CapabilityAudience;
  jti?: string;
  iat?: number;
  exp?: number;
};

export const signCapability = async (
  claims: UnsignedCapabilityClaims,
  signingKey: CapabilitySigningKey,
  options: { ttlMs: number; now?: number },
): Promise<{ token: string; claims: GatewayCapabilityClaims }> => {
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const full: GatewayCapabilityClaims = {
    ...claims,
    aud: claims.aud ?? GATEWAY_CAPABILITY_AUDIENCE,
    jti: claims.jti ?? crypto.randomUUID(),
    iat: claims.iat ?? nowSeconds,
    exp: claims.exp ?? nowSeconds + Math.ceil(options.ttlMs / 1000),
  };
  const header = {
    alg: GATEWAY_CAPABILITY_ALGORITHM,
    typ: "JWT",
    kid: signingKey.kid,
  };
  const signingInput = `${base64UrlEncode(
    textEncoder.encode(JSON.stringify(header)),
  )}.${base64UrlEncode(textEncoder.encode(JSON.stringify(full)))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      ECDSA_SIGN,
      signingKey.key,
      textEncoder.encode(signingInput),
    ),
  );
  return {
    token: `${signingInput}.${base64UrlEncode(signature)}`,
    claims: full,
  };
};

export type CapabilityVerificationFailure =
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "expired"
  | "not_yet_valid"
  | "invalid_claims";

export type CapabilityVerificationResult =
  | { ok: true; claims: GatewayCapabilityClaims; kid: string }
  | { ok: false; reason: CapabilityVerificationFailure };

const KNOWN_ISSUERS = new Set<string>(
  Object.values(GATEWAY_CAPABILITY_ISSUERS),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Structural validation of decoded claims. Kept separate so callers that
 * already trust a signature (e.g. the issuer inspecting its own token) can
 * reuse it.
 */
export const validateCapabilityClaims = (
  value: unknown,
): value is GatewayCapabilityClaims => {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.iss) || !KNOWN_ISSUERS.has(value.iss))
    return false;
  if (
    value.aud !== GATEWAY_CAPABILITY_AUDIENCE &&
    value.aud !== CONTROL_PLANE_CAPABILITY_AUDIENCE
  ) {
    return false;
  }
  if (!isNonEmptyString(value.sub) || !isNonEmptyString(value.jti))
    return false;
  if (!isFiniteNumber(value.iat) || !isFiniteNumber(value.exp)) return false;
  if (!isNonEmptyString(value.gen)) return false;
  if (value.kind !== "session" && value.kind !== "turn") return false;
  if (!isManagedModelAudience(value.audience)) return false;
  if (!isFiniteNumber(value.budgetMicroCents)) return false;
  if (
    value.agentTypes !== undefined &&
    (!Array.isArray(value.agentTypes) ||
      !value.agentTypes.every((entry) => isNonEmptyString(entry)))
  ) {
    return false;
  }
  if (value.maxRequests !== undefined && !isFiniteNumber(value.maxRequests)) {
    return false;
  }
  if (
    value.credential !== undefined &&
    value.credential !== "anthropic" &&
    value.credential !== "openai-codex"
  ) {
    return false;
  }
  if (value.ledgerScope !== undefined && value.ledgerScope !== "owner-relay-v2") {
    return false;
  }
  if (value.kind === "turn") {
    const turn = value.turn;
    if (!isRecord(turn)) return false;
    if (
      !isNonEmptyString(turn.turnId) ||
      !isNonEmptyString(turn.conversationId)
    ) {
      return false;
    }
    const execution = turn.execution;
    if (!isRecord(execution)) return false;
    if (
      !isNonEmptyString(execution.engine) ||
      !isNonEmptyString(execution.provider) ||
      !isNonEmptyString(execution.model) ||
      !isNonEmptyString(execution.reasoningEffort)
    ) {
      return false;
    }
  } else if (value.turn !== undefined) {
    return false;
  }
  return true;
};

export const decodeCapabilityUnverified = (
  token: string,
): { header: Record<string, unknown>; claims: unknown } | null => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(
      textDecoder.decode(base64UrlDecode(parts[0] as string)),
    ) as unknown;
    const claims = JSON.parse(
      textDecoder.decode(base64UrlDecode(parts[1] as string)),
    ) as unknown;
    if (!isRecord(header)) return null;
    return { header, claims };
  } catch {
    return null;
  }
};

export const verifyCapability = async (
  token: string,
  keys: CapabilityVerificationKeys,
  options: {
    now?: number;
    expectedIssuer?: GatewayCapabilityIssuer;
    /** Defaults to the model-gateway audience. */
    expectedAudience?: CapabilityAudience;
  } = {},
): Promise<CapabilityVerificationResult> => {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const decoded = decodeCapabilityUnverified(token);
  if (!decoded) return { ok: false, reason: "malformed" };
  if (decoded.header.alg !== GATEWAY_CAPABILITY_ALGORITHM) {
    return { ok: false, reason: "malformed" };
  }
  const kid = decoded.header.kid;
  if (!isNonEmptyString(kid)) return { ok: false, reason: "malformed" };
  const entry = keys.get(kid);
  if (!entry) return { ok: false, reason: "unknown_key" };
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlDecode(parts[2] as string);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid = await crypto.subtle.verify(
    ECDSA_SIGN,
    entry.key,
    signature,
    textEncoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return { ok: false, reason: "bad_signature" };
  const claims = decoded.claims;
  if (!validateCapabilityClaims(claims)) {
    return { ok: false, reason: "invalid_claims" };
  }
  if (claims.iss !== entry.issuer)
    return { ok: false, reason: "issuer_mismatch" };
  if (options.expectedIssuer && claims.iss !== options.expectedIssuer) {
    return { ok: false, reason: "issuer_mismatch" };
  }
  if (claims.aud !== (options.expectedAudience ?? GATEWAY_CAPABILITY_AUDIENCE)) {
    return { ok: false, reason: "audience_mismatch" };
  }
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (claims.exp + GATEWAY_CAPABILITY_CLOCK_SKEW_S < nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  if (claims.iat - GATEWAY_CAPABILITY_CLOCK_SKEW_S > nowSeconds) {
    return { ok: false, reason: "not_yet_valid" };
  }
  return { ok: true, claims, kid };
};

/** Generates a fresh P-256 pair as PKCS8 PEM + public JWK, for ops scripts. */
export const generateCapabilityKeyPair = async (): Promise<{
  privateKeyPem: string;
  publicJwk: JsonWebKey;
}> => {
  // Casts: DOM and workers-types declare these overloads with different
  // union returns; the algorithm fixes the concrete shapes.
  const pair = (await crypto.subtle.generateKey(ECDSA_P256, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;
  const body = base64UrlEncode(pkcs8).replace(/-/g, "+").replace(/_/g, "/");
  const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
  const lines = padded.match(/.{1,64}/g) ?? [];
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
  const publicJwk: JsonWebKey = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    alg: GATEWAY_CAPABILITY_ALGORITHM,
    use: "sig",
  };
  return { privateKeyPem, publicJwk };
};
