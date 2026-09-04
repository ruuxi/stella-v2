/**
 * A workerd harness for the resident general-agent turn.
 *
 * Two things can only be proven here. First, that the resident import graph
 * instantiates inside workerd at all: a Node builtin reached anywhere under
 * `general-agent-turn.js` takes the whole script down at startup, not at the
 * call that needed it. Second, that the turn journal's SQL survives a real
 * Durable Object isolate restart, which `bun:sqlite` cannot show.
 *
 * `src/index.js` is deliberately not imported. The point is that the resident
 * path stands up on its own, without the container executor's module graph.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  AgentTool,
  AgentToolResult,
  StreamFn,
} from "@stella/runtime/kernel/agent-core/types.js";
import type { Api, AssistantMessage, Model } from "@stella/runtime/ai/types.js";
import { createAssistantMessageEventStream } from "@stella/runtime/ai/utils/event-stream.js";
import { AgentTurnJournal } from "../../src/agent-turn-journal.js";
import type { SealedTurnTranscript } from "../../src/agent-turn-journal.js";
import {
  runResidentStellaLoop,
  selectGeneralAgentTurnPlan,
  type GeneralAgentTurnRequest,
} from "../../src/general-agent-turn.js";
import { createResidentGeneralAgentTools } from "../../src/general-agent-tools.js";
import { createCloudCodeAgentTool } from "../../src/cloud-code-tool.js";
import { createTurnRetryCancellation } from "../../src/turn-cancellation.js";

type FixtureEnv = {
  RESIDENT_TURNS: DurableObjectNamespace<ResidentTurnHarness>;
  LOADER: WorkerLoader;
};

const MODEL = {
  id: "stella/resident-workerd",
  name: "Resident workerd",
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

const IDENTITY = {
  ownerId: "owner-1",
  ownerGeneration: "generation-7",
  threadId: "thread-1",
  turnId: "turn-9",
  attemptGeneration: 1,
} as const;

const TURN: GeneralAgentTurnRequest = {
  kind: "agent",
  conversationId: "conversation-1",
  identity: IDENTITY,
  prompt: "Summarize what we decided.",
  brokerRoute: { sessionId: "session-1", endpoint: "https://broker.test" },
  execution: EXECUTION,
  audience: "pro",
  budgetMicroCents: 250_000_000,
  watchdogMs: 600_000,
};

const MODEL_GATEWAY = {
  origin: "https://gateway.test",
  capability: "header.turn-capability.signature",
} as const;

const assistantHeader = {
  role: "assistant",
  api: MODEL.api,
  provider: MODEL.provider,
  model: MODEL.id,
  timestamp: 1_800_000_000_000,
} as const;

const usage = { input: 13, output: 4, cacheRead: 0, cacheWrite: 0 };

const assistantText = (text: string): AssistantMessage => ({
  ...assistantHeader,
  content: [{ type: "text", text }],
  stopReason: "stop",
  usage,
});

const assistantCalls = (
  name: string,
  args: Record<string, unknown> = { cmd: "ls" },
): AssistantMessage => ({
  ...assistantHeader,
  content: [{ type: "toolCall", id: "call-1", name, arguments: args }],
  stopReason: "toolUse",
  usage,
});

/** Runs in a Dynamic Worker: no Node globals, and a value the test can pin. */
const RESIDENT_CODE_SCRIPT = `async () => ({
  value: "CL-RESIDENT-CODE-" + String(6 * 7),
  hasProcess: typeof process !== "undefined",
  hasRequire: typeof require !== "undefined",
})`;

const SCRIPTS: Record<string, readonly AssistantMessage[]> = {
  text: [assistantText("We decided to ship the ladder.")],
  container_tool: [
    assistantCalls("exec_command"),
    assistantText("I answered without a workspace."),
  ],
  code_tool: [
    assistantCalls("code", { code: RESIDENT_CODE_SCRIPT, timeout_ms: 5_000 }),
    assistantText("The code ran in the JS sandbox."),
  ],
};

const scriptedStream = (script: readonly AssistantMessage[]): StreamFn => {
  let index = 0;
  return () => {
    const message = script[Math.min(index, script.length - 1)];
    index += 1;
    if (!message) throw new Error("The scripted model ran out of replies.");
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "done",
      reason: message.content.some((block) => block.type === "toolCall")
        ? "toolUse"
        : "stop",
      message,
    });
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

