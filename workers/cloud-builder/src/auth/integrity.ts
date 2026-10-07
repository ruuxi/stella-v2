/**
 * Mobile app integrity and web Turnstile proofs for the sign-in endpoints.
 *
 * Native apps run no CAPTCHA: iOS App Attest or Android Play Integrity vouch
 * for an unmodified app on a real device, bound to a one-time nonce from
 * `POST /api/auth/integrity/challenge`. Web clients answer Turnstile instead.
 *
 * `STELLA_APP_INTEGRITY_MODE=off` (dev) accepts any well-formed proof for the
 * right purpose without verifying it; with no Turnstile key either, requests
 * without a proof pass too.
 *
 * App Attest is verified with `@peculiar/x509` and WebCrypto: `node-app-attest`
 * depends on Node streams (through `cbor`) that do not load in workerd.
 */

import {
  APP_INTEGRITY_HEADER,
  APP_INTEGRITY_NONCE_TTL_MS,
  appIntegrityChallengeString,
  decodeAppIntegrityProof,
  type AppIntegrityErrorCode,
  type AppIntegrityProof,
  type AppIntegrityPurpose,
} from "@stella/contracts/app-integrity";
import { AUTH_CAPTCHA_HEADER } from "@stella/contracts/auth-challenge";
import { importPKCS8, SignJWT } from "jose";

type IntegrityEnv = Pick<Cloudflare.Env, "DB">;

export type AuthProofResult =
  | { ok: true }
  | { ok: false; code: AppIntegrityErrorCode };

type VerificationResult =
  | { ok: true }
  | { ok: false; code: "integrity_invalid" | "integrity_key_unknown" };

const APPLE_BUNDLE_IDENTIFIER = "com.stella.mobile";
const ANDROID_PACKAGE_NAME = "com.fromyou.stella";
const PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const PLAY_INTEGRITY_DECODE_URL = `https://playintegrity.googleapis.com/v1/${ANDROID_PACKAGE_NAME}:decodeIntegrityToken`;
const PLAY_INTEGRITY_MAX_AGE_MS = 10 * 60_000;
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const APPLE_APP_ATTESTATION_ROOT_CA =
  "MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD";
const APP_ATTEST_NONCE_OID = "1.2.840.113635.100.8.2";
const AAGUID_DEVELOPMENT = "appattestdevelop";
const AAGUID_PRODUCTION = "appattest\0\0\0\0\0\0\0";

