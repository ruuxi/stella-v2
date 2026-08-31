import { describe, expect, test } from "bun:test";
import { emitCloudTurnTelemetry } from "../src/telemetry.js";

describe("private cloud turn telemetry", () => {
  test("sends only the closed metadata envelope through RPC", async () => {
    let pending: Promise<unknown> | null = null;
    let received: unknown = null;
    emitCloudTurnTelemetry(
      {
        waitUntil: (promise) => {
          pending = promise;
        },
      },
      {
        TELEMETRY_ENVIRONMENT: "development",
        TELEMETRY: {
          ingest: async (events: unknown) => {
            received = events;
          },
        },
      },
      {
        type: "cloud.turn",
        workload: "agent",
        phase: "completed",
        wallClockMs: 123,
        inputTokens: 10,
        outputTokens: 5,
      },
    );
    await pending;
    expect(received).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        project: "stella",
        environment: "development",
        source: "cloud-builder",
        event: expect.objectContaining({
          type: "cloud.turn",
          workload: "agent",
          wallClockMs: 123,
        }),
      }),
    ]);
    expect(JSON.stringify(received)).not.toMatch(
      /owner|turnId|threadId|prompt|response/i,
    );
  });

  test("uses the configured production environment for the production service", async () => {
    let pending: Promise<unknown> | null = null;
    let received: unknown = null;
    emitCloudTurnTelemetry(
      {
        waitUntil: (promise) => {
          pending = promise;
        },
      },
      {
        TELEMETRY_ENVIRONMENT: "production",
        TELEMETRY: {
          ingest: async (events: unknown) => {
            received = events;
          },
        },
      },
      { type: "cloud.turn", workload: "agent", phase: "completed" },
    );

    await pending;
    expect(received).toEqual([
      expect.objectContaining({
        environment: "production",
        source: "cloud-builder",
      }),
    ]);
  });

  test("does not reject the waitUntil promise when telemetry is unavailable", async () => {
    let pending: Promise<unknown> | null = null;
    emitCloudTurnTelemetry(
      {
        waitUntil: (promise) => {
          pending = promise;
        },
      },
      {
        TELEMETRY_ENVIRONMENT: "development",
        TELEMETRY: {
          ingest: async () => {
            throw new Error("offline");
          },
        },
      },
      { type: "cloud.turn", workload: "app-build", phase: "failed" },
    );
    await expect(pending).resolves.toBeUndefined();
  });
});
