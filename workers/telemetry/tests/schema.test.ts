import { describe, expect, test } from "bun:test";
import { isTelemetryEventBody } from "@stella/contracts/telemetry";
import { parseConvexLogStream } from "../src/convex-log-stream.js";
import { createPseudonymizer } from "../src/pseudonym.js";
import { parseBatch } from "../src/schema.js";
import { verifyServiceBearer } from "../src/service-bearer.js";

const event = {
  schemaVersion: 1 as const,
  eventId: "01991999-1111-7111-8111-111111111111",
  occurredAtMs: Date.now(),
  project: "stella" as const,
  environment: "development" as const,
  source: "desktop-main" as const,
  event: {
    type: "inference.completed" as const,
    provider: "anthropic",
    model: "claude-sonnet",
    agentType: "orchestrator",
    durationMs: 123,
    success: true,
    inputTokens: 10,
    outputTokens: 20,
    costMicroCents: 42,
  },
};

describe("closed telemetry schema", () => {
  test("accepts the shared v1 contract", () => {
    expect(parseBatch({ schemaVersion: 1, events: [event] }).ok).toBe(true);
  });

  test("rejects arbitrary metadata and content fields", () => {
    expect(
      parseBatch({
        schemaVersion: 1,
        events: [{ ...event, metadata: { prompt: "secret" } }],
      }).ok,
    ).toBe(false);
    expect(
      parseBatch({
        schemaVersion: 1,
        events: [{ ...event, event: { ...event.event, output: "secret" } }],
      }).ok,
    ).toBe(false);
  });

  test("matches the lake schema's signed and nonnegative int32 fields", () => {
    const max = 2_147_483_647;
    const overflow = max + 1;

    expect(
      isTelemetryEventBody({
        type: "app.lifecycle",
        component: "desktop-main",
        phase: "stopped",
        exitCode: -2_147_483_648,
      }),
    ).toBe(true);
    expect(
      isTelemetryEventBody({
        type: "app.lifecycle",
        component: "desktop-main",
        phase: "stopped",
        exitCode: max,
      }),
    ).toBe(true);
    expect(
      isTelemetryEventBody({
        type: "app.lifecycle",
        component: "desktop-main",
        phase: "stopped",
        exitCode: overflow,
      }),
    ).toBe(false);
    expect(
      isTelemetryEventBody({
        type: "app.lifecycle",
        component: "desktop-main",
        phase: "stopped",
        exitCode: -2_147_483_649,
      }),
    ).toBe(false);

    const inference = {
      ...event.event,
      toolCalls: max,
      physicalAttempts: max,
    };
    expect(isTelemetryEventBody(inference)).toBe(true);
    expect(isTelemetryEventBody({ ...inference, toolCalls: overflow })).toBe(
      false,
    );
    expect(
      isTelemetryEventBody({ ...inference, physicalAttempts: overflow }),
    ).toBe(false);

    const transport = {
      type: "provider.transport",
      provider: "openai",
      model: "openai/gpt-5.6",
      requestIdSha256: "b".repeat(64),
      phase: "transport-closed",
      physicalAttempt: max,
      streamOrdinal: max,
    };
    expect(isTelemetryEventBody(transport)).toBe(true);
    expect(
      isTelemetryEventBody({ ...transport, physicalAttempt: overflow }),
    ).toBe(false);
    expect(
      isTelemetryEventBody({ ...transport, streamOrdinal: overflow }),
    ).toBe(false);

    const cloudTurn = {
      type: "cloud.turn",
      workload: "agent",
      phase: "completed",
      llmCalls: max,
    };
    expect(isTelemetryEventBody(cloudTurn)).toBe(true);
    expect(isTelemetryEventBody({ ...cloudTurn, llmCalls: overflow })).toBe(
      false,
    );
  });

  test("rejects URL and path labels while allowing namespaced model IDs", () => {
    expect(
      isTelemetryEventBody({
        ...event.event,
        provider: "stella/managed",
        model: "stella/openai/gpt-5.6-sol:latest",
        responseModel: "openai/gpt-5.6-2026-08-01",
      }),
    ).toBe(true);

    for (const model of [
      "https://models.example/private",
      "file:/home/alex/private-model",
      "/home/alex/private-model",
      "../private-model",
      "stella/../private-model",
    ]) {
      expect(isTelemetryEventBody({ ...event.event, model })).toBe(false);
    }

    expect(
      isTelemetryEventBody({ ...event.event, agentType: "agents/private" }),
    ).toBe(false);
    expect(
      isTelemetryEventBody({
        type: "app.error",
        component: "desktop-main",
        severity: "error",
        errorCode: "https://errors.example/private",
      }),
    ).toBe(false);
    expect(
      isTelemetryEventBody({
        type: "tool.completed",
        toolName: "tools/exec-command",
        agentType: "orchestrator",
        durationMs: 1,
        success: true,
      }),
    ).toBe(false);
    expect(
      parseBatch({
        schemaVersion: 1,
        events: [{ ...event, release: "releases/private-build" }],
      }).ok,
    ).toBe(false);
  });

  test("applies the same model, label, and int32 boundary to Convex metrics", () => {
    const metric = (overrides: Record<string, unknown> = {}) => ({
      kind: "inference.completed",
      ownerKey: "c".repeat(64),
      occurredAtMs: Date.now(),
      model: "stella/openai/gpt-5.6-sol",
      agentType: "orchestrator",
      durationMs: 12,
      success: true,
      toolCalls: 2_147_483_647,
      ...overrides,
    });
    const batch = (payload: Record<string, unknown>) => [
      {
        topic: "console",
        timestamp: Date.now(),
        convex: { deployment_name: "test-deployment" },
        function: { request_id: "request-1" },
        message: `_stella_metric:${JSON.stringify(payload)}`,
        is_truncated: false,
      },
    ];

    expect(parseConvexLogStream(batch(metric()))?.metrics).toHaveLength(1);
    expect(
      parseConvexLogStream(batch(metric({ toolCalls: 2_147_483_648 })))
        ?.metrics,
    ).toHaveLength(0);
    expect(
      parseConvexLogStream(
        batch(metric({ model: "https://example.test/model" })),
      )?.metrics,
    ).toHaveLength(0);
    expect(
      parseConvexLogStream(batch(metric({ agentType: "agents/private" })))
        ?.metrics,
    ).toHaveLength(0);
  });

  test("enforces the ingestion cap of 100", () => {
    expect(
      parseBatch({
        schemaVersion: 1,
        events: Array.from({ length: 101 }, (_, index) => ({
          ...event,
          eventId: `01991999-1111-7111-8111-${String(index).padStart(12, "0")}`,
        })),
      }),
    ).toEqual({ ok: false, error: "batch_too_large" });
  });
});

describe("identity protection", () => {
  test("produces deterministic environment-scoped lowercase SHA-256 hex", async () => {
    const dev = await createPseudonymizer(
      "a-long-development-secret",
      "development",
    );
    const prod = await createPseudonymizer(
      "a-long-development-secret",
      "production",
    );
    const first = await dev("owner", "raw-owner-id");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await dev("owner", "raw-owner-id")).toBe(first);
    expect(await prod("owner", "raw-owner-id")).not.toBe(first);
  });

  test("server bearer accepts only an exact credential", async () => {
    expect(
      await verifyServiceBearer("Bearer correct-secret", "correct-secret"),
    ).toBe(true);
    expect(
      await verifyServiceBearer("Bearer wrong-secret", "correct-secret"),
    ).toBe(false);
    expect(await verifyServiceBearer(null, "correct-secret")).toBe(false);
  });
});
