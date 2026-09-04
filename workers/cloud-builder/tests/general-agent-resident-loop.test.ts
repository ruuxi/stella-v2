import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentTool,
  AgentToolResult,
  StreamFn,
} from "@stella/runtime/kernel/agent-core/types.js";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
} from "@stella/runtime/ai/types.js";
import { createAssistantMessageEventStream } from "@stella/runtime/ai/utils/event-stream.js";
import type { AgentHistoryRow } from "@stella/executor-cloud/agent-history";
import type {
  GeneralAgentTurnRequest,
  ResidentStellaLoopInput,
} from "../src/general-agent-turn.js";
import type { AgentTurnJournal } from "../src/agent-turn-journal.js";

/**
 * The load-bearing claim of the resident path is that a turn which never calls
 * a container tool never boots a container. Counting `getSandbox` is the only
 * way to state that as a fact rather than an intention, so the module is
 * mocked before `general-agent-turn.js` loads and the counter stays installed
 * for the whole file: a dynamic import on some later code path would be caught
 * too.
 */
let getSandboxCalls = 0;
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => {
    getSandboxCalls += 1;
    return {};
  },
  Sandbox: class {},
  ContainerProxy: class {},
}));

const { runResidentStellaLoop } = await import("../src/general-agent-turn.js");
const { NO_WORKSPACE_ATTACHED_MESSAGE, createResidentGeneralAgentTools } =
  await import("../src/general-agent-tools.js");
const { createTurnRetryCancellation } =
  await import("../src/turn-cancellation.js");
const { openSqlStorageFake } = await import("./fixtures/sql-storage.js");
const { nativeHistoryCursorFromRows } =
  await import("../src/native-state-checkpoint.js");

type Sealed = Awaited<ReturnType<AgentTurnJournal["seal"]>>;

const MODEL = {
  id: "stella/resident-test",
  name: "Resident test",
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
  model: "stella/resident-test",
  reasoningEffort: "default",
} as const;

const TURN: GeneralAgentTurnRequest = {
  kind: "agent",
  identity: {
    ownerId: "owner-1",
    ownerGeneration: "generation-7",
    threadId: "thread-1",
    turnId: "turn-9",
    attemptGeneration: 1,
  },
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

const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
});

const assistantText = (text: string): AssistantMessage => ({
  ...assistantHeader,
  content: [{ type: "text", text }],
  stopReason: "stop",
  usage: usage(11, 5),
});

const assistantCalls = (name: string): AssistantMessage => ({
  ...assistantHeader,
  content: [{ type: "toolCall", id: "call-1", name, arguments: { cmd: "ls" } }],
  stopReason: "toolUse",
  usage: usage(7, 3),
});

/**
 * `Agent`'s own provider seam. Each turn of the loop pops the next scripted
 * assistant message; a message carrying tool calls stops with `toolUse` so the
 * loop executes them and comes back for the next one.
 */
const scriptedStream = (
  script: readonly AssistantMessage[],
  contexts: Context[],
): StreamFn => {
  let index = 0;
  return (_model, context) => {
    contexts.push(context);
    const message = script[Math.min(index, script.length - 1)];
    index += 1;
    if (!message) throw new Error("The scripted model ran out of replies.");
    const stream = createAssistantMessageEventStream();
    const usesTools = message.content.some(
      (block) => block.type === "toolCall",
    );
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "done",
      reason: usesTools ? "toolUse" : "stop",
      message,
    });
    return stream;
  };
};

const noopDoLocalTool = (name: string): AgentTool => ({
  name,
  label: name,
  description: `test ${name}`,
  parameters: {
    type: "object",
    properties: {},
  } as unknown as AgentTool["parameters"],
  execute: async (): Promise<AgentToolResult<unknown>> => ({
    content: [{ type: "text", text: "ok" }],
    details: null,
  }),
});

const RESIDENT_TOOLS = createResidentGeneralAgentTools(
  new Map([
    ["apply_patch", noopDoLocalTool("apply_patch")],
    ["web", noopDoLocalTool("web")],
    ["Read", noopDoLocalTool("Read")],
    ["Write", noopDoLocalTool("Write")],
    ["Edit", noopDoLocalTool("Edit")],
    ["Grep", noopDoLocalTool("Grep")],
    ["spawn_agent", noopDoLocalTool("spawn_agent")],
    ["send_input", noopDoLocalTool("send_input")],
    ["pause_agent", noopDoLocalTool("pause_agent")],
    ["agent_status", noopDoLocalTool("agent_status")],
    ["publish_stella_interior", noopDoLocalTool("publish_stella_interior")],
  ]),
);

type Harness = Readonly<{
  input: ResidentStellaLoopInput;
  contexts: Context[];
  appended: Sealed[];
  sql: SqlStorage;
  close(): void;
}>;

