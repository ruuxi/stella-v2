const TOKEN_PREFIX = "wc1";
const TOKEN_DOMAIN = "stella.world-attach.v1";
const WORLD_NAME = /^[0-9a-f]{64}:[0-9a-f]{64}$/u;

type WorldCapabilityClaims = {
  v: 1;
  w: string;
  t: string;
  g: number;
  e: number;
  n: string;
};

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const decodeBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const hmacKey = async (secret: string, usage: "sign" | "verify"): Promise<CryptoKey> => {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.byteLength < 32 || bytes.byteLength > 4_096) throw new Error("World capability secret is invalid.");
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
};

const signingInput = (payload: string): Uint8Array => new TextEncoder().encode(`${TOKEN_DOMAIN}.${payload}`);

export const issueWorldCapability = async (args: {
  secret: string;
  worldName: string;
  turnId: string;
  attemptGeneration: number;
  now: number;
  ttlMs: number;
}): Promise<string> => {
  if (!WORLD_NAME.test(args.worldName) || !args.turnId || !Number.isSafeInteger(args.attemptGeneration) || args.attemptGeneration < 1 || !Number.isSafeInteger(args.ttlMs) || args.ttlMs < 1 || args.ttlMs > 30 * 60_000) {
    throw new Error("World capability identity is invalid.");
  }
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const claims: WorldCapabilityClaims = { v: 1, w: args.worldName, t: args.turnId, g: args.attemptGeneration, e: args.now + args.ttlMs, n: nonce };
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(args.secret, "sign"), signingInput(payload));
  return `${TOKEN_PREFIX}.${payload}.${base64Url(new Uint8Array(signature))}`;
};

export const verifyWorldCapability = async (args: {
  secret: string;
  capability: string;
  worldName: string;
  now: number;
}): Promise<{ ok: true; claims: WorldCapabilityClaims } | { ok: false }> => {
  const [prefix, payload, signature, extra] = args.capability.split(".");
  if (prefix !== TOKEN_PREFIX || !payload || !signature || extra || !WORLD_NAME.test(args.worldName)) return { ok: false };
  const payloadBytes = decodeBase64Url(payload);
  const signatureBytes = decodeBase64Url(signature);
  if (!payloadBytes || !signatureBytes || signatureBytes.byteLength !== 32) return { ok: false };
  const verified = await crypto.subtle.verify("HMAC", await hmacKey(args.secret, "verify"), signatureBytes, signingInput(payload));
  if (!verified) return { ok: false };
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payloadBytes)) as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "e,g,n,t,v,w" || value.v !== 1 || value.w !== args.worldName || typeof value.t !== "string" || !value.t || !Number.isSafeInteger(value.g) || Number(value.g) < 1 || !Number.isSafeInteger(value.e) || Number(value.e) < args.now || typeof value.n !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(value.n)) return { ok: false };
    const claims: WorldCapabilityClaims = { v: 1, w: value.w, t: value.t, g: Number(value.g), e: Number(value.e), n: value.n };
    if (base64Url(new TextEncoder().encode(JSON.stringify(claims))) !== payload) return { ok: false };
    return { ok: true, claims };
  } catch {
    return { ok: false };
  }
};

export const worldCapabilityFromRequest = (request: Request): string => {
  const match = /^Bearer ([A-Za-z0-9._-]+)$/u.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? "";
};