const DO_LOCAL = new Map([
  ["web", doLocalTool("web")],
  ["publish_stella_interior", doLocalTool("publish_stella_interior")],
  ["spawn_agent", doLocalTool("spawn_agent")],
  ["send_input", doLocalTool("send_input")],
  ["pause_agent", doLocalTool("pause_agent")],
  ["agent_status", doLocalTool("agent_status")],
]);

/** Names only; the executable catalog is built per turn with the loader. */
const TOOLS = createResidentGeneralAgentTools(DO_LOCAL);

/**
 * Exactly what `BuildSession.runResidentAgentTurn` builds: the do-local tools,
 * no ladder, and `code` on the Dynamic Worker loader.
 */
const residentTools = async (env: FixtureEnv) =>
  createResidentGeneralAgentTools(
    DO_LOCAL,
    undefined,
    new Map([
      [
        "code",
        await createCloudCodeAgentTool({
          loader: env.LOADER,
          tools: [...DO_LOCAL.values()],
          executionScope: "workerd:resident-code",
        }),
      ],
    ]),
  );

const TERMINAL = {
  prompt: TURN.prompt,
  provider: EXECUTION.provider,
  model: EXECUTION.model,
  finalText: "",
  timestamp: 1_800_000_000_000,
} as const;

const JOURNAL_IDENTITY = {
  turnId: "journal-turn",
  attemptGeneration: 2,
} as const;

export class ResidentTurnHarness extends DurableObject {
  private journal(): AgentTurnJournal {
    return AgentTurnJournal.open({
      sql: this.ctx.storage.sql,
      identity: JOURNAL_IDENTITY,
      terminal: TERMINAL,
      now: TERMINAL.timestamp,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/turn") return await this.runTurn(request);
    if (path === "/journal/append") return this.appendToJournal();
    if (path === "/journal/staged") return this.stagedRows();
    if (path === "/plan") return this.plan();
    return Response.json({ code: "not_found" }, { status: 404 });
  }

  private plan(): Response {
    return Response.json({
      resident: selectGeneralAgentTurnPlan({
        execution: EXECUTION,
        browserResume: false,
        residentDisabled: false,
      }),
      disabled: selectGeneralAgentTurnPlan({
        execution: EXECUTION,
        browserResume: false,
        residentDisabled: true,
      }),
    });
  }

  private appendToJournal(): Response {
    const journal = this.journal();
    journal.append({
      role: "user",
      content: [{ type: "text", text: "staged before the restart" }],
      timestamp: TERMINAL.timestamp,
    });
    return Response.json({ rowCount: journal.rowCount });
  }

  private stagedRows(): Response {
    const journal = this.journal();
    return Response.json({
      sealed: journal.sealed,
      rows: journal.rows(),
    });
  }

  private async runTurn(request: Request): Promise<Response> {
    const body = ((await request.json().catch(() => null)) as {
      script?: string;
    } | null) ?? {};
    const script = SCRIPTS[body.script ?? "text"];
    if (!script) return Response.json({ code: "bad_script" }, { status: 400 });

    const appended: SealedTurnTranscript[] = [];
    const cancellation = createTurnRetryCancellation();
    const result = await runResidentStellaLoop({
      turn: TURN,
      execution: EXECUTION,
      context: {
        cancellation,
        signal: AbortSignal.timeout(60_000),
        assertActive: () => {},
      },
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
        emit: async () => {},
        web: async () => ({
          content: [{ type: "text", text: "ok" }],
          details: { mode: "search", query: "", text: "" },
        }),
        recordInteriorBuildRequest: async () => {},
      },
      modelGateway: MODEL_GATEWAY,
      sql: this.ctx.storage.sql,
      tools: await residentTools(this.env),
      workspacePrompt: { office: false },
      now: () => TERMINAL.timestamp,
      createModel: async () => MODEL,
      streamFn: scriptedStream(script),
    });

    const residual = this.ctx.storage.sql
      .exec<{
        count: number;
      }>(
        "SELECT COUNT(*) AS count FROM agent_turn_journal WHERE turn_id = ?",
        TURN.identity.turnId,
      )
      .one();
    return Response.json({
      result,
      transcript: appended.at(-1) ?? null,
      residualJournalRows: residual.count,
      toolNames: TOOLS.map((tool) => tool.name),
    });
  }
}

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("ready");
    const stub = env.RESIDENT_TURNS.get(
      env.RESIDENT_TURNS.idFromName("resident"),
    );
    return await stub.fetch(request);
  },
} satisfies ExportedHandler<FixtureEnv>;
