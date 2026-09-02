"use node";

import {
  appIntegrityChallengeString,
  type AppIntegrityProof,
} from "@stella/contracts/app-integrity";
import { createHash } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { verifyAssertion, verifyAttestation } from "node-app-attest";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { IntegrityVerificationResult } from "./lib/app_integrity";

const APPLE_BUNDLE_IDENTIFIER = "com.stella.mobile";
const ANDROID_PACKAGE_NAME = "com.fromyou.stella";
const PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const PLAY_INTEGRITY_DECODE_URL = `https://playintegrity.googleapis.com/v1/${ANDROID_PACKAGE_NAME}:decodeIntegrityToken`;
const PLAY_INTEGRITY_MAX_AGE_MS = 10 * 60_000;

type AppAttestKey = {
  keyId: string;
  publicKey: string;
  signCount: number;
  createdAt: number;
  lastUsedAt: number;
};

type GoogleServiceAccount = {
  clientEmail: string;
  privateKey: string;
};

type CachedAccessToken = {
  credentialDigest: string;
  accessToken: string;
  expiresAt: number;
};

const appIntegrityProofValidator = v.union(
  v.object({
    platform: v.literal("ios"),
    purpose: v.union(v.literal("anonymous-sign-in"), v.literal("magic-link")),
    nonce: v.string(),
    keyId: v.string(),
    attestation: v.optional(v.string()),
    assertion: v.optional(v.string()),
  }),
  v.object({
    platform: v.literal("android"),
    purpose: v.union(v.literal("anonymous-sign-in"), v.literal("magic-link")),
    nonce: v.string(),
    token: v.string(),
  }),
);

const integrityVerificationResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    platform: v.union(v.literal("ios"), v.literal("android")),
  }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("integrity_invalid"),
      v.literal("integrity_key_unknown"),
    ),
  }),
);

const getAppAttestKeyRef = makeFunctionReference<
  "query",
  { keyId: string },
  AppAttestKey | null
>("app_integrity:getAppAttestKeyInternal") as unknown as FunctionReference<
  "query",
  "internal",
  { keyId: string },
  AppAttestKey | null
>;

const storeAppAttestKeyRef = makeFunctionReference<
  "mutation",
  { keyId: string; publicKey: string; now: number },
  boolean
>("app_integrity:storeAppAttestKeyInternal") as unknown as FunctionReference<
  "mutation",
  "internal",
  { keyId: string; publicKey: string; now: number },
  boolean
>;

const advanceAppAttestSignCountRef = makeFunctionReference<
  "mutation",
  {
    keyId: string;
    expectedSignCount: number;
    signCount: number;
    now: number;
  },
  boolean
>(
  "app_integrity:advanceAppAttestSignCountInternal",
) as unknown as FunctionReference<
  "mutation",
  "internal",
  {
    keyId: string;
    expectedSignCount: number;
    signCount: number;
    now: number;
  },
  boolean
>;

let cachedAccessToken: CachedAccessToken | undefined;
let pendingAccessToken:
  | { credentialDigest: string; promise: Promise<CachedAccessToken> }
  | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const configuredValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const parseGoogleServiceAccount = (raw: string): GoogleServiceAccount => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      "GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON is not valid JSON.",
    );
  }
  if (!isRecord(value)) {
    throw new Error(
      "GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON must be an object.",
    );
  }
  const clientEmail = value.client_email;
  const privateKey = value.private_key;
  if (
    typeof clientEmail !== "string" ||
    !clientEmail.trim() ||
    typeof privateKey !== "string" ||
    !privateKey.includes("BEGIN PRIVATE KEY")
  ) {
    throw new Error(
      "Google Play Integrity service-account credentials are incomplete.",
    );
  }
  return {
    clientEmail: clientEmail.trim(),
    privateKey: privateKey.replace(/\\n/g, "\n"),
  };
};

const readPositiveNumber = (value: unknown): number | null => {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
};

