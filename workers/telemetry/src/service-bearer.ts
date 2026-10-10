import { bearerCredential, MAX_BEARER_CREDENTIAL_LENGTH as MAX_LENGTH } from "../../shared/bearer.js";

const CREDENTIAL = /^[A-Za-z0-9._~+/-]+={0,}$/u;
const INVALID_LEFT = "stella-invalid-left-secret";
const INVALID_RIGHT = "stella-invalid-right-secret";

const bounded = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_LENGTH;

const parseBearer = (authorization: string | null): string | null => {
  const value = bearerCredential(authorization, MAX_LENGTH);
  return value !== null && CREDENTIAL.test(value) ? value : null;
};

const fixedLengthEqual = (left: ArrayBuffer, right: ArrayBuffer): boolean => {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = a.byteLength ^ b.byteLength;
  const length = Math.max(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % a.byteLength] ?? 0) ^ (b[index % b.byteLength] ?? 0);
  }
  return difference === 0;
};

/** Always performs two SHA-256 operations and one fixed-length comparison. */
export const verifyServiceBearer = async (
  authorization: string | null,
  expectedSecret: string | null | undefined,
): Promise<boolean> => {
  const presented = parseBearer(authorization);
  const expected = bounded(expectedSecret) && CREDENTIAL.test(expectedSecret)
    ? expectedSecret
    : null;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented ?? INVALID_LEFT)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected ?? INVALID_RIGHT)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
  };
  const equal = typeof subtle.timingSafeEqual === "function"
    ? subtle.timingSafeEqual(left, right)
    : fixedLengthEqual(left, right);
  return presented !== null && expected !== null && equal;
};
