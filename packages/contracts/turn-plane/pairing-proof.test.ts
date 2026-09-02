import { describe, expect, test } from "bun:test";
import {
  MOBILE_PAIRING_CHALLENGE_VERSION,
  MOBILE_PAIRING_HEADERS,
  MOBILE_PAIRING_PROOF_MAX_SKEW_MS,
  MOBILE_PAIRING_PROOF_VERSION,
  buildMobilePairingChallenge,
  buildMobilePairingProofMessage,
  deriveMobilePairingKey,
  hasMobilePairingProofHeaders,
  hmacSha256Hex,
  mobilePairingProofHeaders,
  readMobilePairingProofHeaders,
  sha256Hex,
  signMobilePairingProof,
  verifyMobilePairingProof,
} from "./pairing-proof.js";

/**
 * These are the wire vectors three implementations have to agree on — the
 * phone that signs, the worker that verifies, and Convex that serves the
 * pairing key. Each assertion below is therefore about exact bytes, not just
 * "a round trip works".
 */

const NOW = 1_800_000_000_000;
const PAIR_SECRET = "pairing-secret-abcdefghijklmnopqrstuvwxyz";

const challenge = () =>
  buildMobilePairingChallenge({
    idempotencyKey: "idem-0001-abcd",
    conversationId: "11111111-2222-4333-8444-555555555555",
    payloadHash: "a".repeat(64),
    kind: "chat",
    subject: "portable",
  });

const sign = async (
  overrides: {
    pairingKey?: string;
    challenge?: string;
    issuedAt?: number;
    mobilePublicKey?: string;
    desktopDeviceId?: string;
    mobileDeviceId?: string;
  } = {},
) => {
  const pairingKey =
    overrides.pairingKey ?? (await deriveMobilePairingKey(PAIR_SECRET));
  const fields = {
    mobileDeviceId: overrides.mobileDeviceId ?? "phone-1",
    desktopDeviceId: overrides.desktopDeviceId ?? "desktop-1",
    challenge: overrides.challenge ?? challenge(),
    ...(overrides.mobilePublicKey !== undefined
      ? { mobilePublicKey: overrides.mobilePublicKey }
      : {}),
  };
  const signed = await signMobilePairingProof({
    ...fields,
    pairingKey,
    issuedAt: overrides.issuedAt ?? NOW,
  });
  return { pairingKey, fields: { ...fields, ...signed } };
};

describe("mobile pairing challenge", () => {
  test("is the six-field colon tuple when no destination is named", () => {
    expect(challenge()).toBe(
      [
        MOBILE_PAIRING_CHALLENGE_VERSION,
        "idem-0001-abcd",
        "11111111-2222-4333-8444-555555555555",
        "a".repeat(64),
        "chat",
        "portable",
      ].join(":"),
    );
  });

  test("appends the destination pair when either half is named", () => {
    expect(
      buildMobilePairingChallenge({
        idempotencyKey: "k",
        conversationId: "c",
        payloadHash: "h",
        kind: "agent",
        subject: "computer",
        targetMode: "automatic",
      }),
    ).toBe("execution-placement-v1:k:c:h:agent:computer:automatic:");
    expect(
      buildMobilePairingChallenge({
        idempotencyKey: "k",
        conversationId: "c",
        payloadHash: "h",
        kind: "chat",
        subject: "portable",
        targetDeviceId: "desktop-1",
      }),
    ).toBe("execution-placement-v1:k:c:h:chat:portable:automatic:desktop-1");
    expect(
      buildMobilePairingChallenge({
        idempotencyKey: "k",
        conversationId: "c",
        payloadHash: "h",
        kind: "chat",
        subject: "portable",
        targetMode: "device",
        targetDeviceId: "desktop-1",
      }),
    ).toBe("execution-placement-v1:k:c:h:chat:portable:device:desktop-1");
  });
});