const configured = (env: unknown, name: string): string | undefined => {
  const value = (env as Record<string, unknown>)[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
};

const db = (env: IntegrityEnv): D1Database => {
  if (!env.DB) throw new Error("D1 is not bound.");
  return env.DB;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

let loggedOff = false;

export const integrityMode = (env: unknown): "enforce" | "off" => {
  const mode = configured(env, "STELLA_APP_INTEGRITY_MODE");
  if (mode === "enforce" || mode === "off") return mode;
  if (mode !== undefined) throw new Error('STELLA_APP_INTEGRITY_MODE must be "enforce" or "off".');
  return configured(env, "APPLE_APP_ATTEST_TEAM_ID") ||
    configured(env, "GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON")
    ? "enforce"
    : "off";
};

export const turnstileSecret = (env: unknown): string | undefined =>
  configured(env, "TURNSTILE_SECRET_KEY");

/** Which proof purpose an auth path needs, or null when it needs none. */
export const integrityPurposeForPath = (path: string | undefined): AppIntegrityPurpose | null => {
  if (path === "/sign-in/anonymous") return "anonymous-sign-in";
  if (path === "/sign-in/magic-link" || path === "/link/send") return "magic-link";
  return null;
};

export const integrityErrorMessage = (code: AppIntegrityErrorCode): string => {
  switch (code) {
    case "integrity_required":
      return "This request needs a verification proof.";
    case "integrity_key_unknown":
      return "The app integrity key is not registered.";
    case "integrity_invalid":
      return "The verification proof is invalid.";
  }
};

// ── Nonces ─────────────────────────────────────────────────────────────────

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

export const issueIntegrityNonce = async (
  env: IntegrityEnv,
  purpose: AppIntegrityPurpose,
): Promise<{ nonce: string; expiresAt: number }> => {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const createdAt = Date.now();
  const expiresAt = createdAt + APP_INTEGRITY_NONCE_TTL_MS;
  await db(env)
    .prepare("INSERT INTO integrity_nonces (nonce, purpose, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(nonce, purpose, createdAt, expiresAt)
    .run();
  return { nonce, expiresAt };
};

/** Burn the nonce whatever the verdict, so a failed proof cannot be replayed. */
const consumeNonce = async (env: IntegrityEnv, nonce: string, purpose: AppIntegrityPurpose, now: number) => {
  const row = await db(env)
    .prepare(
      `UPDATE integrity_nonces SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL
       RETURNING purpose, expires_at AS expiresAt`,
    )
    .bind(now, nonce)
    .first<{ purpose: string; expiresAt: number }>();
  return row !== null && row.purpose === purpose && row.expiresAt > now;
};

// ── Turnstile ──────────────────────────────────────────────────────────────

export const verifyTurnstile = async (env: unknown, token: string, remoteIp?: string): Promise<boolean> => {
  const secret = turnstileSecret(env);
  if (!secret) return true;
  if (!token.trim()) return false;
  try {
    const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token.trim(), ...(remoteIp ? { remoteip: remoteIp } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = response.ok ? await response.json() : null;
    return isRecord(body) && body.success === true;
  } catch {
    return false;
  }
};

// ── The rule ───────────────────────────────────────────────────────────────

/**
 * A request to a protected endpoint passes with a valid integrity proof or a
 * valid Turnstile answer. `captchaVerified` means the captcha plugin already
 * spent the Turnstile token (anonymous sign-in); Turnstile tokens are single
 * use, so it is not checked twice.
 */
export const verifyAuthRequestProof = async (args: {
  env: IntegrityEnv;
  request: Request;
  purpose: AppIntegrityPurpose;
  captchaVerified?: boolean;
}): Promise<AuthProofResult> => {
  const { env, request, purpose } = args;
  const mode = integrityMode(env);
  if (mode === "off" && !loggedOff) {
    loggedOff = true;
    console.warn("[auth] App integrity is OFF (local development mode)");
  }
  const turnstileEnabled = turnstileSecret(env) !== undefined;
  const captcha = request.headers.get(AUTH_CAPTCHA_HEADER)?.trim() ?? "";
  const integrityHeader = request.headers.get(APP_INTEGRITY_HEADER)?.trim() ?? "";
  let sawInvalidProof = false;

  if (turnstileEnabled && captcha) {
    if (args.captchaVerified) return { ok: true };
    if (await verifyTurnstile(env, captcha, request.headers.get("cf-connecting-ip") ?? undefined)) {
      return { ok: true };
    }
    sawInvalidProof = true;
  }

  if (integrityHeader) {
    const proof = decodeAppIntegrityProof(integrityHeader);
    if (!proof || proof.purpose !== purpose) {
      sawInvalidProof = true;
    } else if (mode === "off") {
      return { ok: true };
    } else if (!(await consumeNonce(env, proof.nonce, purpose, Date.now()))) {
      sawInvalidProof = true;
    } else {
      return await verifyIntegrityProof(env, proof);
    }
  }

  if (!turnstileEnabled && mode === "off") return { ok: true };
  return { ok: false, code: sawInvalidProof ? "integrity_invalid" : "integrity_required" };
};

const verifyIntegrityProof = async (env: IntegrityEnv, proof: AppIntegrityProof): Promise<VerificationResult> => {
  const challenge = appIntegrityChallengeString(proof.purpose, proof.nonce);
  try {
    return proof.platform === "ios"
      ? await verifyIosProof(env, proof, challenge)
      : await verifyAndroidProof(env, proof, challenge);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "app_integrity_verification_failed",
        platform: proof.platform,
        reason: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return { ok: false, code: "integrity_invalid" };
  }
};

// ── iOS App Attest ─────────────────────────────────────────────────────────

const sha256 = async (data: Uint8Array | string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      typeof data === "string" ? new TextEncoder().encode(data) : (data as Uint8Array<ArrayBuffer>),
    ),
  );

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** The subset of CBOR App Attest objects use: ints, byte and text strings, arrays, maps, tags. */
const decodeCbor = (bytes: Uint8Array): unknown => {
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return bytes[offset++]!;
    if (info === 25) return (offset += 2), view.getUint16(offset - 2);
    if (info === 26) return (offset += 4), view.getUint32(offset - 4);
    if (info === 27) return (offset += 8), Number(view.getBigUint64(offset - 8));
    throw new Error("Unsupported CBOR length.");
  };
  const item = (): unknown => {
    if (offset >= bytes.length) throw new Error("Truncated CBOR.");
    const initial = bytes[offset++]!;
    const major = initial >> 5;
    const info = initial & 31;
    switch (major) {
      case 0:
        return length(info);
      case 1:
        return -1 - length(info);
      case 2: {
        const size = length(info);
        if (offset + size > bytes.length) throw new Error("Truncated CBOR.");
        return bytes.slice(offset, (offset += size));
      }
      case 3: {
        const size = length(info);
        if (offset + size > bytes.length) throw new Error("Truncated CBOR.");
        return new TextDecoder().decode(bytes.subarray(offset, (offset += size)));
      }
      case 4:
        return Array.from({ length: length(info) }, item);
      case 5: {
        const map: Record<string, unknown> = {};
        for (let index = length(info); index > 0; index -= 1) map[String(item())] = item();
        return map;
      }
      case 6:
        length(info);
        return item();
      default:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        throw new Error("Unsupported CBOR item.");
    }
  };
  const value = item();
  if (offset !== bytes.length) throw new Error("Trailing CBOR bytes.");
  return value;
};

/** The children of a DER constructed value. */
const derChildren = (bytes: Uint8Array): Array<{ tag: number; value: Uint8Array }> => {
  const children: Array<{ tag: number; value: Uint8Array }> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset++]!;
    let size = bytes[offset++]!;
    if (size & 0x80) {
      const count = size & 0x7f;
      size = 0;
      for (let index = 0; index < count; index += 1) size = (size << 8) | bytes[offset++]!;
    }
    children.push({ tag, value: bytes.subarray(offset, offset + size) });
    offset += size;
  }
  return children;
};

