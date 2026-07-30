import { describe, expect, test } from "bun:test";
import {
  LOCAL_CLIENT_MSG_ID_PATTERN,
  LOCAL_DEVICE_ID_PATTERN,
  LOCAL_LEASE_TOKEN_PATTERN,
  LOCAL_TURN_ID_PATTERN,
  classifyLocalClientMessageReplay,
  localTurnLeaseAllowsIdentityTransition,
  localClientMessageFingerprintSource,
  localTurnId,
  parseLocalTurnRenewal,
  parseLocalFinishRecords,
  parseLocalTerminalPhase,
} from "../src/local-turn-protocol.js";

const message = (role: "assistant" | "toolResult") =>
  JSON.stringify({
    role,
    ...(role === "toolResult"
      ? { toolCallId: "call-1", toolName: "Read", isError: false }
      : {}),
    content: [{ type: "text", text: "done" }],
    timestamp: 1,
  });

describe("local turn protocol", () => {
  test("accepts the IDs emitted by the desktop runtime", () => {
    expect(LOCAL_DEVICE_ID_PATTERN.test("device-123")).toBe(true);
    expect(LOCAL_TURN_ID_PATTERN.test("local:run-123")).toBe(true);
    expect(LOCAL_CLIENT_MSG_ID_PATTERN.test("message:123")).toBe(true);
    expect(LOCAL_LEASE_TOKEN_PATTERN.test("a".repeat(64))).toBe(true);
    expect(localTurnId("device-123", "local:run-123")).toBe(
      "desktop:device-123:local:run-123",
    );
  });

  test("parses a minimal renewal without reading or validating the prompt", () => {
    const renewal: Record<string, unknown> = {
      deviceId: "device-123",
      localTurnId: "local:run-123",
      leaseToken: "a".repeat(64),
      renewOnly: true,
    };
    Object.defineProperty(renewal, "userMessageJson", {
      get: () => {
        throw new Error("renewal must not read the original prompt");
      },
    });

    expect(parseLocalTurnRenewal(renewal)).toEqual({
      deviceId: "device-123",
      localTurnId: "local:run-123",
      leaseToken: "a".repeat(64),
    });
    expect(
      parseLocalTurnRenewal({
        deviceId: "device-123",
        localTurnId: "local:run-123",
        renewOnly: true,
      }),
    ).toBeNull();
  });

  test("deduplicates a stable client message across changed local turn ids", () => {
    const firstFingerprint = localClientMessageFingerprintSource(
      "message:stable",
      {
        role: "user",
        content: [{ type: "text", text: "same logical message" }],
        timestamp: 1,
      },
    );
    const restartedFingerprint = localClientMessageFingerprintSource(
      "message:stable",
      {
        timestamp: 2,
        content: [{ text: "same logical message", type: "text" }],
        role: "user",
      },
    );
    const changedFingerprint = localClientMessageFingerprintSource(
      "message:stable",
      {
        role: "user",
        content: [{ type: "text", text: "changed logical message" }],
        timestamp: 2,
      },
    );
    expect(restartedFingerprint).toBe(firstFingerprint);
    expect(changedFingerprint).not.toBe(firstFingerprint);

    const receipt = {
      clientMsgId: "message:stable",
      beginFingerprint: firstFingerprint,
      turnId: "desktop:device-1:old-local-turn",
    };
    expect(
      classifyLocalClientMessageReplay(receipt, {
        clientMsgId: "message:stable",
        beginFingerprint: restartedFingerprint,
        turnId: "desktop:device-1:new-local-turn",
      }),
    ).toBe("duplicate");
    expect(
      classifyLocalClientMessageReplay(receipt, {
        clientMsgId: "message:stable",
        beginFingerprint: changedFingerprint,
        turnId: "desktop:device-1:new-local-turn",
      }),
    ).toBe("conflict");
  });

  test("a live turn lease survives anonymous-to-account identity rotation", () => {
    const activeLease = {
      ownerId: "anonymous-owner",
      leaseToken: "a".repeat(64),
    };
    expect(
      localTurnLeaseAllowsIdentityTransition({
        boundOwnerId: "anonymous-owner",
        callerOwnerId: "connected-owner",
        suppliedLeaseToken: "a".repeat(64),
        activeLease,
      }),
    ).toBe(true);
    expect(
      localTurnLeaseAllowsIdentityTransition({
        boundOwnerId: "anonymous-owner",
        callerOwnerId: "connected-owner",
        suppliedLeaseToken: "b".repeat(64),
        activeLease,
      }),
    ).toBe(false);
    expect(
      localTurnLeaseAllowsIdentityTransition({
        boundOwnerId: "anonymous-owner",
        callerOwnerId: "connected-owner",
      }),
    ).toBe(false);
  });

  test("accepts only terminal phases", () => {
    expect(parseLocalTerminalPhase("completed")).toBe("completed");
    expect(parseLocalTerminalPhase("timeout")).toBe("timeout");
    expect(parseLocalTerminalPhase("started")).toBeNull();
    expect(parseLocalTerminalPhase("unknown")).toBeNull();
  });

  test("requires contiguous ordinals and matching payload roles", () => {
    expect(
      parseLocalFinishRecords(
        [
          { ordinal: 0, role: "assistant", payloadJson: message("assistant") },
          {
            ordinal: 1,
            role: "toolResult",
            payloadJson: message("toolResult"),
          },
        ],
        256,
      )?.records,
    ).toHaveLength(2);
    expect(
      parseLocalFinishRecords(
        [{ ordinal: 1, role: "assistant", payloadJson: message("assistant") }],
        256,
      ),
    ).toBeNull();
    expect(
      parseLocalFinishRecords(
        [{ ordinal: 0, role: "assistant", payloadJson: message("toolResult") }],
        256,
      ),
    ).toBeNull();
  });
});
