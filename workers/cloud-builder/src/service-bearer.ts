const BEARER_CREDENTIAL = /^[A-Za-z0-9._~+/-]+={0,}$/u;
const MAX_BEARER_CREDENTIAL_LENGTH = 8_192;
const INVALID_LEFT_SECRET = "stella-invalid-left-secret";
const INVALID_RIGHT_SECRET = "stella-invalid-right-secret";

export const isValidServiceBearerSecret = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_BEARER_CREDENTIAL_LENGTH &&
  BEARER_CREDENTIAL.test(value);

export type ServiceBearerSubtleCrypto = {
  digest(
    algorithm: "SHA-256",
    data: ArrayBuffer | ArrayBufferView,
  ): Promise<ArrayBuffer>;
  timingSafeEqual?(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
};

export type ServiceBearerVerificationOptions = {
  /** Test seam for runtimes whose Web Crypto surface differs from Workerd. */
  subtle?: ServiceBearerSubtleCrypto;
};

const parseBearerCredential = (authorization: string | null): string | null => {
  if (
    authorization === null ||
    authorization.length > "Bearer ".length + MAX_BEARER_CREDENTIAL_LENGTH
  ) {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  const credential = match?.[1] ?? "";
  return credential.length > 0 &&
    credential.length <= MAX_BEARER_CREDENTIAL_LENGTH &&
    BEARER_CREDENTIAL.test(credential)
    ? credential
    : null;
};

const expectedCredential = (
  secret: string | null | undefined,
): string | null => (isValidServiceBearerSecret(secret) ? secret : null);

const isBoundedNonEmptySecret = (
  value: string | null | undefined,
): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_BEARER_CREDENTIAL_LENGTH;

/**
 * Fixed-length fallback for test/non-Workers runtimes. Production Workerd uses
 * `SubtleCrypto.timingSafeEqual`; both inputs have already been SHA-256 hashed.
 */
const equalFixedLengthBytes = (
  left: ArrayBuffer,
  right: ArrayBuffer,
): boolean => {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (leftBytes[index % leftBytes.byteLength] ?? 0) ^
      (rightBytes[index % rightBytes.byteLength] ?? 0);
  }
  return difference === 0;
};

/**
 * Compare two raw service secrets with fixed crypto work regardless of their
 * lengths or validity. Callers may apply stricter syntax before this boundary.
 */
export const fixedWorkSha256SecretEqual = async (
  left: string | null | undefined,
  right: string | null | undefined,
  options: ServiceBearerVerificationOptions = {},
): Promise<boolean> => {
  const leftValid = isBoundedNonEmptySecret(left);
  const rightValid = isBoundedNonEmptySecret(right);
  const subtle = options.subtle ?? crypto.subtle;
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    subtle.digest(
      "SHA-256",
      encoder.encode(leftValid ? left : INVALID_LEFT_SECRET),
    ),
    subtle.digest(
      "SHA-256",
      encoder.encode(rightValid ? right : INVALID_RIGHT_SECRET),
    ),
  ]);
  const hashesMatch =
    typeof subtle.timingSafeEqual === "function"
      ? subtle.timingSafeEqual(leftHash, rightHash)
      : equalFixedLengthBytes(leftHash, rightHash);
  return leftValid && rightValid && hashesMatch;
};

/**
 * Verify the Cloud Builder's server-to-server Bearer credential.
 *
 * Even absent or malformed inputs perform the same two SHA-256 operations and
 * one fixed-length comparison. Validity is applied only after that work, so no
 * malformed value can accidentally authorize through the sentinel path.
 */
export const verifyServiceBearerAuthorization = async (
  authorization: string | null,
  expectedSecret: string | null | undefined,
  options: ServiceBearerVerificationOptions = {},
): Promise<boolean> => {
  const presented = parseBearerCredential(authorization);
  const expected = expectedCredential(expectedSecret);
  return await fixedWorkSha256SecretEqual(presented, expected, options);
};

export const verifyServiceBearerRequest = async (
  request: Request,
  expectedSecret: string | null | undefined,
  options?: ServiceBearerVerificationOptions,
): Promise<boolean> =>
  await verifyServiceBearerAuthorization(
    request.headers.get("authorization"),
    expectedSecret,
    options,
  );
