import * as AppIntegrity from "@expo/app-integrity";
import {
  APP_INTEGRITY_CHALLENGE_PATH,
  appIntegrityChallengeString,
  encodeAppIntegrityProof,
  type AppIntegrityChallengeRequest,
  type AppIntegrityChallengeResponse,
  type AppIntegrityProof,
  type AppIntegrityPurpose,
} from "@stella/contracts/app-integrity";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { env } from "../config/env";

const APP_ATTEST_KEY_ID_STORAGE_KEY = "stella-app-attest.key-id";
const APP_ATTEST_ATTESTED_STORAGE_KEY = "stella-app-attest.attested";

let cachedAppAttestKeyId: string | null = null;
let appAttestKeyPromise: Promise<string> | null = null;
let playIntegrityProviderPromise: Promise<void> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readChallengeResponse = (
  value: unknown,
): AppIntegrityChallengeResponse | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.nonce) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt)
  ) {
    return null;
  }
  return { nonce: value.nonce, expiresAt: value.expiresAt };
};

const readErrorMessage = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  if (typeof value.message === "string" && value.message.trim()) {
    return value.message.trim();
  }
  if (typeof value.error === "string" && value.error.trim()) {
    return value.error.trim();
  }
  return null;
};

const requestChallenge = async (
  purpose: AppIntegrityPurpose,
): Promise<AppIntegrityChallengeResponse> => {
  const body = { purpose } satisfies AppIntegrityChallengeRequest;
  const response = await fetch(
    `${env.convexSiteUrl}${APP_INTEGRITY_CHALLENGE_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      readErrorMessage(value) ?? "Could not start app verification.",
    );
  }
  const challenge = readChallengeResponse(value);
  if (!challenge || challenge.expiresAt <= 0) {
    throw new Error("App verification returned an invalid challenge.");
  }
  return challenge;
};

const loadOrCreateAppAttestKeyId = async (): Promise<string> => {
  if (cachedAppAttestKeyId) return cachedAppAttestKeyId;
  if (appAttestKeyPromise) return await appAttestKeyPromise;

  appAttestKeyPromise = (async () => {
    const stored = (
      await SecureStore.getItemAsync(APP_ATTEST_KEY_ID_STORAGE_KEY)
    )?.trim();
    if (stored) return stored;

    const generated = (await AppIntegrity.generateKeyAsync()).trim();
    if (!generated) {
      throw new Error("App verification could not create an App Attest key.");
    }
    await SecureStore.setItemAsync(APP_ATTEST_KEY_ID_STORAGE_KEY, generated);
    await SecureStore.deleteItemAsync(APP_ATTEST_ATTESTED_STORAGE_KEY);
    return generated;
  })();

  try {
    cachedAppAttestKeyId = await appAttestKeyPromise;
    return cachedAppAttestKeyId;
  } finally {
    appAttestKeyPromise = null;
  }
};

const createIosProof = async (
  purpose: AppIntegrityPurpose,
  nonce: string,
): Promise<AppIntegrityProof> => {
  const keyId = await loadOrCreateAppAttestKeyId();
  const challenge = appIntegrityChallengeString(purpose, nonce);
  const attestedKeyId = await SecureStore.getItemAsync(
    APP_ATTEST_ATTESTED_STORAGE_KEY,
  );

  if (attestedKeyId === keyId) {
    const assertion = await AppIntegrity.generateAssertionAsync(
      keyId,
      challenge,
    );
    return { platform: "ios", purpose, nonce, keyId, assertion };
  }

  const attestation = await AppIntegrity.attestKeyAsync(keyId, challenge);
  await SecureStore.setItemAsync(APP_ATTEST_ATTESTED_STORAGE_KEY, keyId);
  return { platform: "ios", purpose, nonce, keyId, attestation };
};

const preparePlayIntegrityProvider = async (): Promise<void> => {
  if (!playIntegrityProviderPromise) {
    playIntegrityProviderPromise = AppIntegrity.prepareIntegrityTokenProviderAsync(
      env.playIntegrityProjectNumber,
    ).catch((error: unknown) => {
      playIntegrityProviderPromise = null;
      throw error;
    });
  }
  return await playIntegrityProviderPromise;
};

export const deriveAndroidRequestHash = (challenge: string): string => {
  let binary = "";
  for (const byte of sha256(utf8ToBytes(challenge))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const requestPlayIntegrityToken = async (requestHash: string) => {
  const request = async () => {
    await preparePlayIntegrityProvider();
    return await AppIntegrity.requestIntegrityCheckAsync(requestHash);
  };

  try {
    return await request();
  } catch {
    playIntegrityProviderPromise = null;
    return await request();
  }
};

const createAndroidProof = async (
  purpose: AppIntegrityPurpose,
  nonce: string,
): Promise<AppIntegrityProof> => {
  const challenge = appIntegrityChallengeString(purpose, nonce);
  const requestHash = deriveAndroidRequestHash(challenge);
  const token = await requestPlayIntegrityToken(requestHash);
  return { platform: "android", purpose, nonce, token };
};

export const getAppIntegrityProof = async (
  purpose: AppIntegrityPurpose,
): Promise<string | undefined> => {
  if (!env.convexSiteUrl) return undefined;

  if (Platform.OS === "ios") {
    if (!AppIntegrity.isSupported) return undefined;
    const challenge = await requestChallenge(purpose);
    return encodeAppIntegrityProof(
      await createIosProof(purpose, challenge.nonce),
    );
  }

  if (Platform.OS === "android") {
    if (!env.playIntegrityProjectNumber) return undefined;
    const challenge = await requestChallenge(purpose);
    return encodeAppIntegrityProof(
      await createAndroidProof(purpose, challenge.nonce),
    );
  }

  return undefined;
};

export const isIntegrityKeyUnknown = (value: unknown): boolean => {
  if (value === "integrity_key_unknown") return true;
  if (!isRecord(value)) return false;
  if (
    value.code === "integrity_key_unknown" ||
    value.error === "integrity_key_unknown"
  ) {
    return true;
  }
  if (!isRecord(value.error)) return false;
  return (
    value.error.code === "integrity_key_unknown" ||
    value.error.error === "integrity_key_unknown"
  );
};

export const requestWithAppIntegrity = async <Result>(args: {
  purpose: AppIntegrityPurpose;
  request: (proof: string | undefined) => Promise<Result>;
  isIntegrityKeyUnknown: (result: Result) => boolean;
}): Promise<Result> => {
  const proof = await getAppIntegrityProof(args.purpose);
  const result = await args.request(proof);
  if (
    Platform.OS !== "ios" ||
    !proof ||
    !args.isIntegrityKeyUnknown(result)
  ) {
    return result;
  }

  await SecureStore.deleteItemAsync(APP_ATTEST_ATTESTED_STORAGE_KEY);
  return await args.request(await getAppIntegrityProof(args.purpose));
};
