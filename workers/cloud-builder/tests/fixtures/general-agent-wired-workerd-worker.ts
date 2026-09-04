/**
 * The wired resident path in workerd.
 *
 * The sibling resident fixture proves the loop's module graph stands up
 * without `src/index.js`. This one proves the opposite half: that the Durable
 * Object's full graph instantiates inside workerd, and that a Stella turn
 * admitted through the real `acceptAgentTurn` reaches the resident loop
 * against real Durable Object storage without ever asking the platform for a
 * container.
 *
 * `sandbox()` is the sole wrapper around `getSandbox`, so an instance override
 * that throws is the honest counter: any path that wanted a container fails
 * loudly here instead of being asserted around.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  AgentTool,
  AgentToolResult,
  StreamFn,
} from "@stella/runtime/kernel/agent-core/types.js";
import type { Api, AssistantMessage, Model } from "@stella/runtime/ai/types.js";
import { createAssistantMessageEventStream } from "@stella/runtime/ai/utils/event-stream.js";
import type { SealedTurnTranscript } from "../../src/agent-turn-journal.js";
import { ExactTurnCancellationLedger } from "../../src/execution-placement-turn-cancellation.js";
import {
  parseTurnComputePlan,
  runResidentStellaLoop,
  turnComputePlanKey,
} from "../../src/general-agent-turn.js";
import { createResidentGeneralAgentTools } from "../../src/general-agent-tools.js";
import { BuildSession } from "../../src/index.js";

type FixtureEnv = {
  WIRED_TURNS: DurableObjectNamespace<WiredTurnHarness>;
};

const MODEL = {
  id: "stella/wired-workerd",
  name: "Wired workerd",
  api: "openai-completions",
  provider: "stella",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as Model<Api>;

const EXECUTION = {
  engine: "stella",
  provider: "stella",
  model: MODEL.id,
  reasoningEffort: "default",
} as const;

const TURN_ID = "wired-turn-1";
const FINAL_TEXT = "The ladder is wired.";
const NOW = 1_800_000_000_000;

const TURN_REQUEST = {
  kind: "agent",
  conversationId: "conversation-1",
  ownerId: "owner-1",
  ownerGeneration: "generation-7",
  appId: "agent",
  turnId: TURN_ID,
  threadId: "thread-1",
  attemptGeneration: 1,
  prompt: "Wire the ladder.",
  execution: EXECUTION,
  turnBrokerRoute: {
    sessionId: "session-1",
    endpoint: "https://broker.test",
  },
  audience: "pro",
  budgetMicroCents: 250_000_000,
  watchdogMs: 600_000,
} as const;

const MODEL_GATEWAY = {
  origin: "https://gateway.test",
  capability: "header.turn-capability.signature",
} as const;

const scriptedStream = (): StreamFn => {
  const message: AssistantMessage = {
    role: "assistant",
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    timestamp: NOW,
    content: [{ type: "text", text: FINAL_TEXT }],
    stopReason: "stop",
    usage: { input: 11, output: 5, cacheRead: 0, cacheWrite: 0 },
  };
  return () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  };
};

const doLocalTool = (name: string): AgentTool => ({
  name,
  label: name,
  description: `fixture ${name}`,
  parameters: {
    type: "object",
    properties: {},
  } as unknown as AgentTool["parameters"],
  execute: async (): Promise<AgentToolResult<unknown>> => ({
    content: [{ type: "text", text: "ok" }],
    details: null,
  }),
});

const TOOLS = createResidentGeneralAgentTools(
  new Map([
    ["web", doLocalTool("web")],
    ["publish_stella_interior", doLocalTool("publish_stella_interior")],
    ["Read", doLocalTool("Read")],
    ["apply_patch", doLocalTool("apply_patch")],
    ["Write", doLocalTool("Write")],
    ["Edit", doLocalTool("Edit")],
    ["Grep", doLocalTool("Grep")],
    ["spawn_agent", doLocalTool("spawn_agent")],
    ["send_input", doLocalTool("send_input")],
    ["pause_agent", doLocalTool("pause_agent")],
    ["agent_status", doLocalTool("agent_status")],
    ["merge_workspace", doLocalTool("merge_workspace")],
  ]),
);

class ContainerRequestedError extends Error {
  constructor() {
    super("The wired resident turn asked for a container.");
    this.name = "ContainerRequestedError";
  }
}

export class WiredTurnHarness extends DurableObject {
  /**
   * Admission arms the watchdog, and workerd refuses `setAlarm()` on a class
   * with no handler. Recovery is exercised at the Durable Object level in
   * `general-agent-resident-recovery.test.ts`; here the handler only has to
   * exist for the real admission path to run.
   */
  async alarm(): Promise<void> {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/wired") return await this.runWiredTurn();
    return Response.json({ code: "not_found" }, { status: 404 });
  }

  private async runWiredTurn(): Promise<Response> {
    let sandboxCalls = 0;
    let residentDispatches = 0;
    let nativeDispatches = 0;
    const appended: SealedTurnTranscript[] = [];
    const events: string[] = [];

    const session = Object.create(BuildSession.prototype) as Record<
      string,
      unknown
    >;
    Object.assign(session, {
      ctx: this.ctx,
      env: {
        BUILDER_SERVICE_SECRET: "builder-secret",
        TURN_TIMEOUT_MS: "60000",
      },
      exactTurnCancellations: new ExactTurnCancellationLedger(
        this.ctx.storage as unknown as DurableObjectStorage,
      ),
      runningTurns: new Map<string, Set<Promise<unknown>>>(),
      agentTurnExecutions: new Map<string, { settled: Promise<void> }>(),
      appTurnExecutions: new Map<string, unknown>(),
      residentAgentAborts: new Map<string, () => void>(),
      builderFallbackRecoveries: new Set<string>(),
      turnStateCheckpointRuns: new Map<string, unknown>(),
      unregisterTurn: async () => undefined,
      sandbox: () => {
        sandboxCalls += 1;
        throw new ContainerRequestedError();
      },
      runResidentAgentTurn: async (
        _turn: unknown,
        _plan: unknown,
        execution: Parameters<typeof runResidentStellaLoop>[0]["context"],
      ) => {
        residentDispatches += 1;
        return await runResidentStellaLoop({
          turn: {
            kind: "agent",
            conversationId: "conversation-1",
            identity: {
              ownerId: TURN_REQUEST.ownerId,
              ownerGeneration: TURN_REQUEST.ownerGeneration,
              threadId: TURN_REQUEST.threadId,
              turnId: TURN_REQUEST.turnId,
              attemptGeneration: TURN_REQUEST.attemptGeneration,
            },
            prompt: TURN_REQUEST.prompt,
            brokerRoute: TURN_REQUEST.turnBrokerRoute,
            execution: EXECUTION,
            audience: TURN_REQUEST.audience,
            budgetMicroCents: TURN_REQUEST.budgetMicroCents,
            watchdogMs: TURN_REQUEST.watchdogMs,
          },
          execution: EXECUTION,
          context: execution,
          control: {
            loadAuthoritativeHistory: async () => [],
            appendAndVerifyTranscript: async (sealed) => {
              appended.push(sealed);
              return {
                kind: "canonical_transcript",
                historyCursor: sealed.historyCursor,
                rowCount: sealed.rows.length,
              };
            },
            emit: async (args) => {
              events.push(args.kind);
            },
            web: async () => ({
              content: [{ type: "text", text: "ok" }],
              details: { mode: "search", query: "", text: "" },
            }),
            recordInteriorBuildRequest: async () => {},
          },
          modelGateway: MODEL_GATEWAY,
          sql: this.ctx.storage.sql,
          tools: TOOLS,
          workspacePrompt: { office: false },
          now: () => NOW,
          createModel: async () => MODEL,
          streamFn: scriptedStream(),
          onAgentStarted: () => {},
        });
      },
      runContainerAgentTurn: async () => {
        nativeDispatches += 1;
        throw new ContainerRequestedError();
      },
      deliverTerminal: async () => true,
      deleteTurnStoragePreservingExactCancellations: async () => true,
      ownsExactTurn: async () => true,
      assertAgentExecutionActive: async () => undefined,
      event: async (
        _turn: unknown,
        _seq: unknown,
        kind: string,
      ): Promise<void> => {
        events.push(kind);
      },
    });

    const accepted = await (
      (BuildSession.prototype as unknown as Record<string, unknown>)[
        "acceptAgentTurn"
      ] as (this: unknown, turn: unknown) => Promise<Response>
    ).call(session, TURN_REQUEST);
    const running = (
      session.agentTurnExecutions as Map<string, { settled: Promise<void> }>
    ).get(TURN_ID);
    let turnError: string | null = null;
    try {
      await running?.settled;
    } catch (error) {
      turnError = error instanceof Error ? error.message : String(error);
    }

    const residual = this.ctx.storage.sql
      .exec<{
        count: number;
      }>(
        "SELECT COUNT(*) AS count FROM agent_turn_journal WHERE turn_id = ?",
        TURN_ID,
      )
      .one();

    return Response.json({
      acceptedStatus: accepted.status,
      sandboxCalls,
      residentDispatches,
      nativeDispatches,
      turnError,
      reservedSandboxId:
        (await this.ctx.storage.get<string>("sandboxId")) ?? null,
      plan: parseTurnComputePlan(
        await this.ctx.storage.get(turnComputePlanKey(TURN_ID, 1)),
        { turnId: TURN_ID, attemptGeneration: 1 },
      ),
      transcript: appended.at(-1) ?? null,
      events,
      residualJournalRows: residual.count,
    });
  }
}

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("ready");
    const stub = env.WIRED_TURNS.get(env.WIRED_TURNS.idFromName("wired"));
    return await stub.fetch(request);
  },
} satisfies ExportedHandler<FixtureEnv>;