/** DER ECDSA signature to the r||s form WebCrypto verifies. */
const derToP1363 = (signature: Uint8Array, size: number): Uint8Array => {
  const [sequence] = derChildren(signature);
  if (sequence?.tag !== 0x30) throw new Error("Malformed ECDSA signature.");
  const out = new Uint8Array(size * 2);
  derChildren(sequence.value).forEach((integer, index) => {
    const value = integer.value.subarray(Math.max(0, integer.value.length - size));
    out.set(value, index * size + (size - value.length));
  });
  return out;
};

const readAuthData = (authData: Uint8Array) => {
  if (authData.length < 37) throw new Error("Authenticator data is too short.");
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  return { rpIdHash: authData.subarray(0, 32), signCount: view.getUint32(33) };
};

const verifyAttestation = async (args: {
  attestation: Uint8Array;
  challenge: string;
  keyId: string;
  teamIdentifier: string;
  allowDevelopmentEnvironment: boolean;
}): Promise<string> => {
  const x509 = await import("@peculiar/x509");
  x509.cryptoProvider.set(crypto);
  const decoded = decodeCbor(args.attestation);
  if (!isRecord(decoded) || decoded.fmt !== "apple-appattest" || !isRecord(decoded.attStmt)) {
    throw new Error("invalid attestation");
  }
  const { x5c, receipt } = decoded.attStmt;
  const authData = decoded.authData;
  if (
    !Array.isArray(x5c) ||
    x5c.length !== 2 ||
    !x5c.every((entry) => entry instanceof Uint8Array) ||
    !(receipt instanceof Uint8Array) ||
    !(authData instanceof Uint8Array)
  ) {
    throw new Error("invalid attestation");
  }
  // 1. The chain: credential certificate ← App Attestation CA 1 ← Apple's root.
  const certificates = (x5c as Uint8Array[]).map((entry) => new x509.X509Certificate(entry as Uint8Array<ArrayBuffer>));
  const subCa = certificates.find((cert) => cert.subject.includes("Apple App Attestation CA 1"));
  const leaf = certificates.find((cert) => !cert.subject.includes("Apple App Attestation CA 1"));
  if (!subCa || !leaf) throw new Error("incomplete certificate chain");
  const root = new x509.X509Certificate(APPLE_APP_ATTESTATION_ROOT_CA);
  if (!(await subCa.verify({ publicKey: root.publicKey, signatureOnly: true }))) {
    throw new Error("sub CA is not signed by the Apple App Attestation root");
  }
  if (!(await leaf.verify({ publicKey: subCa.publicKey, signatureOnly: true }))) {
    throw new Error("credential certificate is not signed by the sub CA");
  }
  // 2-4. nonce = SHA256(authData || SHA256(challenge)) equals the credCert extension.
  const nonce = await sha256(concat(authData, await sha256(args.challenge)));
  const extension = leaf.getExtension(APP_ATTEST_NONCE_OID);
  const [sequence] = extension ? derChildren(new Uint8Array(extension.value)) : [];
  const [tagged] = sequence ? derChildren(sequence.value) : [];
  const [octets] = tagged ? derChildren(tagged.value) : [];
  if (!octets || octets.tag !== 0x04 || !equalBytes(octets.value, nonce)) throw new Error("nonce does not match");
  // 5. SHA256 of the credential public key is the key id.
  const spki = new Uint8Array(leaf.publicKey.rawData);
  const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  const point = new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
  if (toBase64(await sha256(point)) !== args.keyId) throw new Error("keyId does not match");
  // 6. The RP id hash is SHA256 of the App ID.
  const { rpIdHash, signCount } = readAuthData(authData);
  if (!equalBytes(rpIdHash, await sha256(`${args.teamIdentifier}.${APPLE_BUNDLE_IDENTIFIER}`))) {
    throw new Error("appId does not match");
  }
  // 7. A fresh key has counter 0.
  if (signCount !== 0) throw new Error("signCount is not 0");
  // 8. The environment.
  if (authData.length < 55) throw new Error("Authenticator data is too short.");
  const aaguid = new TextDecoder().decode(authData.subarray(37, 53));
  if (aaguid !== AAGUID_PRODUCTION && aaguid !== AAGUID_DEVELOPMENT) throw new Error("aaguid is not valid");
  if (aaguid === AAGUID_DEVELOPMENT && !args.allowDevelopmentEnvironment) {
    throw new Error("development environment is not allowed");
  }
  // 9. The credential id is the key id.
  const credentialIdLength = (authData[53]! << 8) | authData[54]!;
  if (toBase64(authData.subarray(55, 55 + credentialIdLength)) !== args.keyId) {
    throw new Error("credentialId does not match");
  }
  return toBase64(spki);
};

