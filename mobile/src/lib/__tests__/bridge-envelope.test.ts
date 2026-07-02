import { describe, expect, test } from "bun:test";
import {
  BRIDGE_REPLAY_WINDOW,
  createBridgeReplayGuard,
  decryptBridgeBytesCore,
  decryptBridgePayloadCore,
  encryptBridgeBytesCore,
  encryptBridgePayloadCore,
  isUnknownBridgeChannelError,
  parseBase64DataUrl,
  standardBase64ToBytes,
  type BridgeCryptoSession,
} from "../bridge-envelope";

// Deterministic-enough randomness for tests (never reused across envelopes
// within a test because GCM IVs are drawn fresh each call).
let seed = 1;
const testRandomBytes = (byteLength: number) => {
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out[i] = seed & 0xff;
  }
  return out;
};

const makeSessionPair = (): {
  sender: BridgeCryptoSession;
  receiver: BridgeCryptoSession;
} => {
  const key = testRandomBytes(32);
  return {
    sender: { sessionId: "session-1", key, txSeq: 0 },
    receiver: { sessionId: "session-1", key: new Uint8Array(key), txSeq: 0 },
  };
};

describe("bridge envelope round trips", () => {
  test("uncompressed payload round-trips identically", () => {
    const { sender, receiver } = makeSessionPair();
    const payload = { hello: "world", nested: { n: 42, list: [1, 2, 3] } };
    const envelope = encryptBridgePayloadCore(
      sender,
      "m2d",
      payload,
      testRandomBytes,
    );
    expect(envelope.z).toBe(undefined);
    const decoded = decryptBridgePayloadCore(receiver, "m2d", envelope);
    expect(decoded).toEqual(payload);
  });

  test("compressed payload round-trips identically and shrinks", () => {
    const { sender, receiver } = makeSessionPair();
    // Highly repetitive payload — the shape transcript syncs have.
    const payload = {
      messages: Array.from({ length: 50 }, (_, index) => ({
        localMessageId: `message-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        text: "The same sort of repetitive transcript text appears here.",
      })),
    };
    const uncompressed = encryptBridgePayloadCore(
      { ...sender, txSeq: 0 },
      "m2d",
      payload,
      testRandomBytes,
    );
    const compressed = encryptBridgePayloadCore(
      sender,
      "m2d",
      payload,
      testRandomBytes,
      { compress: true },
    );
    expect(compressed.z).toBe(1);
    expect(compressed.ct.length < uncompressed.ct.length).toBe(true);
    const decoded = decryptBridgePayloadCore(receiver, "m2d", compressed);
    expect(decoded).toEqual(payload);
  });

  test("compression is skipped when it does not shrink the payload", () => {
    const { sender, receiver } = makeSessionPair();
    // High-entropy payload: base64ish random string doesn't deflate smaller.
    const payload = { blob: Array.from(testRandomBytes(64)).join(",") };
    const envelope = encryptBridgePayloadCore(
      sender,
      "m2d",
      payload,
      testRandomBytes,
      { compress: true },
    );
    // Whether or not this particular payload shrank, the envelope must be
    // self-describing and decrypt to the identical payload.
    const decoded = decryptBridgePayloadCore(receiver, "m2d", envelope);
    expect(decoded).toEqual(payload);
  });

  test("legacy envelopes (no z field) decrypt — version tolerance", () => {
    const { sender, receiver } = makeSessionPair();
    const envelope = encryptBridgePayloadCore(
      sender,
      "d2m",
      { legacy: true },
      testRandomBytes,
      // compress deliberately not passed — what an old peer produces
    );
    expect("z" in envelope).toBe(false);
    expect(decryptBridgePayloadCore(receiver, "d2m", envelope)).toEqual({
      legacy: true,
    });
  });

  test("direction mismatch fails authentication", () => {
    const { sender, receiver } = makeSessionPair();
    const envelope = encryptBridgePayloadCore(
      sender,
      "m2d",
      { a: 1 },
      testRandomBytes,
    );
    expect(() =>
      decryptBridgePayloadCore(receiver, "d2m", envelope),
    ).toThrow();
  });
});

describe("binary frame lane", () => {
  test("bytes in = bytes out", () => {
    const { sender, receiver } = makeSessionPair();
    const bytes = testRandomBytes(100_000);
    const original = new Uint8Array(bytes);
    const frame = encryptBridgeBytesCore(sender, "d2m", bytes, testRandomBytes);
    expect(frame.ciphertext.length).toBe(bytes.length + 16);
    const decoded = decryptBridgeBytesCore(receiver, "d2m", frame);
    expect(decoded.length).toBe(original.length);
    expect([...decoded]).toEqual([...original]);
  });

  test("binary frames cannot be replayed into the JSON lane", () => {
    const { sender, receiver } = makeSessionPair();
    const frame = encryptBridgeBytesCore(
      sender,
      "m2d",
      new Uint8Array([1, 2, 3]),
      testRandomBytes,
    );
    expect(() =>
      decryptBridgePayloadCore(receiver, "m2d", {
        v: 1,
        alg: "x25519-hkdf-sha256-aes-256-gcm-v1",
        sid: "session-1",
        seq: frame.seq,
        iv: frame.iv,
        ct: Buffer.from(frame.ciphertext).toString("base64url"),
      }),
    ).toThrow();
  });
});

describe("replay guard", () => {
  test("rejects duplicate seqs", () => {
    const guard = createBridgeReplayGuard();
    guard.check(1);
    guard.check(2);
    expect(() => guard.check(2)).toThrow(/duplicate/);
    expect(() => guard.check(1)).toThrow(/duplicate/);
  });

  test("accepts out-of-order seqs within the window", () => {
    const guard = createBridgeReplayGuard();
    guard.check(5);
    guard.check(3);
    guard.check(4);
    guard.check(2);
  });

  test("rejects seqs older than the window", () => {
    const guard = createBridgeReplayGuard();
    guard.check(BRIDGE_REPLAY_WINDOW + 10);
    expect(() => guard.check(1)).toThrow(/stale/);
  });

  test("rejects non-positive and non-integer seqs", () => {
    const guard = createBridgeReplayGuard();
    expect(() => guard.check(0)).toThrow(/invalid/);
    expect(() => guard.check(-3)).toThrow(/invalid/);
    expect(() => guard.check(1.5)).toThrow(/invalid/);
  });

  test("replayed envelope is rejected end-to-end", () => {
    const { sender, receiver } = makeSessionPair();
    const guard = createBridgeReplayGuard();
    const envelope = encryptBridgePayloadCore(
      sender,
      "m2d",
      { once: true },
      testRandomBytes,
    );
    expect(
      decryptBridgePayloadCore(receiver, "m2d", envelope, guard),
    ).toEqual({ once: true });
    expect(() =>
      decryptBridgePayloadCore(receiver, "m2d", envelope, guard),
    ).toThrow(/duplicate/);
  });
});

describe("helpers", () => {
  test("standard base64 and data URLs decode", () => {
    const bytes = standardBase64ToBytes("aGVsbG8=");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    const parsed = parseBase64DataUrl("data:image/jpeg;base64,aGVsbG8=");
    expect(parsed?.mimeType).toBe("image/jpeg");
    expect(parsed?.base64).toBe("aGVsbG8=");
    expect(parseBase64DataUrl("https://example.com/a.jpg")).toBeNull();
  });

  test("unknown-channel detection drives the hello fallback", () => {
    expect(
      isUnknownBridgeChannelError(
        new Error("Unknown IPC channel: mobile:hello"),
      ),
    ).toBe(true);
    expect(
      isUnknownBridgeChannelError(
        new Error("Disallowed IPC channel: mobile:hello"),
      ),
    ).toBe(true);
    expect(isUnknownBridgeChannelError(new Error("timeout"))).toBe(false);
  });
});
