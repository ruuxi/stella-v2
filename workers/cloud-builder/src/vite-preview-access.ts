/**
 * Turn-scoped access for an agent-only Vite preview.
 *
 * The public capability carries only a signed BuildSession/turn/sandbox
 * identity and a random nonce. The raw Cloudflare tunnel URL is deliberately
 * confined to the active Durable Object record: it must never be returned to
 * the caller or copied into a log-safe representation.
 *
 * Deleting or replacing PREVIEW_ACCESS_STORAGE_KEY is the authoritative
 * revocation operation. This makes access die with the sandbox even when the
 * signed capability has not reached its wall-clock expiry yet.
 */

export const PREVIEW_ACCESS_SCHEMA_VERSION = 1 as const;
export const PREVIEW_ACCESS_STORAGE_KEY = "vite-preview-access:active";
export const PREVIEW_ACCESS_MAX_TTL_MS = 10 * 60_000;

const TOKEN_PREFIX = "pv1";
const TOKEN_DOMAIN = "stella.vite-preview-access.v1";
const NONCE_BYTES = 16;
const HMAC_BYTES = 32;
const MAX_PAYLOAD_SEGMENT_CHARS = 2_048;
const BUILD_SESSION_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const SANDBOX_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

type PreviewAccessClaims = Readonly<{
  v: typeof PREVIEW_ACCESS_SCHEMA_VERSION;
  b: string;
  t: string;
  s: string;
  e: number;
  n: string;
}>;

export type PreviewAccessIdentity = Readonly<{
  buildSessionName: string;
  turnId: string;
  sandboxId: string;
}>;

/**
 * Sensitive persisted state. Do not log this object: use
 * previewAccessLogFields() instead.
 */
export type PreviewAccessActiveRecord = Readonly<{
  schemaVersion: typeof PREVIEW_ACCESS_SCHEMA_VERSION;
  state: "active";
  buildSessionName: string;
  turnId: string;
  sandboxId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  tunnelUrl: string;
}>;

export type PreviewAccessLogFields = Readonly<{
  schemaVersion: typeof PREVIEW_ACCESS_SCHEMA_VERSION;
  state: "active";
  buildSessionName: string;
  turnId: string;
  sandboxId: string;
  issuedAt: number;
  expiresAt: number;
}>;

export type PreviewAccessVerification =
  | {
      ok: true;
      identity: PreviewAccessIdentity;
      expiresAt: number;
      /** Sensitive proxy target. Never serialize this result to the caller. */
      tunnelUrl: string;
    }
  | {
      ok: false;
      code:
        | "malformed"
        | "bad_signature"
        | "expired"
        | "wrong_scope"
        | "inactive";
    };

export type PreviewAccessRouteVerification =
  | {
      ok: true;
      identity: PreviewAccessIdentity;
      expiresAt: number;
    }
  | {
      ok: false;
      code: "malformed" | "bad_signature" | "expired" | "wrong_scope";
    };

const boundedTurnId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const validIdentity = (value: PreviewAccessIdentity): boolean =>
  BUILD_SESSION_PATTERN.test(value.buildSessionName) &&
  boundedTurnId(value.turnId) &&
  SANDBOX_ID_PATTERN.test(value.sandboxId);

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
};

/** Rejects padding, non-URL alphabet, impossible lengths, and aliases. */
const strictBase64UrlToBytes = (
  value: string,
  options: { maxChars: number; exactBytes?: number },
): Uint8Array | null => {
  if (
    value.length === 0 ||
    value.length > options.maxChars ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    return null;
  }
  try {
    const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(
      standard.padEnd(Math.ceil(standard.length / 4) * 4, "="),
    );
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (
      (options.exactBytes !== undefined &&
        bytes.byteLength !== options.exactBytes) ||
      bytesToBase64Url(bytes) !== value
    ) {
      return null;
    }
    return bytes;
  } catch {
    return null;
  }
};

