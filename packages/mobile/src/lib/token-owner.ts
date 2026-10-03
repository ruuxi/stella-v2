import { assert, assertObject } from "./assert";

const MAX_IDENTITY_CLAIM_CHARS = 1_024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const COMPACT_JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export type TokenOwner = Readonly<{
  /** The JWT `sub`: the owner id every backend API checks and echoes. */
  subject: string;
  expiresAtSeconds: number;
}>;

export type AuthenticatedTokenOwner = TokenOwner & Readonly<{ token: string }>;

export type TokenOwnerFence = Readonly<{
  accountScope: string;
  identityKey: string;
  identityRevision: number;
  userSubject: string;
}>;

export const isTokenOwnerFenceCurrent = (
  originating: TokenOwnerFence | null,
  current: TokenOwnerFence | null,
): boolean =>
  originating === current ||
  Boolean(
    originating &&
    current &&
    originating.accountScope === current.accountScope &&
    originating.identityKey === current.identityKey &&
    originating.identityRevision === current.identityRevision &&
    originating.userSubject === current.userSubject,
  );

const readExactIdentityClaim = (value: unknown, label: string): string => {
  assert(typeof value === "string", `Token ${label} is unavailable.`);
  assert(
    value.length > 0 &&
      value.length <= MAX_IDENTITY_CLAIM_CHARS &&
      value.normalize("NFC") === value &&
      value.trim() === value &&
      !CONTROL_CHARACTER_PATTERN.test(value),
    `Token ${label} is unavailable.`,
  );
  return value;
};

/**
 * Reads the owner claims carried by the current JWT without changing them.
 * This decode is not an authorization decision: the same bearer token is sent
 * to the backend, which verifies its signature and checks the subject before
 * serving owner data.
 */
export const decodeTokenOwner = (token: string): TokenOwner => {
  assert(
    typeof token === "string" &&
      token.length <= 16 * 1_024 &&
      COMPACT_JWT_PATTERN.test(token),
    "Token is unavailable.",
  );
  const segments = token.split(".");
  assert(
    segments.length === 3 && segments.every(Boolean),
    "Token payload is unavailable.",
  );
  assert(
    typeof globalThis.atob === "function",
    "Token payload is unavailable.",
  );
  const normalized = segments[1].replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  let parsed: unknown;
  try {
    parsed = JSON.parse(globalThis.atob(`${normalized}${padding}`)) as unknown;
  } catch {
    throw new Error("Token payload is unavailable.");
  }
  assertObject(parsed, "Token payload is unavailable.");
  assert(
    typeof parsed.exp === "number" &&
      Number.isSafeInteger(parsed.exp) &&
      parsed.exp > 0,
    "Token expiration is unavailable.",
  );
  const subject = readExactIdentityClaim(parsed.sub, "subject");
  return Object.freeze({ subject, expiresAtSeconds: parsed.exp });
};

/**
 * Loads one current token-owner proof, refreshing once when a prior account is
 * still cached. Persistent disagreement fails closed.
 */
export const resolveTokenOwner = async (options: {
  expectedSubject: string;
  getToken: (options: { forceRefresh: boolean }) => Promise<string>;
}): Promise<AuthenticatedTokenOwner> => {
  const expectedSubject = readExactIdentityClaim(
    options.expectedSubject,
    "expected subject",
  );
  const load = async (forceRefresh: boolean) => {
    const token = await options.getToken({ forceRefresh });
    return Object.freeze({ token, ...decodeTokenOwner(token) });
  };
  const matches = (owner: TokenOwner): boolean =>
    owner.subject === expectedSubject;

  let owner = await load(false);
  if (!matches(owner)) owner = await load(true);
  assert(matches(owner), "You need to sign in again.");
  return owner;
};
