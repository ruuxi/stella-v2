import { describe, expect, test } from "bun:test";
import {
  BridgeRecoveryError,
  bridgeRecoveryReasonForResponse,
  runWithSingleBridgeRecovery,
} from "../bridge-recovery";

describe("bridge response recovery classification", () => {
  test("recovers stale sessions, unavailable desktops, and tunnel routes", () => {
    expect(bridgeRecoveryReasonForResponse(401, "Unauthorized")).toBe(
      "session",
    );
    expect(
      bridgeRecoveryReasonForResponse(403, "Desktop bridge unavailable"),
    ).toBe("availability");
    expect(bridgeRecoveryReasonForResponse(530, "Edge route unavailable")).toBe(
      "route",
    );
  });

  test("does not retry deterministic handler or capability errors", () => {
    expect(
      bridgeRecoveryReasonForResponse(500, "Invalid conversation"),
    ).toBeNull();
    expect(
      bridgeRecoveryReasonForResponse(
        403,
        "Disallowed IPC channel: mobile:hello",
      ),
    ).toBeNull();
    expect(
      bridgeRecoveryReasonForResponse(404, "Unknown IPC channel"),
    ).toBeNull();
  });
});

describe("single bridge recovery", () => {
  test("rediscovers once after a stale session and returns the retried result", async () => {
    const attempts: string[] = [];
    const result = await runWithSingleBridgeRecovery({
      initial: "stale",
      operation: async (bridge) => {
        attempts.push(bridge);
        if (bridge === "stale") {
          throw new BridgeRecoveryError("session", "expired");
        }
        return "ok";
      },
      recover: async () => "fresh",
    });
    expect(result).toBe("ok");
    expect(attempts).toEqual(["stale", "fresh"]);
  });

  test("does not retry deterministic failures or loop after recovery", async () => {
    let recoveries = 0;
    let deterministicError: unknown;
    try {
      await runWithSingleBridgeRecovery({
        initial: "initial",
        operation: async () => {
          throw new Error("deterministic");
        },
        recover: async () => {
          recoveries += 1;
          return "fresh";
        },
      });
    } catch (error) {
      deterministicError = error;
    }
    expect(deterministicError instanceof Error).toBe(true);
    expect((deterministicError as Error).message).toBe("deterministic");
    expect(recoveries).toBe(0);

    let attempts = 0;
    let recoveryError: unknown;
    try {
      await runWithSingleBridgeRecovery({
        initial: "initial",
        operation: async () => {
          attempts += 1;
          throw new BridgeRecoveryError("route", "still down");
        },
        recover: async () => "fresh",
      });
    } catch (error) {
      recoveryError = error;
    }
    expect(recoveryError instanceof BridgeRecoveryError).toBe(true);
    expect((recoveryError as Error).message).toBe("still down");
    expect(attempts).toBe(2);
  });
});
