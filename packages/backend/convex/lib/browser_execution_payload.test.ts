import { describe, expect, it } from "vitest";
import { admitBrowserExecutionPayload } from "./browser_execution_payload";

const admit = (
  payload: unknown,
  overrides?: Partial<{
    expectedOwnerGeneration: string;
    requestedTargetMode: string;
    requestedExecutorDeviceId: string | undefined;
  }>,
) =>
  admitBrowserExecutionPayload({
    payloadJson:
      typeof payload === "string" ? payload : JSON.stringify(payload),
    expectedOwnerGeneration: "generation-1",
    requestedTargetMode: "automatic",
    requestedExecutorDeviceId: undefined,
    ...overrides,
  });

describe("admitBrowserExecutionPayload", () => {
  it("accepts a payload whose generation and routing match admission metadata", () => {
    expect(
      admit({
        expectedOwnerGeneration: "generation-1",
        requestedTargetMode: "automatic",
      }),
    ).toEqual({ kind: "ok" });
  });

  it("treats a missing payload target mode as automatic", () => {
    expect(admit({ expectedOwnerGeneration: "generation-1" })).toEqual({
      kind: "ok",
    });
  });

  it("does not coerce an unknown args target mode to automatic", () => {
    expect(
      admit(
        { expectedOwnerGeneration: "generation-1" },
        { requestedTargetMode: "device" },
      ),
    ).toEqual({ kind: "routing_mismatch" });
  });

  it("rejects invalid JSON as invalid_json, not a generation conflict", () => {
    expect(admit("{")).toEqual({ kind: "invalid_json" });
  });

  it("rejects a non-object payload as a generation mismatch", () => {
    expect(admit([])).toEqual({ kind: "generation_mismatch" });
  });

  it("rejects a generation that does not match the admission authority", () => {
    expect(admit({ expectedOwnerGeneration: "generation-stale" })).toEqual({
      kind: "generation_mismatch",
    });
  });

  it("rejects routing that differs from admission metadata", () => {
    expect(
      admit(
        {
          expectedOwnerGeneration: "generation-1",
          requestedTargetMode: "automatic",
        },
        {
          requestedTargetMode: "device",
          requestedExecutorDeviceId: "device-1",
        },
      ),
    ).toEqual({ kind: "routing_mismatch" });
  });

  it("trims payload device ids the same way as admission metadata", () => {
    expect(
      admit(
        {
          expectedOwnerGeneration: "generation-1",
          requestedTargetMode: "device",
          requestedExecutorDeviceId: "  device-1  ",
        },
        {
          requestedTargetMode: "device",
          requestedExecutorDeviceId: "device-1",
        },
      ),
    ).toEqual({ kind: "ok" });
  });
});
