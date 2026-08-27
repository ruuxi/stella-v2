import { assert, assertObject } from "./assert";

const MAX_IDENTITY_CLAIM_CHARS = 1_024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const COMPACT_JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export type ConvexTokenOwner = Readonly<{
  issuer: string;
  subject: string;
  tokenIdentifier: string;
  expiresAtSeconds: number;
}>;

export type AuthenticatedConvexTokenOwner = ConvexTokenOwner &
  Readonly<{ token: string }>;

export type ConvexTokenOwnerFence = Readonly<{
  accountScope: string;
  identityKey: string;
  identityRevision: number;
  userSubject: string;
}>;

export const isConvexTokenOwnerFenceCurrent = (
  originating: ConvexTokenOwnerFence | null,
  current: ConvexTokenOwnerFence | null,
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

const readExactIssuer = (value: unknown): string => {
  const issuer = readExactIdentityClaim(value, "issuer");
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error("Token issuer is unavailable.");
  }
  const local =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  assert(
    (url.protocol === "https:" || local) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      issuer === url.origin,
    "Token issuer is unavailable.",
  );
  return issuer;
};

/**
 * Reads the owner claims carried by the current Convex JWT without changing
 * either value. This decode is not an authorization decision: the same bearer
 * token is sent to Convex/the worker, which verifies its signature and checks
 * the exact issuer-qualified subject before serving owner data.
 */
export const decodeConvexTokenOwner = (token: string): ConvexTokenOwner => {
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
  const issuer = readExactIssuer(parsed.iss);
  const subject = readExactIdentityClaim(parsed.sub, "subject");
  return Object.freeze({
    issuer,
    subject,
    tokenIdentifier: `${issuer}|${subject}`,
    expiresAtSeconds: parsed.exp,
  });
};

/**
 * Loads one current token-owner proof, refreshing once when a prior account or
 * issuer is still cached. Persistent disagreement fails closed.
 */
export const resolveConvexTokenOwner = async (options: {
  expectedSubject: string;
  expectedTokenIdentifier?: string;
  getToken: (options: { forceRefresh: boolean }) => Promise<string>;
}): Promise<AuthenticatedConvexTokenOwner> => {
  const expectedSubject = readExactIdentityClaim(
    options.expectedSubject,
    "expected subject",
  );
  const expectedTokenIdentifier =
    options.expectedTokenIdentifier === undefined
      ? undefined
      : readExactIdentityClaim(
          options.expectedTokenIdentifier,
          "expected token identifier",
        );
  const load = async (forceRefresh: boolean) => {
    const token = await options.getToken({ forceRefresh });
    return Object.freeze({ token, ...decodeConvexTokenOwner(token) });
  };
  const matches = (owner: ConvexTokenOwner): boolean =>
    owner.subject === expectedSubject &&
    (expectedTokenIdentifier === undefined ||
      owner.tokenIdentifier === expectedTokenIdentifier);

  let owner = await load(false);
  if (!matches(owner)) owner = await load(true);
  assert(matches(owner), "You need to sign in again.");
  return owner;
};