const verifyAssertion = async (args: {
  assertion: Uint8Array;
  payload: string;
  publicKey: string;
  teamIdentifier: string;
  signCount: number;
}): Promise<number> => {
  const decoded = decodeCbor(args.assertion);
  if (!isRecord(decoded)) throw new Error("invalid assertion");
  const { signature, authenticatorData } = decoded;
  if (!(signature instanceof Uint8Array) || !(authenticatorData instanceof Uint8Array)) {
    throw new Error("invalid assertion");
  }
  // 1-3. The signature covers SHA256(authenticatorData || SHA256(clientData)).
  const nonce = await sha256(concat(authenticatorData, await sha256(args.payload)));
  const key = await crypto.subtle.importKey(
    "spki",
    fromBase64(args.publicKey) as Uint8Array<ArrayBuffer>,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    derToP1363(signature, 32) as Uint8Array<ArrayBuffer>,
    nonce as Uint8Array<ArrayBuffer>,
  );
  if (!valid) throw new Error("invalid signature");
  // 4-5. The App ID, and a counter that only moves forward.
  const { rpIdHash, signCount } = readAuthData(authenticatorData);
  if (!equalBytes(rpIdHash, await sha256(`${args.teamIdentifier}.${APPLE_BUNDLE_IDENTIFIER}`))) {
    throw new Error("appId does not match");
  }
  if (signCount <= args.signCount) throw new Error("invalid signCount");
  return signCount;
};

const verifyIosProof = async (
  env: IntegrityEnv,
  proof: Extract<AppIntegrityProof, { platform: "ios" }>,
  challenge: string,
): Promise<VerificationResult> => {
  const teamIdentifier = configured(env, "APPLE_APP_ATTEST_TEAM_ID");
  if (!teamIdentifier) return { ok: false, code: "integrity_invalid" };
  const now = Date.now();
  const existing = await db(env)
    .prepare("SELECT public_key AS publicKey, sign_count AS signCount FROM app_attest_keys WHERE key_id = ?")
    .bind(proof.keyId)
    .first<{ publicKey: string; signCount: number }>();

  if (proof.attestation !== undefined) {
    if (existing) return { ok: false, code: "integrity_invalid" };
    const publicKey = await verifyAttestation({
      attestation: fromBase64(proof.attestation),
      challenge,
      keyId: proof.keyId,
      teamIdentifier,
      allowDevelopmentEnvironment: configured(env, "STELLA_APP_ATTEST_ALLOW_DEVELOPMENT") === "1",
    });
    const stored = await db(env)
      .prepare(
        `INSERT INTO app_attest_keys (key_id, public_key, sign_count, created_at, last_used_at)
         VALUES (?, ?, 0, ?, ?) ON CONFLICT (key_id) DO NOTHING`,
      )
      .bind(proof.keyId, publicKey, now, now)
      .run();
    return (stored.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false, code: "integrity_invalid" };
  }

  if (proof.assertion === undefined) return { ok: false, code: "integrity_invalid" };
  if (!existing) return { ok: false, code: "integrity_key_unknown" };
  const signCount = await verifyAssertion({
    assertion: fromBase64(proof.assertion),
    payload: challenge,
    publicKey: existing.publicKey,
    teamIdentifier,
    signCount: existing.signCount,
  });
  const advanced = await db(env)
    .prepare("UPDATE app_attest_keys SET sign_count = ?, last_used_at = ? WHERE key_id = ? AND sign_count = ?")
    .bind(signCount, now, proof.keyId, existing.signCount)
    .run();
  return (advanced.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false, code: "integrity_invalid" };
};

