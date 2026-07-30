import { describe, expect, test } from "bun:test";
import {
  LOCAL_CLIENT_MSG_ID_PATTERN,
  LOCAL_DEVICE_ID_PATTERN,
  LOCAL_LEASE_TOKEN_PATTERN,
  LOCAL_TURN_ID_PATTERN,
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
