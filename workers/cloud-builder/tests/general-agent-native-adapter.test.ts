import { describe, expect, mock, test } from "bun:test";
import {
  NativeSandboxDurabilityError,
  runNativeSandboxTurn,
  selectGeneralAgentTurnPlan,
  type GeneralAgentTurnPlan,
  type NativeSandboxAttempt,
  type TurnDurability,
} from "../src/general-agent-turn.js";
import { createTurnRetryCancellation } from "../src/turn-cancellation.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  Sandbox: class {},
  ContainerProxy: class {},
}));
const { parseAgentExecutorResult } = await import("../src/index.js");
mock.restore();

const context = () => {
  const cancellation = createTurnRetryCancellation();
  return {
    cancellation,
    signal: AbortSignal.timeout(30_000),
    assertActive: () => {},
  };
};

const nativePlan = (
  engine: "anthropic" | "openai-codex",
): Extract<GeneralAgentTurnPlan, { kind: "native_sandbox" }> => {
  const plan = selectGeneralAgentTurnPlan({
    execution: {
      engine,
      provider: engine,
      model: `${engine}/model`,
      reasoningEffort: "default",
    } as never,
    browserResume: false,
    residentDisabled: false,
  });
  if (plan.kind !== "native_sandbox") throw new Error("expected native plan");
  return plan;
};

const CHECKPOINT = {
  schemaVersion: 1,
  operationId: "1".repeat(64),
  historyCursor: `v1:${"2".repeat(64)}`,
  workspaceSha256: "3".repeat(64),
  receipt: "5".repeat(64),
  replayed: false,
} as const;

const checkpointDurability: TurnDurability = {
  kind: "workspace_checkpoint",
  transcript: {
    kind: "canonical_transcript",
    historyCursor: CHECKPOINT.historyCursor,
    rowCount: 4,
  },
  checkpoint: CHECKPOINT,
};

/**
 * The executor writes this file; `parseAgentExecutorResult` is the exact
 * parser `index.ts` runs over it. Building the adapter's input from that
 * parser is what binds this suite to the current container flow instead of to
 * a hand-written shape that could drift away from it.
 */
const executorResultFile = (body: Record<string, unknown>): string =>
  JSON.stringify(body);

const attemptFromExecutorFile = (
  file: string,
  durability: TurnDurability,
): NativeSandboxAttempt => {
  const parsed = parseAgentExecutorResult(JSON.parse(file) as unknown);
  if (!parsed) throw new Error("the executor result did not parse");
  return {
    result: {
      ok: parsed.ok,
      ...(parsed.outcome ? { outcome: parsed.outcome } : {}),
      ...(parsed.finalText === undefined
        ? {}
        : { finalText: parsed.finalText }),
      ...(parsed.error === undefined ? {} : { error: parsed.error }),
      usage: { inputTokens: 900, outputTokens: 120, llmCalls: 3 },
      ...(parsed.suspension ? { suspension: parsed.suspension } : {}),
    },
    durability,
    instanceSize: "large",
    coldStartMs: 4_100,
    restoreMs: 900,
  };
};

describe("native sandbox adapter", () => {
  test("places anthropic and codex turns on the container path", () => {
    expect(nativePlan("anthropic").reason).toBe("native_engine");
    expect(nativePlan("openai-codex").reason).toBe("native_engine");
  });

  test("projects a completed executor result into the shared envelope", async () => {
    const attempt = attemptFromExecutorFile(
      executorResultFile({
        ok: true,
        outcome: "completed",
        finalText: "Rebased and pushed.",
        usage: { inputTokens: 900, outputTokens: 120, llmCalls: 3 },
        turnStateCheckpoint: CHECKPOINT,
      }),
      checkpointDurability,
    );

    const result = await runNativeSandboxTurn({
      plan: nativePlan("anthropic"),
      context: context(),
      runAttempt: async () => attempt,
    });

    expect(result).toEqual({
      outcome: "completed",
      ok: true,
      finalText: "Rebased and pushed.",
      usage: { inputTokens: 900, outputTokens: 120, llmCalls: 3 },
      compute: {
        kind: "sandbox",
        reason: "native_engine",
        instanceSize: "large",
        coldStartMs: 4_100,
        restoreMs: 900,
      },
      durability: checkpointDurability,
    });
  });

  test("carries a failed executor result with the durability it kept", async () => {
    const preserved: TurnDurability = {
      kind: "none",
      reason: "preflight_failed",
    };
    const attempt = attemptFromExecutorFile(
      executorResultFile({
        ok: false,
        error: "The agent hit a problem and stopped. Try again.",
        checkpointPolicy: "preserve_prior",
      }),
      preserved,
    );

    const result = await runNativeSandboxTurn({
      plan: nativePlan("anthropic"),
      context: context(),
      runAttempt: async () => attempt,
    });

    expect(result).toMatchObject({
      outcome: "failed",
      ok: false,
      error: "The agent hit a problem and stopped. Try again.",
      durability: preserved,
    });
  });

  test("carries a browser suspension without inventing a terminal reply", async () => {
    const suspension = {
      schemaVersion: 1,
      outcome: "waiting_for_user",
      interactionId: "interaction-1",
      interactionRevision: 1,
      interactionKind: "login_takeover",
      toolCallId: "call-code-1",
      requestDigest: "4".repeat(64),
      profileId: "default",
      profileEpoch: 1,
      displayOrigin: "https://example.com",
      expiresAt: 1_800_000_000_000,
    };
    const attempt = attemptFromExecutorFile(
      executorResultFile({
        ok: false,
        outcome: "suspended",
        finalText: "",
        suspension,
        turnStateCheckpoint: CHECKPOINT,
      }),
      checkpointDurability,
    );

    const result = await runNativeSandboxTurn({
      plan: nativePlan("openai-codex"),
      context: context(),
      runAttempt: async () => attempt,
    });

    expect(result.outcome).toBe("suspended");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ durability: checkpointDurability });
  });

  test("refuses to report a completed native turn that made nothing durable", async () => {
    await expect(
      runNativeSandboxTurn({
        plan: nativePlan("anthropic"),
        context: context(),
        runAttempt: async () => ({
          result: { ok: true, outcome: "completed", finalText: "done" },
          durability: { kind: "none", reason: "canceled" },
          instanceSize: "small",
          coldStartMs: 1,
          restoreMs: 0,
        }),
      }),
    ).rejects.toBeInstanceOf(NativeSandboxDurabilityError);
  });

  test("refuses a suspension the executor never described", async () => {
    await expect(
      runNativeSandboxTurn({
        plan: nativePlan("anthropic"),
        context: context(),
        runAttempt: async () => ({
          result: { ok: false, outcome: "suspended" },
          durability: checkpointDurability,
          instanceSize: "small",
          coldStartMs: 1,
          restoreMs: 0,
        }),
      }),
    ).rejects.toBeInstanceOf(NativeSandboxDurabilityError);
  });

  test("a browser resume keeps a stella turn on the container path", () => {
    const plan = selectGeneralAgentTurnPlan({
      execution: {
        engine: "stella",
        provider: "stella",
        model: "stella/default",
        reasoningEffort: "default",
      } as never,
      browserResume: true,
      residentDisabled: false,
    });
    expect(plan).toMatchObject({
      kind: "native_sandbox",
      reason: "browser_resume",
    });
  });
});