// ── Android Play Integrity ─────────────────────────────────────────────────

let cachedGoogleToken: { digest: string; accessToken: string; expiresAt: number } | undefined;

const googleAccessToken = async (serviceAccountJson: string, now: number): Promise<string> => {
  const digest = toBase64Url(await sha256(serviceAccountJson));
  if (cachedGoogleToken?.digest === digest && cachedGoogleToken.expiresAt > now + 60_000) {
    return cachedGoogleToken.accessToken;
  }
  const account: unknown = JSON.parse(serviceAccountJson);
  if (
    !isRecord(account) ||
    typeof account.client_email !== "string" ||
    typeof account.private_key !== "string"
  ) {
    throw new Error("Google Play Integrity service-account credentials are incomplete.");
  }
  const key = await importPKCS8(account.private_key.replace(/\\n/g, "\n"), "RS256");
  const issuedAt = Math.floor(now / 1000);
  const assertion = await new SignJWT({ scope: PLAY_INTEGRITY_SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(account.client_email)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(key);
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Google OAuth token exchange failed (${response.status}).`);
  const body: unknown = await response.json();
  const expiresIn = isRecord(body) ? Number(body.expires_in) : NaN;
  if (!isRecord(body) || typeof body.access_token !== "string" || !(expiresIn > 0)) {
    throw new Error("Google OAuth token response was incomplete.");
  }
  cachedGoogleToken = { digest, accessToken: body.access_token, expiresAt: now + expiresIn * 1000 };
  return body.access_token;
};

const verifyAndroidProof = async (
  env: IntegrityEnv,
  proof: Extract<AppIntegrityProof, { platform: "android" }>,
  challenge: string,
): Promise<VerificationResult> => {
  const serviceAccountJson = configured(env, "GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON");
  if (!serviceAccountJson) return { ok: false, code: "integrity_invalid" };
  const now = Date.now();
  const response = await fetch(PLAY_INTEGRITY_DECODE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await googleAccessToken(serviceAccountJson, now)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ integrityToken: proof.token }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Play Integrity decode failed (${response.status}).`);
  const body: unknown = await response.json();
  const decoded = isRecord(body) ? body.tokenPayloadExternal : null;
  if (!isRecord(decoded)) return { ok: false, code: "integrity_invalid" };
  const { requestDetails, appIntegrity, deviceIntegrity } = decoded;
  if (!isRecord(requestDetails) || !isRecord(appIntegrity) || !isRecord(deviceIntegrity)) {
    return { ok: false, code: "integrity_invalid" };
  }
  const timestamp = Number(requestDetails.timestampMillis);
  const allowUnrecognized = configured(env, "STELLA_PLAY_INTEGRITY_ALLOW_UNRECOGNIZED") === "1";
  const appVerdict = appIntegrity.appRecognitionVerdict;
  const deviceVerdicts = deviceIntegrity.deviceRecognitionVerdict;
  const accepted =
    requestDetails.requestPackageName === ANDROID_PACKAGE_NAME &&
    requestDetails.requestHash === toBase64Url(await sha256(challenge)) &&
    Number.isSafeInteger(timestamp) &&
    Math.abs(now - timestamp) <= PLAY_INTEGRITY_MAX_AGE_MS &&
    (appVerdict === "PLAY_RECOGNIZED" || (allowUnrecognized && appVerdict === "UNRECOGNIZED_VERSION")) &&
    Array.isArray(deviceVerdicts) &&
    deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY");
  return accepted ? { ok: true } : { ok: false, code: "integrity_invalid" };
};