const createGoogleServiceAccountAssertion = async (
  serviceAccount: GoogleServiceAccount,
  now: number,
): Promise<string> => {
  const key = await importPKCS8(serviceAccount.privateKey, "RS256");
  const issuedAt = Math.floor(now / 1000);
  return await new SignJWT({ scope: PLAY_INTEGRITY_SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(serviceAccount.clientEmail)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 60 * 60)
    .sign(key);
};

export const exchangeGoogleServiceAccountAccessToken = async (args: {
  serviceAccountJson: string;
  now: number;
  fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; expiresAt: number }> => {
  const serviceAccount = parseGoogleServiceAccount(args.serviceAccountJson);
  const assertion = await createGoogleServiceAccountAssertion(
    serviceAccount,
    args.now,
  );
  const fetchImpl = args.fetchImpl ?? fetch;
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Google OAuth token exchange failed (${response.status}).`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body)) {
    throw new Error("Google OAuth token response was invalid.");
  }
  const accessToken = body.access_token;
  const expiresIn = readPositiveNumber(body.expires_in);
  if (typeof accessToken !== "string" || !accessToken || expiresIn === null) {
    throw new Error("Google OAuth token response was incomplete.");
  }
  return {
    accessToken,
    expiresAt: args.now + expiresIn * 1000,
  };
};

const getGoogleAccessToken = async (
  serviceAccountJson: string,
  now: number,
): Promise<string> => {
  const credentialDigest = createHash("sha256")
    .update(serviceAccountJson)
    .digest("hex");
  if (
    cachedAccessToken?.credentialDigest === credentialDigest &&
    cachedAccessToken.expiresAt > now + 60_000
  ) {
    return cachedAccessToken.accessToken;
  }
  if (pendingAccessToken?.credentialDigest === credentialDigest) {
    return (await pendingAccessToken.promise).accessToken;
  }

  const promise = exchangeGoogleServiceAccountAccessToken({
    serviceAccountJson,
    now,
  }).then((token) => ({ credentialDigest, ...token }));
  pendingAccessToken = { credentialDigest, promise };
  try {
    const token = await promise;
    cachedAccessToken = token;
    return token.accessToken;
  } finally {
    if (pendingAccessToken?.promise === promise) pendingAccessToken = undefined;
  }
};

export const playIntegrityRequestHash = (challenge: string): string =>
  createHash("sha256").update(challenge, "utf8").digest("base64url");

const readTimestampMillis = (value: unknown): number | null => {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

export const isAcceptedPlayIntegrityVerdict = (args: {
  decoded: unknown;
  expectedRequestHash: string;
  now: number;
  allowUnrecognized: boolean;
}): boolean => {
  if (!isRecord(args.decoded)) return false;
  const requestDetails = args.decoded.requestDetails;
  const appIntegrity = args.decoded.appIntegrity;
  const deviceIntegrity = args.decoded.deviceIntegrity;
  if (
    !isRecord(requestDetails) ||
    !isRecord(appIntegrity) ||
    !isRecord(deviceIntegrity)
  ) {
    return false;
  }
  const timestampMillis = readTimestampMillis(requestDetails.timestampMillis);
  if (
    requestDetails.requestPackageName !== ANDROID_PACKAGE_NAME ||
    requestDetails.requestHash !== args.expectedRequestHash ||
    timestampMillis === null ||
    Math.abs(args.now - timestampMillis) > PLAY_INTEGRITY_MAX_AGE_MS
  ) {
    return false;
  }
  const appVerdict = appIntegrity.appRecognitionVerdict;
  if (
    appVerdict !== "PLAY_RECOGNIZED" &&
    !(args.allowUnrecognized && appVerdict === "UNRECOGNIZED_VERSION")
  ) {
    return false;
  }
  const deviceVerdicts = deviceIntegrity.deviceRecognitionVerdict;
  return (
    Array.isArray(deviceVerdicts) &&
    deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY")
  );
};

export const decodePlayIntegrityToken = async (args: {
  token: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown> => {
  const fetchImpl = args.fetchImpl ?? fetch;
  const response = await fetchImpl(PLAY_INTEGRITY_DECODE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ integrityToken: args.token }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Play Integrity decode failed (${response.status}).`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || !("tokenPayloadExternal" in body)) {
    throw new Error("Play Integrity decode response was invalid.");
  }
  return body.tokenPayloadExternal;
};

export const verifyPlayIntegrityToken = async (args: {
  token: string;
  challenge: string;
  now: number;
  allowUnrecognized: boolean;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> => {
  const decoded = await decodePlayIntegrityToken({
    token: args.token,
    accessToken: args.accessToken,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  return isAcceptedPlayIntegrityVerdict({
    decoded,
    expectedRequestHash: playIntegrityRequestHash(args.challenge),
    now: args.now,
    allowUnrecognized: args.allowUnrecognized,
  });
};

const invalidResult = (): IntegrityVerificationResult => ({
  ok: false,
  code: "integrity_invalid",
});

const verifyIosProof = async (
  ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
  proof: Extract<AppIntegrityProof, { platform: "ios" }>,
  challenge: string,
): Promise<IntegrityVerificationResult> => {
  const teamIdentifier = configuredValue(process.env.APPLE_APP_ATTEST_TEAM_ID);
  if (!teamIdentifier) return invalidResult();
  const now = Date.now();

  if (proof.attestation !== undefined) {
    const existing = await ctx.runQuery(getAppAttestKeyRef, {
      keyId: proof.keyId,
    });
    if (existing) return invalidResult();
    const result = await verifyAttestation({
      attestation: Buffer.from(proof.attestation, "base64"),
      challenge,
      keyId: proof.keyId,
      bundleIdentifier: APPLE_BUNDLE_IDENTIFIER,
      teamIdentifier,
      allowDevelopmentEnvironment:
        process.env.STELLA_APP_ATTEST_ALLOW_DEVELOPMENT === "1",
    });
    if (!isRecord(result) || typeof result.publicKey !== "string") {
      return invalidResult();
    }
    const stored = await ctx.runMutation(storeAppAttestKeyRef, {
      keyId: proof.keyId,
      publicKey: result.publicKey,
      now,
    });
    return stored ? { ok: true, platform: "ios" } : invalidResult();
  }

  if (proof.assertion === undefined) return invalidResult();
  const key = await ctx.runQuery(getAppAttestKeyRef, { keyId: proof.keyId });
  if (!key) return { ok: false, code: "integrity_key_unknown" };
  const result = await verifyAssertion({
    assertion: Buffer.from(proof.assertion, "base64"),
    payload: challenge,
    publicKey: key.publicKey,
    bundleIdentifier: APPLE_BUNDLE_IDENTIFIER,
    teamIdentifier,
    signCount: key.signCount,
  });
  if (
    !isRecord(result) ||
    typeof result.signCount !== "number" ||
    !Number.isSafeInteger(result.signCount) ||
    result.signCount <= key.signCount
  ) {
    return invalidResult();
  }
  const advanced = await ctx.runMutation(advanceAppAttestSignCountRef, {
    keyId: proof.keyId,
    expectedSignCount: key.signCount,
    signCount: result.signCount,
    now,
  });
  return advanced ? { ok: true, platform: "ios" } : invalidResult();
};

export const verifyAppIntegrityProofInternal = internalAction({
  args: { proof: appIntegrityProofValidator },
  returns: integrityVerificationResultValidator,
  handler: async (ctx, args): Promise<IntegrityVerificationResult> => {
    const challenge = appIntegrityChallengeString(
      args.proof.purpose,
      args.proof.nonce,
    );
    try {
      if (args.proof.platform === "ios") {
        return await verifyIosProof(ctx, args.proof, challenge);
      }
      const serviceAccountJson = configuredValue(
        process.env.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON,
      );
      if (!serviceAccountJson) return invalidResult();
      const now = Date.now();
      const accessToken = await getGoogleAccessToken(serviceAccountJson, now);
      const accepted = await verifyPlayIntegrityToken({
        token: args.proof.token,
        challenge,
        now,
        allowUnrecognized:
          process.env.STELLA_PLAY_INTEGRITY_ALLOW_UNRECOGNIZED === "1",
        accessToken,
      });
      return accepted ? { ok: true, platform: "android" } : invalidResult();
    } catch (error) {
      console.warn("[auth] App integrity verification failed", {
        platform: args.proof.platform,
        reason: error instanceof Error ? error.message : "unknown_error",
      });
      return invalidResult();
    }
  },
});
