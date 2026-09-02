/**
 * Mobile app integrity (iOS App Attest, Android Play Integrity).
 *
 * Native apps do not run a CAPTCHA. Instead the OS vouches that the request
 * comes from Stella's unmodified app on a real device:
 *
 *   1. The app asks Convex for a nonce (`POST /api/auth/integrity/challenge`).
 *   2. iOS: the app generates an App Attest key once per install and attests
 *      it against the nonce the first time; afterwards it produces an
 *      assertion against the nonce. Android: the app requests a Play
 *      Integrity token whose request hash binds the nonce.
 *   3. The proof travels as `x-stella-app-integrity` (base64url JSON) on the
 *      account-creation endpoints that web clients protect with Turnstile.
 *
 * Convex verifies the proof (App Attest cert chain and counter, or Google's
 * decode API and verdicts), consumes the nonce, and accepts the request. A
 * request may present either a Turnstile token or an integrity proof; the
 * server decides which it requires by which one is configured for the
 * caller's platform.
 */

export const APP_INTEGRITY_HEADER = "x-stella-app-integrity" as const;
export const APP_INTEGRITY_CHALLENGE_PATH = "/api/auth/integrity/challenge" as const;

/** Nonces are single-use and expire this long after issuance. */
export const APP_INTEGRITY_NONCE_TTL_MS = 5 * 60_000;

export type AppIntegrityPurpose = "anonymous-sign-in" | "magic-link";

export const APP_INTEGRITY_PURPOSES: readonly AppIntegrityPurpose[] = [
  "anonymous-sign-in",
  "magic-link",
];

export const isAppIntegrityPurpose = (value: unknown): value is AppIntegrityPurpose =>
  value === "anonymous-sign-in" || value === "magic-link";

/** `POST /api/auth/integrity/challenge` body and response. */
export type AppIntegrityChallengeRequest = { purpose: AppIntegrityPurpose };
export type AppIntegrityChallengeResponse = { nonce: string; expiresAt: number };

/**
 * The string both sides feed to the platform API. iOS hashes it to the
 * clientDataHash; Android hashes it to the requestHash. Binding the purpose
 * means a nonce minted for a magic link cannot vouch for an anonymous sign-in.
 */
export const appIntegrityChallengeString = (
  purpose: AppIntegrityPurpose,
  nonce: string,
): string => ["stella-app-integrity", purpose, nonce].join("\n");

export type AppIntegrityProof =
  | {
      platform: "ios";
      purpose: AppIntegrityPurpose;
      nonce: string;
      /** App Attest key id (base64) the app generated for this install. */
      keyId: string;
      /** base64 attestation object; present only on the key's first use. */
      attestation?: string;
      /** base64 assertion; present on every later use. */
      assertion?: string;
    }
  | {
      platform: "android";
      purpose: AppIntegrityPurpose;
      nonce: string;
      /** Play Integrity token from `requestIntegrityCheck`. */
      token: string;
    };

/** Server answers on the protected endpoints. */
export type AppIntegrityErrorCode =
  /** No usable proof (Turnstile or integrity) came with the request. */
  | "integrity_required"
  /** The proof failed verification. */
  | "integrity_invalid"
  /** iOS only: the key id is unknown to the server; the app must attest it again. */
  | "integrity_key_unknown";

export const APP_INTEGRITY_MAX_PROOF_BYTES = 64 * 1024;

const base64UrlEncode = (text: string): string =>
  btoa(unescape(encodeURIComponent(text)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const base64UrlDecode = (value: string): string => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return decodeURIComponent(escape(atob(padded)));
};

export const encodeAppIntegrityProof = (proof: AppIntegrityProof): string =>
  base64UrlEncode(JSON.stringify(proof));

const isBase64Text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  /^[A-Za-z0-9+/=_-]+$/.test(value);

/** Strict decode of the header value; null for anything malformed or oversized. */
export const decodeAppIntegrityProof = (
  headerValue: string | null | undefined,
): AppIntegrityProof | null => {
  const raw = headerValue?.trim();
  if (!raw || raw.length > APP_INTEGRITY_MAX_PROOF_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!isAppIntegrityPurpose(record.purpose)) return null;
  if (typeof record.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(record.nonce)) {
    return null;
  }
  if (record.platform === "ios") {
    if (!isBase64Text(record.keyId, 256)) return null;
    const attestation = record.attestation;
    const assertion = record.assertion;
    if (attestation !== undefined && !isBase64Text(attestation, APP_INTEGRITY_MAX_PROOF_BYTES)) {
      return null;
    }
    if (assertion !== undefined && !isBase64Text(assertion, 8_192)) return null;
    if ((attestation === undefined) === (assertion === undefined)) return null;
    return {
      platform: "ios",
      purpose: record.purpose,
      nonce: record.nonce,
      keyId: record.keyId,
      ...(attestation !== undefined ? { attestation } : {}),
      ...(assertion !== undefined ? { assertion } : {}),
    };
  }
  if (record.platform === "android") {
    if (!isBase64Text(record.token, 16_384) && typeof record.token !== "string") return null;
    if (typeof record.token !== "string" || !record.token || record.token.length > 16_384) {
      return null;
    }
    return {
      platform: "android",
      purpose: record.purpose,
      nonce: record.nonce,
      token: record.token,
    };
  }
  return null;
};