const claimsFor = (args: {
  identity: PreviewAccessIdentity;
  expiresAt: number;
  nonce: string;
}): PreviewAccessClaims => ({
  v: PREVIEW_ACCESS_SCHEMA_VERSION,
  b: args.identity.buildSessionName,
  t: args.identity.turnId,
  s: args.identity.sandboxId,
  e: args.expiresAt,
  n: args.nonce,
});

const parseClaims = (segment: string): PreviewAccessClaims | null => {
  const bytes = strictBase64UrlToBytes(segment, {
    maxChars: MAX_PAYLOAD_SEGMENT_CHARS,
  });
  if (!bytes) return null;
  try {
    const raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "b,e,n,s,t,v") return null;
    if (
      value.v !== PREVIEW_ACCESS_SCHEMA_VERSION ||
      typeof value.b !== "string" ||
      typeof value.t !== "string" ||
      typeof value.s !== "string" ||
      typeof value.e !== "number" ||
      typeof value.n !== "string"
    ) {
      return null;
    }
    const claims: PreviewAccessClaims = {
      v: PREVIEW_ACCESS_SCHEMA_VERSION,
      b: value.b,
      t: value.t,
      s: value.s,
      e: value.e,
      n: value.n,
    };
    if (
      !validIdentity({
        buildSessionName: claims.b,
        turnId: claims.t,
        sandboxId: claims.s,
      }) ||
      !Number.isSafeInteger(claims.e) ||
      claims.e < 0 ||
      !NONCE_PATTERN.test(claims.n)
    ) {
      return null;
    }
    // One canonical JSON representation prevents whitespace, property-order,
    // and escaped-character aliases from becoming distinct signed tokens.
    if (
      bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims))) !==
      segment
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
};

const keyBytes = (secret: string | Uint8Array): Uint8Array => {
  const source =
    typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  if (copy.byteLength < 32 || copy.byteLength > 4_096) {
    throw new Error("Vite preview HMAC secret must contain 32-4096 bytes.");
  }
  return copy;
};

const importHmacKey = async (
  secret: string | Uint8Array,
  usages: ("sign" | "verify")[],
): Promise<CryptoKey> =>
  await crypto.subtle.importKey(
    "raw",
    keyBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );

const signingInput = (payloadSegment: string): Uint8Array =>
  new TextEncoder().encode(`${TOKEN_DOMAIN}.${payloadSegment}`);

const verifiedClaims = async (args: {
  capability: string;
  secret: string | Uint8Array;
}): Promise<
  | { ok: true; claims: PreviewAccessClaims }
  | { ok: false; code: "malformed" | "bad_signature" }
> => {
  const parts = args.capability.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== TOKEN_PREFIX ||
    !parts[1] ||
    !parts[2]
  ) {
    return { ok: false, code: "malformed" };
  }
  const payloadSegment = parts[1];
  if (
    !strictBase64UrlToBytes(payloadSegment, {
      maxChars: MAX_PAYLOAD_SEGMENT_CHARS,
    })
  ) {
    return { ok: false, code: "malformed" };
  }
  const signature = strictBase64UrlToBytes(parts[2], {
    maxChars: 43,
    exactBytes: HMAC_BYTES,
  });
  if (!signature) return { ok: false, code: "malformed" };
  const key = await importHmacKey(args.secret, ["verify"]);
  const signatureValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    signingInput(payloadSegment),
  );
  if (!signatureValid) return { ok: false, code: "bad_signature" };
  const claims = parseClaims(payloadSegment);
  return claims ? { ok: true, claims } : { ok: false, code: "malformed" };
};

/**
 * Cheap outer-router verification. This runs before resolving a named DO, so
 * a fabricated bearer cannot fan out storage objects. The BuildSession still
 * verifies the active nonce plus exact turn/sandbox scope before proxying.
 */
