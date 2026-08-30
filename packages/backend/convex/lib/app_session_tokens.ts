import { ConvexError } from "convex/values";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export const APP_SESSION_AUDIENCE = "stella-app-api-v2" as const;
export const APP_FETCH_AUDIENCE = "stella-app-fetch-v1" as const;
export const ANONYMOUS_VIEWER_AUDIENCE =
  "stella-app-anonymous-viewer-v1" as const;
export const APP_SESSION_TTL_MS = 15 * 60_000;
export const APP_FETCH_CAPABILITY_TTL_MS = 60_000;
export const ANONYMOUS_VIEWER_TTL_MS = 30 * 24 * 60 * 60_000;

export type AppSessionToken = {
  version: 2;
  audience: typeof APP_SESSION_AUDIENCE;
  issuer: string;
  tokenId: string;
  appId: string;
  ownerId: string;
  ownerGeneration: string;
  viewerNamespace: string;
  role: "owner" | "viewer" | "anonymous";
  userId: string;
  username: string;
  anonymous: boolean;
  origin: string;
  issuedAt: number;
  exp: number;
};

export type AppFetchCapabilityToken = {
  version: 1;
  audience: typeof APP_FETCH_AUDIENCE;
  issuer: string;
  tokenId: string;
  appId: string;
  viewerNamespace: string;
  origin: string;
  method: string;
  targetOrigin: string;
  targetUrl: string;
  requestHash: string;
  issuedAt: number;
  exp: number;
};

type AnonymousViewerToken = {
  version: 1;
  audience: typeof ANONYMOUS_VIEWER_AUDIENCE;
  issuer: string;
  viewerId: string;
  origin: string;
  issuedAt: number;
  exp: number;
};

