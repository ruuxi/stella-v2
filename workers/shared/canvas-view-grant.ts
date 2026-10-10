/**
 * Who may open a private canvas link. cloud-builder mints the tokens and the
 * canvas-share Worker checks them; both hold `CANVAS_SHARE_VIEW_SECRET`.
 *
 * - A **grant** is minted by `shares.viewLink` for one canvas, on behalf of
 *   its signed-in owner, and lives for minutes. It rides in the link's
 *   `?grant=` query.
 * - A **view** token is what the canvas-share Worker trades a valid grant for:
 *   an HttpOnly cookie on the share domain that opens every private canvas of
 *   the same owner until it expires. The Worker then redirects to the clean
 *   link, so the grant never stays in the address bar where the canvas's own
 *   scripts could read it.
 *
 * Tokens name the owner by `canvasOwnerTag`, never by the account id, and a
 * private object carries the same tag in its R2 metadata.
 *
 * Format: `base64url(JSON claims) "." base64url(HMAC-SHA256(secret, payload))`.
 */

export const CANVAS_VIEW_GRANT_PARAM = "grant";
export const CANVAS_VIEW_COOKIE = "stella_canvas_view";
export const CANVAS_VIEW_GRANT_TTL_MS = 5 * 60 * 1000;
export const CANVAS_VIEW_COOKIE_TTL_MS = 24 * 60 * 60 * 1000;

export type CanvasViewClaims = {
  /** `grant` (one canvas, minutes) or `view` (the cookie, every canvas of `o`). */
  k: "grant" | "view";
  /** The owner's tag (`canvasOwnerTag`). */
  o: string;
  /** The share slug a grant is for. Absent on view tokens. */
  s?: string;
  /** Expiry, epoch ms. */
  e: number;
};

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};

const hmacKey = (secret: string, usage: "sign" | "verify"): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );

/** The owner as private canvases name it: a one-way tag, not the account id. */
export const canvasOwnerTag = async (ownerId: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`stella-canvas-owner:${ownerId}`),
  );
  return toBase64Url(new Uint8Array(digest)).slice(0, 32);
};

export const signCanvasViewToken = async (
  secret: string,
  claims: CanvasViewClaims,
): Promise<string> => {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(payload),
  );
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
};

/** The token's claims when its signature holds and it has not expired, else null. */
export const verifyCanvasViewToken = async (
  secret: string,
  token: string,
  now: number,
): Promise<CanvasViewClaims | null> => {
  if (token.length > 1024) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const signatureBytes = fromBase64Url(signature);
  if (!signatureBytes) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signatureBytes,
    encoder.encode(payload),
  );
  if (!valid) return null;
  const payloadBytes = fromBase64Url(payload);
  if (!payloadBytes) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object") return null;
  const record = claims as Record<string, unknown>;
  if (record.k !== "grant" && record.k !== "view") return null;
  if (typeof record.o !== "string" || !record.o) return null;
  if (typeof record.e !== "number" || !Number.isFinite(record.e) || record.e <= now) {
    return null;
  }
  if (record.s !== undefined && typeof record.s !== "string") return null;
  return {
    k: record.k,
    o: record.o,
    e: record.e,
    ...(typeof record.s === "string" ? { s: record.s } : {}),
  };
};
