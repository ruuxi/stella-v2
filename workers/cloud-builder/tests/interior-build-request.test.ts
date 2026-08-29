import { describe, expect, test } from "bun:test";
import {
  exactInteriorBuildRequested,
  interiorBuildRequestKey,
  interiorBuildRequestRecord,
  parseInteriorBuildRequest,
} from "../src/interior-build-request.js";

describe("interior build request", () => {
  test("accepts a bare request and a bounded note", () => {
    expect(parseInteriorBuildRequest({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1,
    });
    expect(
      parseInteriorBuildRequest({ schemaVersion: 1, note: "renderer refresh" }),
    ).toEqual({ schemaVersion: 1, note: "renderer refresh" });
  });

  test("rejects unknown fields, wrong versions, and unbounded notes", () => {
    expect(parseInteriorBuildRequest({ schemaVersion: 2 })).toBeNull();
    expect(
      parseInteriorBuildRequest({ schemaVersion: 1, activate: true }),
    ).toBeNull();
    expect(
      parseInteriorBuildRequest({ schemaVersion: 1, note: "x".repeat(513) }),
    ).toBeNull();
    expect(
      parseInteriorBuildRequest({ schemaVersion: 1, note: "bad\u0000note" }),
    ).toBeNull();
    expect(parseInteriorBuildRequest([{ schemaVersion: 1 }])).toBeNull();
    expect(parseInteriorBuildRequest(null)).toBeNull();
  });

  test("binds the durable record to one exact turn attempt", () => {
    const record = interiorBuildRequestRecord({
      request: { schemaVersion: 1, note: "ready" },
      turnId: "turn-1",
      attemptGeneration: 2,
      now: 1_700_000_000_000,
    });
    expect(record).toEqual({
      schemaVersion: 1,
      turnId: "turn-1",
      attemptGeneration: 2,
      requestedAt: 1_700_000_000_000,
      note: "ready",
    });
    expect(interiorBuildRequestKey("turn-1", 2)).toBe(
      "interiorBuildRequest:turn-1:2",
    );
    expect(exactInteriorBuildRequested(record, "turn-1", 2)).toBe(true);
    expect(exactInteriorBuildRequested(record, "turn-1", 3)).toBe(false);
    expect(exactInteriorBuildRequested(record, "turn-2", 2)).toBe(false);
    expect(exactInteriorBuildRequested(undefined, "turn-1", 2)).toBe(false);
  });
});
