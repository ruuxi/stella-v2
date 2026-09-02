import { describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  exchangeGoogleServiceAccountAccessToken,
  playIntegrityRequestHash,
  verifyPlayIntegrityToken,
} from "../convex/app_integrity_node";

const NOW = 1_800_000_000_000;
const CHALLENGE = "stella-app-integrity\nanonymous-sign-in\nnonce";

const acceptedPayload = () => ({
  requestDetails: {
    requestPackageName: "com.fromyou.stella",
    requestHash: playIntegrityRequestHash(CHALLENGE),
    timestampMillis: String(NOW - 1_000),
  },
  appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED" },
  deviceIntegrity: {
    deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"],
  },
});

const verifyDecodedPayload = async (
  payload: unknown,
  allowUnrecognized = false,
) => {
  const fetchImpl = mock(async () =>
    Response.json({ tokenPayloadExternal: payload }),
  );
  const result = await verifyPlayIntegrityToken({
    token: "play-integrity-token",
    challenge: CHALLENGE,
    now: NOW,
    allowUnrecognized,
    accessToken: "oauth-access-token",
    fetchImpl,
  });
  return { result, fetchImpl };
};

describe("Play Integrity verification", () => {
  it("uses base64url SHA-256 for the request hash", () => {
    expect(playIntegrityRequestHash("abc")).toBe(
      "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
    );
  });

  it("accepts the required package, hash, timestamp, app, and device verdicts", async () => {
    const { result, fetchImpl } = await verifyDecodedPayload(acceptedPayload());

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://playintegrity.googleapis.com/v1/com.fromyou.stella:decodeIntegrityToken",
    );
    expect(init?.headers).toEqual({
      authorization: "Bearer oauth-access-token",
      "content-type": "application/json",
    });
    expect(init?.body).toBe(
      JSON.stringify({ integrityToken: "play-integrity-token" }),
    );
  });

  it.each([
    [
      "package",
      () => ({
        ...acceptedPayload(),
        requestDetails: {
          ...acceptedPayload().requestDetails,
          requestPackageName: "com.example.clone",
        },
      }),
    ],
    [
      "request hash",
      () => ({
        ...acceptedPayload(),
        requestDetails: {
          ...acceptedPayload().requestDetails,
          requestHash: "wrong-hash",
        },
      }),
    ],
    [
      "timestamp",
      () => ({
        ...acceptedPayload(),
        requestDetails: {
          ...acceptedPayload().requestDetails,
          timestampMillis: String(NOW - 10 * 60_000 - 1),
        },
      }),
    ],
    [
      "app verdict",
      () => ({
        ...acceptedPayload(),
        appIntegrity: { appRecognitionVerdict: "UNEVALUATED" },
      }),
    ],
    [
      "device verdict",
      () => ({
        ...acceptedPayload(),
        deviceIntegrity: {
          deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"],
        },
      }),
    ],
  ])("rejects a bad %s", async (_label, payload) => {
    await expect(verifyDecodedPayload(payload())).resolves.toMatchObject({
      result: false,
    });
  });

  it("allows UNRECOGNIZED_VERSION only behind its explicit environment policy", async () => {
    const payload = {
      ...acceptedPayload(),
      appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION" },
    };

    await expect(verifyDecodedPayload(payload)).resolves.toMatchObject({
      result: false,
    });
    await expect(verifyDecodedPayload(payload, true)).resolves.toMatchObject({
      result: true,
    });
  });
});

describe("Google service-account assertion", () => {
  it("signs the OAuth assertion with the Play Integrity scope", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    const fetchImpl = mock(async () =>
      Response.json({ access_token: "access-token", expires_in: 3600 }),
    );

    const token = await exchangeGoogleServiceAccountAccessToken({
      serviceAccountJson: JSON.stringify({
        client_email: "integrity@example.iam.gserviceaccount.com",
        private_key: privateKeyPem,
      }),
      now: NOW,
      fetchImpl,
    });

    expect(token).toEqual({
      accessToken: "access-token",
      expiresAt: NOW + 3_600_000,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const assertion = form.get("assertion");
    expect(assertion).not.toBeNull();
    if (!assertion) throw new Error("OAuth assertion was not sent.");
    expect(decodeProtectedHeader(assertion)).toMatchObject({
      alg: "RS256",
      typ: "JWT",
    });
    expect(decodeJwt(assertion)).toMatchObject({
      iss: "integrity@example.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/playintegrity",
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 3600,
    });
  });
});
