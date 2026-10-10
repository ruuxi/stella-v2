/** The longest credential an `Authorization: Bearer` header may carry by default. */
export const MAX_BEARER_CREDENTIAL_LENGTH = 8_192;

/**
 * The credential of an `Authorization: Bearer <credential>` header, or null.
 *
 * The scheme is matched case-insensitively (RFC 7235). The credential is one
 * whitespace-free token of at most `maxLength` characters; anything else,
 * including an oversized header, is no credential at all.
 */
export const bearerCredential = (
  authorization: string | null | undefined,
  maxLength = MAX_BEARER_CREDENTIAL_LENGTH,
): string | null => {
  // Bound the header before the regex; the slack covers the scheme and spaces.
  if (!authorization || authorization.length > maxLength + 64) return null;
  const credential = /^\s*Bearer\s+(\S+)\s*$/iu.exec(authorization)?.[1];
  return credential && credential.length <= maxLength ? credential : null;
};
