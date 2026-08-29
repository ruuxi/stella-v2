import { describe, expect, test } from "bun:test";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import {
  GeneralAgentTurnRequestError,
  parseGeneralAgentTurnRequest,
  selectGeneralAgentTurnPlan,
  turnComputePlan,
  turnComputePlanKey,
  type GeneralAgentTurnRequest,
} from "../src/general-agent-turn.js";

const STELLA: CloudExecutionSelection = {
  engine: "stella",
  provider: "stella",
  model: "stella/opus",
  reasoningEffort: "medium",
};
const ANTHROPIC: CloudExecutionSelection = {
  engine: "anthropic",
  provider: "anthropic",
  model: "claude-test",
  reasoningEffort: "medium",
};
const CODEX: CloudExecutionSelection = {
  engine: "openai-codex",
  provider: "openai-codex",
  model: "gpt-test",
  reasoningEffort: "medium",
};

const BROKER_ROUTE = {
  sessionId: "broker-session",
  endpoint: "https://broker.test",
} as const;

const RESUME = {
  schemaVersion: 1,
  interactionId: "interaction-1",
  interactionRevision: 1,
  profileId: "default",
  profileEpoch: 1,
  toolCallId: "call-1",
  requestDigest: "a".repeat(64),
  result: "approved",
  safeMessage: "The user finished signing in.",
} as const;

const body = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  kind: "agent",
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  threadId: "thread-1",
  turnId: "turn-1",
  turnToken: "token-1",
  convexCallbackBase: "https://convex.test",
  prompt: "ship it",
  attemptGeneration: 2,
  execution: STELLA,
  ...overrides,
});

const parse = (overrides: Record<string, unknown> = {}) =>
  parseGeneralAgentTurnRequest({
    body: body(overrides),
    brokerRoute: BROKER_ROUTE,
    defaultWatchdogMs: 900_000,
  });

describe("general agent turn placement", () => {
  test("runs a Stella turn resident", () => {
    expect(
      selectGeneralAgentTurnPlan({
        execution: STELLA,
        browserResume: false,
        residentDisabled: false,
      }),
    ).toEqual({ kind: "resident_stella", execution: STELLA });
  });

  test("keeps every native engine on today's sandbox path", () => {
    for (const execution of [ANTHROPIC, CODEX]) {
      expect(
        selectGeneralAgentTurnPlan({
          execution,
          browserResume: false,
          residentDisabled: false,
        }),
      ).toEqual({
        kind: "native_sandbox",
        execution,
        reason: "native_engine",
      });
    }
  });

  /**
   * A browser handoff resumes inside the container that suspended it. Placing
   * it resident would resume a session whose profile and tab handles live in a
   * sandbox nobody attached.
   */
  test("keeps a browser resume on the sandbox path even for Stella", () => {
    expect(
      selectGeneralAgentTurnPlan({
        execution: STELLA,
        browserResume: true,
        residentDisabled: false,
      }),
    ).toEqual({
      kind: "native_sandbox",
      execution: STELLA,
      reason: "browser_resume",
    });
  });

  test("the kill switch demotes Stella without touching the resident loop", () => {
    expect(
      selectGeneralAgentTurnPlan({
        execution: STELLA,
        browserResume: false,
        residentDisabled: true,
      }),
    ).toEqual({
      kind: "native_sandbox",
      execution: STELLA,
      reason: "resident_disabled",
    });
  });

  test("native engines report native_engine even under the kill switch", () => {
    expect(
      selectGeneralAgentTurnPlan({
        execution: ANTHROPIC,
        browserResume: true,
        residentDisabled: true,
      }).kind,
    ).toBe("native_sandbox");
  });
});