const harness = (args: {
  script: readonly AssistantMessage[];
  history?: readonly AgentHistoryRow[];
}): Harness => {
  const fake = openSqlStorageFake();
  const contexts: Context[] = [];
  const appended: Sealed[] = [];
  const cancellation = createTurnRetryCancellation();
  const controller = new AbortController();
  return {
    contexts,
    appended,
    sql: fake.sql,
    close: fake.close,
    input: {
      turn: TURN,
      execution: EXECUTION,
      context: {
        cancellation,
        signal: controller.signal,
        assertActive: () => {},
      },
      control: {
        loadAuthoritativeHistory: async () => [...(args.history ?? [])],
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
      sql: fake.sql,
      tools: RESIDENT_TOOLS,
      workspacePrompt: { office: false },
      now: () => 1_800_000_000_000,
      createModel: async () => MODEL,
      streamFn: scriptedStream(args.script, contexts),
    },
  };
};

const openJournals: Harness[] = [];

const run = async (args: {
  script: readonly AssistantMessage[];
  history?: readonly AgentHistoryRow[];
}) => {
  const built = harness(args);
  openJournals.push(built);
  const result = await runResidentStellaLoop(built.input);
  return { ...built, result };
};

beforeEach(() => {
  getSandboxCalls = 0;
});

afterEach(() => {
  while (openJournals.length) openJournals.pop()?.close();
});

describe("resident Stella loop", () => {
  test("completes a text-only turn without touching a container", async () => {
    const { result, appended } = await run({
      script: [assistantText("We decided to ship the ladder.")],
    });

    expect(getSandboxCalls).toBe(0);
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error(result.outcome);
    expect(result.finalText).toBe("We decided to ship the ladder.");
    expect(result.compute).toEqual({ kind: "resident" });
    expect(result.durability.kind).toBe("transcript_only");
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      llmCalls: 1,
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.rows.map((row) => row.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(appended[0]?.historyCursor).toBe(
      await nativeHistoryCursorFromRows(
        (appended[0]?.rows ?? []).map((row) => ({
          turnId: TURN.identity.turnId,
          role: row.role,
          payloadJson: row.payloadJson,
        })),
      ),
    );
  });

  test("prompts with the lazy workspace variant and the pinned catalog", async () => {
    const { contexts } = await run({ script: [assistantText("done")] });

    const systemPrompt = contexts[0]?.systemPrompt ?? "";
    expect(systemPrompt).toContain("Nothing is on disk yet.");
    expect(systemPrompt).toContain(
      "restore this world and synchronize the user's drive into it the first time you call one",
    );
    expect(systemPrompt).not.toContain("is already on disk");
    expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "web",
      "Read",
      "Write",
      "Edit",
      "Grep",
      "code",
      "spawn_agent",
      "send_input",
      "pause_agent",
      "agent_status",
      "publish_stella_interior",
    ]);
  });

  test("refuses a container tool with a model-visible error and keeps going", async () => {
    const { result, appended } = await run({
      script: [
        assistantCalls("exec_command"),
        assistantText("I cannot read the repo without a workspace."),
      ],
    });

    expect(getSandboxCalls).toBe(0);
    expect(result.outcome).toBe("completed");
    const rows = appended[0]?.rows ?? [];
    expect(rows.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(rows[2]?.payloadJson).toContain(NO_WORKSPACE_ATTACHED_MESSAGE);
    expect(result.outcome === "completed" && result.usage.llmCalls).toBe(2);
  });

  test("drains steer messages into the journal before the next model call", async () => {
    const built = harness({
      script: [assistantCalls("web"), assistantText("I used the update.")],
    });
    openJournals.push(built);
    let drains = 0;
    const acknowledged: string[] = [];
    const result = await runResidentStellaLoop({
      ...built.input,
      steer: {
        drain: async () => {
          drains += 1;
          return drains === 2
            ? [
                {
                  id: "steer-1",
                  kind: "input" as const,
                  text: "Use the newer constraint.",
                  createdAt: 1_800_000_000_001,
                },
              ]
            : [];
        },
        acknowledge: (ids) => acknowledged.push(...ids),
      },
    });

    expect(result.outcome).toBe("completed");
    expect(acknowledged).toEqual(["steer-1"]);
    expect(
      built.contexts[1]?.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("newer constraint"),
      ),
    ).toBe(true);
    expect(
      built.appended[0]?.rows.map((row) => [row.role, row.payloadJson]),
    ).toContainEqual([
      "user",
      expect.stringContaining("Use the newer constraint."),
    ]);
  });

  test("carries pruned Convex history into the model context", async () => {
    const { contexts } = await run({
      script: [assistantText("done")],
      history: [
        {
          seq: 0,
          turnId: "turn-8",
          role: "user",
          payloadJson: JSON.stringify({
            role: "user",
            content: [{ type: "text", text: "what did we pick?" }],
            timestamp: 1_799_000_000_000,
          }),
        },
      ],
    });

    expect(contexts[0]?.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
    ]);
  });

  test("fails preflight without a transcript when history will not parse", async () => {
    const built = harness({ script: [assistantText("done")] });
    openJournals.push(built);
    const result = await runResidentStellaLoop({
      ...built.input,
      control: {
        ...built.input.control,
        loadAuthoritativeHistory: async () => {
          throw new Error("history unavailable");
        },
      },
    });

    expect(getSandboxCalls).toBe(0);
    expect(result.outcome).toBe("failed");
    expect(result.durability).toEqual({
      kind: "none",
      reason: "preflight_failed",
    });
    expect(built.appended).toHaveLength(0);
  });

  test("clears the attempt's journal rows once the transcript is canonical", async () => {
    const { sql } = await run({ script: [assistantText("done")] });

    const remaining = sql
      .exec<{
        count: number;
      }>("SELECT COUNT(*) AS count FROM agent_turn_journal")
      .one();
    expect(remaining.count).toBe(0);
  });
});