describe("mobile pairing proof message", () => {
  test("is the newline tuple Convex signs, with an empty bridge key slot", () => {
    expect(
      buildMobilePairingProofMessage({
        desktopDeviceId: "desktop-1",
        mobileDeviceId: "phone-1",
        challenge: "ch",
        issuedAt: NOW,
      }),
    ).toBe(
      `${MOBILE_PAIRING_PROOF_VERSION}\ndesktop-1\nphone-1\nch\n\n${NOW}`,
    );
  });

  test("the proof is HMAC-SHA256 keyed by sha256(pairSecret)", async () => {
    const { fields, pairingKey } = await sign();
    expect(pairingKey).toBe(await sha256Hex(PAIR_SECRET));
    expect(fields.proof).toBe(
      await hmacSha256Hex(
        pairingKey,
        buildMobilePairingProofMessage({
          desktopDeviceId: "desktop-1",
          mobileDeviceId: "phone-1",
          challenge: challenge(),
          issuedAt: NOW,
        }),
      ),
    );
    expect(fields.proof).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyMobilePairingProof", () => {
  test("accepts a freshly signed proof bound to the expected challenge", async () => {
    const { fields, pairingKey } = await sign();
    await expect(
      verifyMobilePairingProof({
        fields,
        publicKey: pairingKey,
        expectedChallenge: challenge(),
        now: NOW,
      }),
    ).resolves.toEqual({
      ok: true,
      mobileDeviceId: "phone-1",
      desktopDeviceId: "desktop-1",
      challenge: challenge(),
      issuedAt: NOW,
    });
  });

  test("binds the bridge public key when the phone sends one", async () => {
    const { fields, pairingKey } = await sign({ mobilePublicKey: "bridgeKey_1" });
    await expect(
      verifyMobilePairingProof({ fields, publicKey: pairingKey, now: NOW }),
    ).resolves.toMatchObject({ ok: true });
    // The same proof without the bound key no longer verifies.
    await expect(
      verifyMobilePairingProof({
        fields: { ...fields, mobilePublicKey: undefined },
        publicKey: pairingKey,
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: "signature" });
  });

  test("refuses a tampered challenge, device, or proof", async () => {
    const { fields, pairingKey } = await sign();
    for (const tampered of [
      { ...fields, challenge: `${fields.challenge}x` },
      { ...fields, desktopDeviceId: "desktop-2" },
      { ...fields, mobileDeviceId: "phone-2" },
      { ...fields, proof: `${fields.proof.slice(0, 63)}${fields.proof.endsWith("0") ? "1" : "0"}` },
    ]) {
      await expect(
        verifyMobilePairingProof({
          fields: tampered,
          publicKey: pairingKey,
          now: NOW,
        }),
      ).resolves.toEqual({ ok: false, reason: "signature" });
    }
  });

  test("refuses a proof the server did not ask for", async () => {
    const { fields, pairingKey } = await sign();
    await expect(
      verifyMobilePairingProof({
        fields,
        publicKey: pairingKey,
        expectedChallenge: "execution-placement-v1:other",
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: "challenge_mismatch" });
  });

  test("refuses a proof outside the skew window in either direction", async () => {
    const { fields, pairingKey } = await sign();
    for (const now of [
      NOW + MOBILE_PAIRING_PROOF_MAX_SKEW_MS + 1,
      NOW - MOBILE_PAIRING_PROOF_MAX_SKEW_MS - 1,
    ]) {
      await expect(
        verifyMobilePairingProof({ fields, publicKey: pairingKey, now }),
      ).resolves.toEqual({ ok: false, reason: "expired" });
    }
    await expect(
      verifyMobilePairingProof({
        fields: { ...fields, issuedAt: 0 },
        publicKey: pairingKey,
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: "expired" });
  });

  test("refuses another pair's key, and an unpaired phone before any HMAC", async () => {
    const { fields } = await sign();
    await expect(
      verifyMobilePairingProof({
        fields,
        publicKey: await deriveMobilePairingKey("a-different-secret"),
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: "signature" });
    await expect(
      verifyMobilePairingProof({ fields, publicKey: undefined, now: NOW }),
    ).resolves.toEqual({ ok: false, reason: "unpaired" });
  });
});

describe("proof headers", () => {
  test("round-trip through headers, and report missing versus malformed", async () => {
    const { fields, pairingKey } = await sign({ mobilePublicKey: "bridgeKey_1" });
    const headers = new Headers(mobilePairingProofHeaders(fields));
    expect(headers.get(MOBILE_PAIRING_HEADERS.issuedAt)).toBe(String(NOW));
    expect(hasMobilePairingProofHeaders(headers)).toBe(true);
    expect(readMobilePairingProofHeaders(headers)).toEqual(fields);
    await expect(
      verifyMobilePairingProof({
        headers,
        publicKey: pairingKey,
        expectedChallenge: challenge(),
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: true });

    const empty = new Headers();
    expect(hasMobilePairingProofHeaders(empty)).toBe(false);
    await expect(
      verifyMobilePairingProof({ headers: empty, publicKey: pairingKey, now: NOW }),
    ).resolves.toEqual({ ok: false, reason: "missing" });

    const partial = new Headers({
      [MOBILE_PAIRING_HEADERS.mobileDeviceId]: "phone-1",
    });
    expect(readMobilePairingProofHeaders(partial)).toBeNull();
    await expect(
      verifyMobilePairingProof({
        headers: partial,
        publicKey: pairingKey,
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed" });
  });

  test("drops an over-long or non-URL-safe bridge key rather than trusting it", async () => {
    const { fields } = await sign();
    const headers = new Headers({
      ...mobilePairingProofHeaders(fields),
      [MOBILE_PAIRING_HEADERS.mobilePublicKey]: "not a key!",
    });
    expect(readMobilePairingProofHeaders(headers)?.mobilePublicKey).toBeUndefined();
  });
});
