/**
 * Pure token-set representation + merge rules. This is the plaintext shape that
 * `data/secrets_crypto.ts#encryptSecret` seals into `oauth_credentials`. It is
 * only ever materialized inside internal mutations/actions and never returned
 * from a public function.
 */

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  /** Absolute expiry in ms, if known. */
  accessTokenExpiresAt?: number;
  /** Provider-issued scope string, space-delimited. */
  scope?: string;
  /** Validated tenant API origin from the provider token response, if any. */
  resourceOrigin?: string;
};

const isString = (value: unknown): value is string => typeof value === "string";

export const serializeTokenSet = (tokenSet: TokenSet): string =>
  JSON.stringify(tokenSet);

export const parseTokenSet = (raw: string): TokenSet => {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid token set payload");
  }
  const record = parsed as Record<string, unknown>;
  if (!isString(record.accessToken) || !isString(record.tokenType)) {
    throw new Error("Invalid token set payload");
  }
  return {
    accessToken: record.accessToken,
    tokenType: record.tokenType,
    refreshToken: isString(record.refreshToken) ? record.refreshToken : undefined,
    accessTokenExpiresAt:
      typeof record.accessTokenExpiresAt === "number"
        ? record.accessTokenExpiresAt
        : undefined,
    scope: isString(record.scope) ? record.scope : undefined,
    resourceOrigin: isString(record.resourceOrigin) ? record.resourceOrigin : undefined,
  };
};

/** Deduplicated set union of two scope lists, order-stable. */
export const unionScopes = (
  current: readonly string[],
  incoming: readonly string[],
): string[] => {
  const out = new Set<string>(current);
  for (const scope of incoming) out.add(scope);
  return [...out];
};

/**
 * Merge a fresh grant/refresh response into the existing token set.
 *
 * Hard rules (design §3.1, §6.2, §7.3):
 *  - If the new response omits a refresh token, PRESERVE the existing one.
 *  - Scopes are a set union; a narrower response never erases granted scopes
 *    (only explicit provider revocation may, handled elsewhere).
 */
export const mergeTokenSet = (
  existing: TokenSet | null,
  incoming: {
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    accessTokenExpiresAt?: number;
    scopes?: readonly string[];
    resourceOrigin?: string;
  },
): { tokenSet: TokenSet; grantedScopes: string[] } => {
  const existingScopes = existing?.scope
    ? existing.scope.split(/\s+/u).filter(Boolean)
    : [];
  const grantedScopes = unionScopes(existingScopes, incoming.scopes ?? []);
  const tokenSet: TokenSet = {
    accessToken: incoming.accessToken,
    // Preserve the previously stored refresh token when the provider omits one.
    refreshToken: incoming.refreshToken ?? existing?.refreshToken,
    tokenType: incoming.tokenType ?? existing?.tokenType ?? "Bearer",
    accessTokenExpiresAt: incoming.accessTokenExpiresAt,
    scope: grantedScopes.join(" ") || undefined,
    resourceOrigin: incoming.resourceOrigin ?? existing?.resourceOrigin,
  };
  return { tokenSet, grantedScopes };
};

/** Compute an absolute expiry from a provider `expires_in` (seconds). */
export const expiryFromExpiresIn = (
  expiresIn: unknown,
  now: number,
): number | undefined => {
  const seconds = typeof expiresIn === "number" ? expiresIn : Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return now + Math.floor(seconds) * 1000;
};

/** Whether an access token is fresh enough to use given the provider skew. */
export const accessTokenIsFresh = (
  accessTokenExpiresAt: number | undefined,
  refreshSkewMs: number,
  now: number,
): boolean => {
  if (typeof accessTokenExpiresAt !== "number") return false;
  return accessTokenExpiresAt > now + refreshSkewMs;
};