type SignedPayload =
  | AppSessionToken
  | AppFetchCapabilityToken
  | AnonymousViewerToken;

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const fromBase64url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ConvexError("Invalid app credential.");
  }
  const padding = (4 - (value.length % 4)) % 4;
  try {
    return Uint8Array.from(
      atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(padding)}`),
      (char) => char.charCodeAt(0),
    );
  } catch {
    throw new ConvexError("Invalid app credential.");
  }
};

const encryptionKey = async (): Promise<CryptoKey> => {
  const secret = process.env.APP_TOKEN_SIGNING_KEY?.trim();
  if (!secret) throw new Error("App token signing is not configured.");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
};

const issuer = (): string => {
  const value = process.env.STELLA_DEPLOYMENT_IDENTITY?.trim();
  if (!value) throw new Error("App token issuer is not configured.");
  return value;
};

const sign = async (payload: SignedPayload): Promise<string> => {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await encryptionKey(),
    encoder.encode(JSON.stringify(payload)),
  );
  return `v2.${base64url(nonce)}.${base64url(new Uint8Array(ciphertext))}`;
};

const verify = async (raw: string): Promise<Record<string, unknown>> => {
  if (raw.length < 32 || raw.length > 8_192) {
    throw new ConvexError("Invalid app credential.");
  }
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== "v2" || !parts[1] || !parts[2]) {
    throw new ConvexError("Invalid app credential.");
  }
  let parsed: unknown;
  try {
    const nonce = fromBase64url(parts[1]);
    if (nonce.byteLength !== 12) throw new Error("invalid nonce");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as unknown as BufferSource },
      await encryptionKey(),
      fromBase64url(parts[2]) as unknown as BufferSource,
    );
    parsed = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new ConvexError("Invalid app credential.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConvexError("Invalid app credential.");
  }
  return parsed as Record<string, unknown>;
};

const isBoundedString = (
  value: unknown,
  maximum = 4_096,
): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const assertFresh = (
  payload: Record<string, unknown>,
  now: number,
  maximumLifetimeMs: number,
): void => {
  if (
    typeof payload.issuedAt !== "number" ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.issuedAt > now + 30_000 ||
    payload.exp <= payload.issuedAt ||
    payload.exp <= now ||
    payload.exp - payload.issuedAt > maximumLifetimeMs
  ) {
    throw new ConvexError("App credential expired. Reload the app.");
  }
};

export const hashAppViewerNamespace = async (args: {
  appId: string;
  viewerIdentity: string;
}): Promise<string> => {
  const secret = process.env.APP_VIEWER_NAMESPACE_KEY?.trim();
  if (!secret) throw new Error("App viewer namespace derivation is not configured.");
  const hmac = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    hmac,
    encoder.encode(`stella-app-viewer-v1\0${args.appId}\0${args.viewerIdentity}`),
  );
  return base64url(new Uint8Array(bytes));
};

export const mintAnonymousViewerToken = async (args: {
  origin: string;
  now: number;
  viewerId?: string;
}): Promise<{ token: string; viewerId: string; exp: number }> => {
  const payload: AnonymousViewerToken = {
    version: 1,
    audience: ANONYMOUS_VIEWER_AUDIENCE,
    issuer: issuer(),
    viewerId: args.viewerId ?? crypto.randomUUID(),
    origin: args.origin,
    issuedAt: args.now,
    exp: args.now + ANONYMOUS_VIEWER_TTL_MS,
  };
  return {
    token: await sign(payload),
    viewerId: payload.viewerId,
    exp: payload.exp,
  };
};

export const verifyAnonymousViewerToken = async (args: {
  token: string;
  origin: string;
  now: number;
}): Promise<{ viewerId: string; exp: number }> => {
  const payload = await verify(args.token);
  assertFresh(payload, args.now, ANONYMOUS_VIEWER_TTL_MS);
  if (
    payload.version !== 1 ||
    payload.audience !== ANONYMOUS_VIEWER_AUDIENCE ||
    payload.issuer !== issuer() ||
    !isBoundedString(payload.viewerId, 128) ||
    payload.origin !== args.origin
  ) {
    throw new ConvexError("Invalid anonymous app viewer.");
  }
  return { viewerId: payload.viewerId, exp: payload.exp as number };
};

export const signAppSessionToken = async (
  payload: Omit<
    AppSessionToken,
    "version" | "audience" | "issuer" | "tokenId"
  >,
): Promise<string> =>
  sign({
    version: 2,
    audience: APP_SESSION_AUDIENCE,
    issuer: issuer(),
    tokenId: crypto.randomUUID(),
    ...payload,
  });

export const verifyAppSessionToken = async (args: {
  token: string;
  origin: string | null;
  now: number;
}): Promise<AppSessionToken> => {
  const payload = await verify(args.token);
  assertFresh(payload, args.now, APP_SESSION_TTL_MS);
  if (
    payload.version !== 2 ||
    payload.audience !== APP_SESSION_AUDIENCE ||
    payload.issuer !== issuer() ||
    !isBoundedString(payload.tokenId, 128) ||
    !isBoundedString(payload.appId, 256) ||
    !isBoundedString(payload.ownerId) ||
    !isBoundedString(payload.ownerGeneration, 256) ||
    !isBoundedString(payload.viewerNamespace, 128) ||
    (payload.role !== "owner" &&
      payload.role !== "viewer" &&
      payload.role !== "anonymous") ||
    !isBoundedString(payload.userId) ||
    !isBoundedString(payload.username, 256) ||
    typeof payload.anonymous !== "boolean" ||
    (payload.role === "anonymous") !== payload.anonymous ||
    (payload.role === "owner" && payload.userId !== payload.ownerId) ||
    !isBoundedString(payload.origin, 2_048) ||
    args.origin !== payload.origin
  ) {
    throw new ConvexError("Invalid app session.");
  }
  return payload as AppSessionToken;
};

export const signAppFetchCapability = async (
  payload: Omit<
    AppFetchCapabilityToken,
    "version" | "audience" | "issuer" | "tokenId"
  >,
): Promise<{ token: string; tokenId: string; expiresAt: number }> => {
  const tokenId = crypto.randomUUID();
  return {
    token: await sign({
      version: 1,
      audience: APP_FETCH_AUDIENCE,
      issuer: issuer(),
      tokenId,
      ...payload,
    }),
    tokenId,
    expiresAt: payload.exp,
  };
};