export const verifyPreviewAccessRouteCapability = async (args: {
  capability: string;
  secret: string | Uint8Array;
  expectedBuildSessionName: string;
  now: number;
}): Promise<PreviewAccessRouteVerification> => {
  if (
    !BUILD_SESSION_PATTERN.test(args.expectedBuildSessionName) ||
    !Number.isSafeInteger(args.now) ||
    args.now < 0
  ) {
    return { ok: false, code: "wrong_scope" };
  }
  const verified = await verifiedClaims(args);
  if (!verified.ok) return verified;
  if (args.now >= verified.claims.e) return { ok: false, code: "expired" };
  if (verified.claims.b !== args.expectedBuildSessionName) {
    return { ok: false, code: "wrong_scope" };
  }
  return {
    ok: true,
    identity: {
      buildSessionName: verified.claims.b,
      turnId: verified.claims.t,
      sandboxId: verified.claims.s,
    },
    expiresAt: verified.claims.e,
  };
};

/** Never let a bearer-bearing path reach structured request logs. */
export const previewSafeRequestLogPath = (pathname: string): string =>
  pathname.startsWith("/internal/previews/")
    ? "/internal/previews/:session/:capability"
    : pathname;

const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/iu;

/**
 * Resolve a proxy suffix without ever letting URL parsing reinterpret it as
 * an authority. Literal/encoded slash and backslash tricks are rejected, and
 * the final origin must remain byte-for-byte equal to the verified tunnel.
 */
export const resolvePreviewTunnelRequest = (args: {
  tunnelUrl: string;
  proxyPathname: string;
  proxyPrefix?: string;
  search?: string;
}): URL | null => {
  const prefix = args.proxyPrefix ?? "/vite-preview";
  if (
    args.proxyPathname !== prefix &&
    !args.proxyPathname.startsWith(`${prefix}/`)
  ) {
    return null;
  }
  const suffix = args.proxyPathname.slice(prefix.length) || "/";
  if (
    !suffix.startsWith("/") ||
    suffix.startsWith("//") ||
    suffix.includes("\\") ||
    ENCODED_PATH_SEPARATOR.test(suffix)
  ) {
    return null;
  }
  const normalized = normalizedTunnelUrl(args.tunnelUrl);
  if (!normalized) return null;
  const target = new URL(normalized);
  const verifiedOrigin = target.origin;
  const basePath = target.pathname.endsWith("/")
    ? target.pathname.slice(0, -1)
    : target.pathname;
  target.pathname = `${basePath}${suffix}`;
  target.search = args.search ?? "";
  target.hash = "";
  return target.origin === verifiedOrigin ? target : null;
};

const normalizedTunnelUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && url.port !== "443")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

export const parsePreviewAccessActiveRecord = (
  raw: unknown,
): PreviewAccessActiveRecord | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !==
    "buildSessionName,expiresAt,issuedAt,nonce,sandboxId,schemaVersion,state,tunnelUrl,turnId"
  ) {
    return null;
  }
  if (
    value.schemaVersion !== PREVIEW_ACCESS_SCHEMA_VERSION ||
    value.state !== "active" ||
    typeof value.buildSessionName !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.sandboxId !== "string" ||
    typeof value.issuedAt !== "number" ||
    typeof value.expiresAt !== "number" ||
    typeof value.nonce !== "string"
  ) {
    return null;
  }
  const tunnelUrl = normalizedTunnelUrl(value.tunnelUrl);
  if (!tunnelUrl) return null;
  const record: PreviewAccessActiveRecord = {
    schemaVersion: PREVIEW_ACCESS_SCHEMA_VERSION,
    state: "active",
    buildSessionName: value.buildSessionName,
    turnId: value.turnId,
    sandboxId: value.sandboxId,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    nonce: value.nonce,
    tunnelUrl,
  };
  if (
    !validIdentity(record) ||
    !Number.isSafeInteger(record.issuedAt) ||
    record.issuedAt < 0 ||
    !Number.isSafeInteger(record.expiresAt) ||
    record.expiresAt <= record.issuedAt ||
    record.expiresAt - record.issuedAt > PREVIEW_ACCESS_MAX_TTL_MS ||
    !NONCE_PATTERN.test(record.nonce)
  ) {
    return null;
  }
  return record;
};

