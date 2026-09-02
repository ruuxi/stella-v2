import { describe, expect, test } from "bun:test";
import {
  deviceKeyHash,
  deviceKeyProofForExchange,
  dpopHeaders,
  exportRawPublicKey,
  generateDpopKeyPair,
  verifyDeviceKeyProof,
  verifyDpopRequest,
  GATEWAY_DPOP_MAX_SKEW_MS,
  GATEWAY_DPOP_TS_HEADER,
} from "./dpop";

describe("dpop", () => {
  test("exchange proof and relay proof round-trip", async () => {
    const { alg, keyPair } = await generateDpopKeyPair();
    const rawPublicKey = await exportRawPublicKey(keyPair.publicKey);
    const now = 1_700_000_000_000;
    const proof = await deviceKeyProofForExchange({
      alg,
      privateKey: keyPair.privateKey,
      rawPublicKey,
      ownerId: "issuer|owner-1",
      gatewayOrigin: "https://gateway.example",
      now,
    });
    const verified = await verifyDeviceKeyProof({
      proof,
      ownerId: "issuer|owner-1",
      gatewayOrigin: "https://gateway.example",
      now: now + 1_000,
    });
    expect(verified).toEqual({
      ok: true,
      deviceKeyHash: await deviceKeyHash(rawPublicKey),
    });

    const headers = new Headers(
      await dpopHeaders({
        alg,
        privateKey: keyPair.privateKey,
        rawPublicKey,
        method: "post",
        pathname: "/v1/relay/responses",
        jti: "jti-1",
        requestId: "req-1",
        now,
      }),
    );
    const relay = await verifyDpopRequest({
      headers,
      method: "POST",
      pathname: "/v1/relay/responses",
      jti: "jti-1",
      requestId: "req-1",
      expectedDeviceKeyHash: await deviceKeyHash(rawPublicKey),
      now: now + 2_000,
    });
    expect(relay.ok).toBe(true);

    // Any change to the bound request identity breaks the proof.
    const wrongRequest = await verifyDpopRequest({
      headers,
      method: "POST",
      pathname: "/v1/relay/responses",
      jti: "jti-1",
      requestId: "req-2",
      expectedDeviceKeyHash: await deviceKeyHash(rawPublicKey),
      now,
    });
    expect(wrongRequest).toEqual({ ok: false, reason: "bad_signature" });

    // A different owner's exchange proof cannot be replayed for this owner.
    const wrongOwner = await verifyDeviceKeyProof({
      proof,
      ownerId: "issuer|owner-2",
      gatewayOrigin: "https://gateway.example",
      now,
    });
    expect(wrongOwner).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("stale, mismatched, and missing proofs are refused", async () => {
    const { alg, keyPair } = await generateDpopKeyPair();
    const rawPublicKey = await exportRawPublicKey(keyPair.publicKey);
    const other = await generateDpopKeyPair();
    const otherRaw = await exportRawPublicKey(other.keyPair.publicKey);
    const now = 1_700_000_000_000;
    const headers = new Headers(
      await dpopHeaders({
        alg,
        privateKey: keyPair.privateKey,
        rawPublicKey,
        method: "POST",
        pathname: "/v1/relay/messages",
        jti: "jti",
        requestId: "req",
        now,
      }),
    );
    const base = {
      method: "POST",
      pathname: "/v1/relay/messages",
      jti: "jti",
      requestId: "req",
    };
    expect(
      await verifyDpopRequest({
        headers,
        ...base,
        expectedDeviceKeyHash: await deviceKeyHash(rawPublicKey),
        now: now + GATEWAY_DPOP_MAX_SKEW_MS + 1,
      }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(
      await verifyDpopRequest({
        headers,
        ...base,
        expectedDeviceKeyHash: await deviceKeyHash(otherRaw),
        now,
      }),
    ).toEqual({ ok: false, reason: "key_mismatch" });
    expect(
      await verifyDpopRequest({
        headers: new Headers(),
        ...base,
        expectedDeviceKeyHash: await deviceKeyHash(rawPublicKey),
        now,
      }),
    ).toEqual({ ok: false, reason: "missing" });
    headers.set(GATEWAY_DPOP_TS_HEADER, "not-a-number");
    expect(
      await verifyDpopRequest({
        headers,
        ...base,
        expectedDeviceKeyHash: await deviceKeyHash(rawPublicKey),
        now,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
  });
});