describe("persisted turn compute plan", () => {
  test("records the facts that produced the placement", () => {
    const turn = parse();
    expect(
      turnComputePlan({
        turnId: turn.identity.turnId,
        attemptGeneration: turn.identity.attemptGeneration,
        execution: turn.execution,
        browserResume: turn.browserResume !== undefined,
        residentDisabled: false,
        now: 42,
      }),
    ).toEqual({
      schemaVersion: 1,
      turnId: "turn-1",
      attemptGeneration: 2,
      plan: { kind: "resident_stella", execution: STELLA },
      engine: "stella",
      browserResume: false,
      residentDisabled: false,
      decidedAt: 42,
    });
  });

  test("keys the plan by exact attempt so a retry cannot read the last one", () => {
    expect(turnComputePlanKey("turn-1", 2)).toBe("turnComputePlan:turn-1:2");
    expect(turnComputePlanKey("turn-1", 3)).not.toBe(
      turnComputePlanKey("turn-1", 2),
    );
  });
});

describe("general agent turn request parsing", () => {
  test("accepts the record admission already validates", () => {
    expect(parse()).toEqual({
      kind: "agent",
      identity: {
        ownerId: "owner-1",
        ownerGeneration: "generation-1",
        threadId: "thread-1",
        turnId: "turn-1",
        attemptGeneration: 2,
      },
      prompt: "ship it",
      turnToken: "token-1",
      convexCallbackBase: "https://convex.test",
      brokerRoute: BROKER_ROUTE,
      execution: STELLA,
      watchdogMs: 900_000,
    } satisfies GeneralAgentTurnRequest);
  });

  /**
   * The broker route is the turn's capability to reach its own sandbox. A body
   * that could name it would let a caller point one turn at another's broker.
   */
  test("ignores a body-supplied broker route", () => {
    expect(
      parse({
        brokerRoute: { sessionId: "attacker", endpoint: "https://evil.test" },
      }).brokerRoute,
    ).toEqual(BROKER_ROUTE);
  });

  test("rejects each missing or malformed field by name", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: "app" }, "kind"],
      [{ ownerId: "" }, "ownerId"],
      [{ threadId: 7 }, "threadId"],
      [{ turnToken: "  " }, "turnToken"],
      [{ convexCallbackBase: undefined }, "convexCallbackBase"],
      [{ prompt: 7 }, "prompt"],
      [{ attemptGeneration: 0 }, "attemptGeneration"],
      [{ attemptGeneration: 1.5 }, "attemptGeneration"],
      [{ execution: { engine: "stella", provider: "anthropic" } }, "execution"],
      [{ execution: undefined }, "execution"],
      [{ browserResume: { schemaVersion: 2 } }, "browserResume"],
      [{ watchdogMs: -1 }, "watchdogMs"],
    ];
    for (const [overrides, field] of cases) {
      let thrown: unknown;
      try {
        parse(overrides);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GeneralAgentTurnRequestError);
      expect((thrown as GeneralAgentTurnRequestError).field).toBe(field);
    }
  });

  test("rejects a non-object body", () => {
    for (const value of [null, undefined, [], "agent", 7]) {
      expect(() =>
        parseGeneralAgentTurnRequest({
          body: value,
          brokerRoute: BROKER_ROUTE,
          defaultWatchdogMs: 1,
        }),
      ).toThrow(GeneralAgentTurnRequestError);
    }
  });

  test("carries a valid browser resume receipt through to the selector", () => {
    const turn = parse({ browserResume: RESUME });
    expect(turn.browserResume).toEqual(RESUME);
    expect(
      turnComputePlan({
        turnId: turn.identity.turnId,
        attemptGeneration: turn.identity.attemptGeneration,
        execution: turn.execution,
        browserResume: turn.browserResume !== undefined,
        residentDisabled: false,
        now: 1,
      }).plan,
    ).toMatchObject({ kind: "native_sandbox", reason: "browser_resume" });
  });

  test("bounds the prompt", () => {
    expect(() => parse({ prompt: "x".repeat(1024 * 1024 + 1) })).toThrow(
      GeneralAgentTurnRequestError,
    );
  });
});