export const previewAccessLogFields = (
  record: PreviewAccessActiveRecord,
): PreviewAccessLogFields => ({
  schemaVersion: record.schemaVersion,
  state: record.state,
  buildSessionName: record.buildSessionName,
  turnId: record.turnId,
  sandboxId: record.sandboxId,
  issuedAt: record.issuedAt,
  expiresAt: record.expiresAt,
});

export const issuePreviewAccessCapability = async (args: {
  identity: PreviewAccessIdentity;
  tunnelUrl: string;
  secret: string | Uint8Array;
  now: number;
  ttlMs: number;
  randomBytes?: (bytes: Uint8Array) => Uint8Array;
}): Promise<{
  capability: string;
  activeRecord: PreviewAccessActiveRecord;
}> => {
  if (!validIdentity(args.identity)) {
    throw new Error("Vite preview requires an exact bounded identity.");
  }
  if (
    !Number.isSafeInteger(args.now) ||
    args.now < 0 ||
    !Number.isSafeInteger(args.ttlMs) ||
    args.ttlMs <= 0 ||
    args.ttlMs > PREVIEW_ACCESS_MAX_TTL_MS ||
    !Number.isSafeInteger(args.now + args.ttlMs)
  ) {
    throw new Error("Vite preview lifetime is outside the bounded window.");
  }
  const tunnelUrl = normalizedTunnelUrl(args.tunnelUrl);
  if (!tunnelUrl) {
    throw new Error("Vite preview tunnel URL must be credential-free HTTPS.");
  }
  const entropy =
    args.randomBytes ?? ((bytes: Uint8Array) => crypto.getRandomValues(bytes));
  const generated = entropy(new Uint8Array(NONCE_BYTES));
  if (generated.byteLength !== NONCE_BYTES) {
    throw new Error("Vite preview entropy source returned the wrong length.");
  }
  const nonceBytes = new Uint8Array(NONCE_BYTES);
  nonceBytes.set(generated);
  const nonce = bytesToBase64Url(nonceBytes);
  const expiresAt = args.now + args.ttlMs;
  const claims = claimsFor({ identity: args.identity, expiresAt, nonce });
  const payloadSegment = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const key = await importHmacKey(args.secret, ["sign"]);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, signingInput(payloadSegment)),
  );
  if (signature.byteLength !== HMAC_BYTES) {
    throw new Error("Vite preview HMAC produced an invalid signature length.");
  }
  return {
    capability: `${TOKEN_PREFIX}.${payloadSegment}.${bytesToBase64Url(signature)}`,
    activeRecord: {
      schemaVersion: PREVIEW_ACCESS_SCHEMA_VERSION,
      state: "active",
      ...args.identity,
      issuedAt: args.now,
      expiresAt,
      nonce,
      tunnelUrl,
    },
  };
};

export const verifyPreviewAccessCapability = async (args: {
  capability: string;
  secret: string | Uint8Array;
  expected: PreviewAccessIdentity;
  activeRecord: unknown;
  now: number;
}): Promise<PreviewAccessVerification> => {
  if (
    !validIdentity(args.expected) ||
    !Number.isSafeInteger(args.now) ||
    args.now < 0
  ) {
    return { ok: false, code: "wrong_scope" };
  }
  const route = await verifiedClaims(args);
  if (!route.ok) return route;
  const claims = route.claims;
  if (args.now >= claims.e) return { ok: false, code: "expired" };
  if (
    claims.b !== args.expected.buildSessionName ||
    claims.t !== args.expected.turnId ||
    claims.s !== args.expected.sandboxId
  ) {
    return { ok: false, code: "wrong_scope" };
  }
  const active = parsePreviewAccessActiveRecord(args.activeRecord);
  if (
    !active ||
    active.issuedAt > args.now ||
    active.expiresAt !== claims.e ||
    active.buildSessionName !== claims.b ||
    active.turnId !== claims.t ||
    active.sandboxId !== claims.s ||
    active.nonce !== claims.n
  ) {
    return { ok: false, code: "inactive" };
  }
  return {
    ok: true,
    identity: args.expected,
    expiresAt: claims.e,
    tunnelUrl: active.tunnelUrl,
  };
};
