import { describe, expect, test } from "bun:test";
import {
  BRIDGE_SESSION_RESTORE_MIN_REMAINING_MS,
  BRIDGE_SESSION_TX_SEQ_RESTORE_SLACK,
  deserializePersistedBridgeSession,
  restoredTxSeq,
  serializePersistedBridgeSession,
  type PersistedBridgeSession,
} from "../bridge-session-codec";

const NOW = 1_700_000_000_000;

const makeSession = (
  overrides?: Partial<PersistedBridgeSession>,
): PersistedBridgeSession => ({
  v: 1,
  baseUrl: "https://t-owner-device.stellatunnel.com",
  sessionId: "session-abc",
  headers: {
    "X-Stella-Bridge-Session-Id": "session-abc",
    "X-Stella-Bridge-Session-Secret": "secret",
    "X-Stella-Bridge-Challenge-Id": "challenge-1",
    "X-Stella-Bridge-Encrypted": "x25519-hkdf-sha256-aes-256-gcm-v1",
  },
  keyB64: "a".repeat(43),
  txSeq: 17,
  expiresAt: NOW + 30 * 60_000,
  features: ["hello-v1", "envelope-deflate"],
  helloSupported: true,
  includeDeveloperArtifacts: false,
  ...overrides,
});

describe("persisted bridge session codec", () => {
  test("serialize/deserialize round trip", () => {
    const session = makeSession();
    const decoded = deserializePersistedBridgeSession(
      serializePersistedBridgeSession(session),
      NOW,
    );
    expect(decoded).toEqual(session);
  });

  test("expired or nearly-expired sessions are not restored", () => {
    const expired = makeSession({ expiresAt: NOW - 1 });
    expect(
      deserializePersistedBridgeSession(
        serializePersistedBridgeSession(expired),
        NOW,
      ),
    ).toBeNull();

    const nearlyExpired = makeSession({
      expiresAt: NOW + BRIDGE_SESSION_RESTORE_MIN_REMAINING_MS - 1,
    });
    expect(
      deserializePersistedBridgeSession(
        serializePersistedBridgeSession(nearlyExpired),
        NOW,
      ),
    ).toBeNull();
  });

  test("malformed records are rejected", () => {
    expect(deserializePersistedBridgeSession(null, NOW)).toBeNull();
    expect(deserializePersistedBridgeSession("", NOW)).toBeNull();
    expect(deserializePersistedBridgeSession("not json", NOW)).toBeNull();
    expect(deserializePersistedBridgeSession("{}", NOW)).toBeNull();
    const missingKey = { ...makeSession(), keyB64: "" };
    expect(
      deserializePersistedBridgeSession(JSON.stringify(missingKey), NOW),
    ).toBeNull();
    const wrongVersion = { ...makeSession(), v: 2 };
    expect(
      deserializePersistedBridgeSession(JSON.stringify(wrongVersion), NOW),
    ).toBeNull();
  });

  test("non-string headers/features entries are dropped", () => {
    const raw = JSON.stringify({
      ...makeSession(),
      headers: { good: "yes", bad: 42 },
      features: ["hello-v1", 7, null],
    });
    const decoded = deserializePersistedBridgeSession(raw, NOW);
    expect(decoded?.headers).toEqual({ good: "yes" });
    expect(decoded?.features).toEqual(["hello-v1"]);
  });

  test("restored tx seq jumps past anything the old process could have sent", () => {
    expect(restoredTxSeq(17)).toBe(17 + BRIDGE_SESSION_TX_SEQ_RESTORE_SLACK);
    expect(restoredTxSeq(-5)).toBe(BRIDGE_SESSION_TX_SEQ_RESTORE_SLACK);
    // Restore-after-restore keeps climbing (each restore re-persists its
    // bumped counter, so slack stacks instead of colliding).
    expect(restoredTxSeq(restoredTxSeq(17))).toBe(
      17 + 2 * BRIDGE_SESSION_TX_SEQ_RESTORE_SLACK,
    );
  });
});
