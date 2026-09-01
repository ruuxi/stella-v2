import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { getRandomBytes } from "expo-crypto";
import {
  captureCloudBrowserCookies,
  isCloudBrowserSessionCaptureAvailable,
  type CapturedCloudBrowserCookie,
} from "../../modules/stella-cloud-browser-session";
import { base64UrlToBytes, bytesToBase64Url } from "./bridge-envelope";
import type {
  CloudBrowserEncryptedSessionTransfer,
  CloudBrowserSessionTransferCapability,
} from "./cloud-browser";

const ALGORITHM = "x25519-hkdf-sha256-aes-256-gcm-v1" as const;
const MAX_PLAINTEXT_BYTES = 32 * 1024;

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
};

const cookieAppliesToOrigin = (
  cookie: CapturedCloudBrowserCookie,
  origin: URL,
): boolean => {
  const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
  const hostname = origin.hostname.toLowerCase();
  return hostname === domain || hostname.endsWith(`.${domain}`);
};

const transferAad = (args: {
  capabilityId: string;
  interactionId: string;
  interactionRevision: number;
  displayOrigin: string;
}): Uint8Array =>
  utf8ToBytes(
    stableJson({
      schemaVersion: 1,
      purpose: "stella-cloud-browser-session-transfer",
      ...args,
    }),
  );

export const canCaptureCloudBrowserSession =
  isCloudBrowserSessionCaptureAvailable;

export const captureAndEncryptCloudBrowserSession = async (args: {
  interactionId: string;
  interactionRevision: number;
  displayOrigin: string;
  loginUrl: string;
  capability: CloudBrowserSessionTransferCapability;
}): Promise<CloudBrowserEncryptedSessionTransfer> => {
  const origin = new URL(args.displayOrigin);
  const loginUrl = new URL(args.loginUrl);
  if (
    origin.protocol !== "https:" ||
    loginUrl.origin !== origin.origin ||
    args.capability.algorithm !== ALGORITHM ||
    args.capability.interactionId !== args.interactionId ||
    args.capability.revision !== args.interactionRevision ||
    args.capability.expiresAt <= Date.now()
  ) {
    throw new Error("Invalid cloud browser transfer boundary.");
  }
  const cookies = (
    await captureCloudBrowserCookies(loginUrl.toString())
  ).filter((cookie) => cookieAppliesToOrigin(cookie, origin));
  if (cookies.length === 0) {
    throw new Error("No sign-in cookies were found for this site.");
  }
  const plaintext = utf8ToBytes(stableJson({ cookies, origins: [] as const }));
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error("The site session is too large to transfer.");
  }
  const secretKey = getRandomBytes(32);
  const clientPublicKey = x25519.getPublicKey(secretKey);
  const sharedSecret = x25519.getSharedSecret(
    secretKey,
    base64UrlToBytes(args.capability.publicKey),
  );
  const aad = transferAad({
    capabilityId: args.capability.capabilityId,
    interactionId: args.interactionId,
    interactionRevision: args.interactionRevision,
    displayOrigin: origin.origin,
  });
  const salt = utf8ToBytes(bytesToHex(sha256(aad)));
  const key = hkdf(sha256, sharedSecret, salt, aad, 32);
  const iv = getRandomBytes(12);
  return {
    schemaVersion: 1,
    algorithm: ALGORITHM,
    capabilityId: args.capability.capabilityId,
    clientPublicKey: bytesToBase64Url(clientPublicKey),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(gcm(key, iv, aad).encrypt(plaintext)),
  };
};
