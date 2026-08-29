import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import {
  AgentTurnJournal,
  INTERRUPTED_TOOL_RESULT_TEXT,
  type SyntheticTerminalRow,
} from "../src/agent-turn-journal.js";
import { nativeHistoryCursorFromRows } from "../src/native-state-checkpoint.js";

const databases: Database[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

const openSql = (): SqlStorage => {
  const database = new Database(":memory:");
  databases.push(database);
  return {
    get databaseSize() {
      return 0;
    },
    exec<T>(statement: string, ...bindings: unknown[]) {
      const query = statement.trim();
      const rows = /^(SELECT|PRAGMA|WITH)\b/iu.test(query)
        ? (database.query(query).all(...bindings) as T[])
        : (database.run(query, bindings), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) {
            throw new Error(`Expected one row, received ${rows.length}.`);
          }
          return rows[0]!;
        },
      };
    },
  } as unknown as SqlStorage;
};

const IDENTITY = { turnId: "turn-1", attemptGeneration: 3 } as const;

const TERMINAL: SyntheticTerminalRow = {
  prompt: "ship it",
  provider: "anthropic",
  model: "claude-test",
  finalText: "",
  timestamp: 1_700_000_000_000,
};

const openJournal = (
  sql: SqlStorage,
  overrides: Partial<Parameters<typeof AgentTurnJournal.open>[0]> = {},
): AgentTurnJournal =>
  AgentTurnJournal.open({
    sql,
    identity: IDENTITY,
    terminal: TERMINAL,
    now: TERMINAL.timestamp,
    ...overrides,
  });

const userMessage = (text: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});

const assistantWithToolCalls = (
  calls: ReadonlyArray<{ id: string; name: string }>,
): AgentMessage =>
  ({
    role: "assistant",
    content: calls.map((call) => ({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: { command: "ls" },
    })),
    api: "stella-cloud",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  }) as AgentMessage;

const toolResult = (toolCallId: string, text: string): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId,
    toolName: "exec_command",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  }) as AgentMessage;

const assistantText = (text: string): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "stella-cloud",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 4,
  }) as AgentMessage;

describe("agent turn journal", () => {
  test("stages rows in append order under one exact attempt", () => {
    const journal = openJournal(openSql());
    journal.append(userMessage("ship it"));
    journal.append(assistantWithToolCalls([{ id: "call-1", name: "exec_command" }]));
    journal.append(toolResult("call-1", "done"));
    journal.append(assistantText("shipped"));
    expect(journal.rows().map((row) => [row.ordinal, row.role])).toEqual([
      [0, "user"],
      [1, "assistant"],
      [2, "toolResult"],
      [3, "assistant"],
    ]);
  });

  test("drops the errored empty assistant row that poisons future requests", () => {
    const journal = openJournal(openSql());
    journal.append(userMessage("ship it"));
    journal.append({
      role: "assistant",
      content: [],
      api: "stella-cloud",
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      timestamp: 5,
    } as AgentMessage);
    expect(journal.rows()).toHaveLength(1);
  });

  test("refuses a row above the per-row byte bound", () => {
    const journal = openJournal(openSql());
    expect(() =>
      journal.append(userMessage("x".repeat(600 * 1024))),
    ).toThrow(/row exceeds its byte bound/u);
    expect(journal.rows()).toHaveLength(0);
  });

  test("refuses a turn above the aggregate byte bound", () => {
    const journal = openJournal(openSql());
    const chunk = userMessage("y".repeat(400 * 1024));
    for (let index = 0; index < 10; index += 1) journal.append(chunk);
    expect(() => journal.append(chunk)).toThrow(/journal exceeds its byte bound/u);
    expect(journal.rows()).toHaveLength(10);
  });

  test("seals to the same cursor the container transcript path computes", async () => {
    const sql = openSql();
    const journal = openJournal(sql);
    journal.append(userMessage("ship it"));
    journal.append(assistantText("shipped"));
    const sealed = await journal.seal({ suspended: false });
    expect(sealed.rows).toHaveLength(2);
    expect(sealed.historyCursor).toBe(
      await nativeHistoryCursorFromRows(
        sealed.rows.map((row) => ({
          turnId: IDENTITY.turnId,
          role: row.role,
          payloadJson: row.payloadJson,
        })),
      ),
    );
  });

  test("sealing twice returns the same batch instead of recomputing it", async () => {
    const journal = openJournal(openSql());
    journal.append(userMessage("ship it"));
    journal.append(assistantText("shipped"));
    const first = await journal.seal({ suspended: false });
    const second = await journal.seal({ suspended: false });
    expect(second).toEqual(first);
  });

  test("refuses to seal an unanswered tool call that did not suspend", async () => {
    const journal = openJournal(openSql());
    journal.append(userMessage("ship it"));
    journal.append(assistantWithToolCalls([{ id: "call-1", name: "exec_command" }]));
    expect(journal.openToolCalls()).toEqual([
      { toolCallId: "call-1", toolName: "exec_command", params: { command: "ls" } },
    ]);
    await expect(journal.seal({ suspended: false })).rejects.toThrow(
      /unanswered tool calls/u,
    );
  });

  test("seals an unanswered tool call when the turn suspended", async () => {
    const journal = openJournal(openSql());
    journal.append(userMessage("ship it"));
    journal.append(assistantWithToolCalls([{ id: "call-1", name: "code" }]));
    const sealed = await journal.seal({ suspended: true });
    expect(sealed.rows).toHaveLength(2);
  });

  test("gives a workspace-mutating turn with no transcript an explicit row pair", async () => {
    const journal = openJournal(openSql(), {
      terminal: { ...TERMINAL, error: "exec_command failed" },
    });
    const sealed = await journal.seal({ suspended: false });
    expect(sealed.rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    const assistant = JSON.parse(sealed.rows[1]!.payloadJson) as {
      content: Array<{ text: string }>;
      stopReason: string;
      errorMessage: string;
    };
    expect(assistant.content[0]!.text).toBe("exec_command failed");
    expect(assistant.stopReason).toBe("error");
    expect(assistant.errorMessage).toBe("exec_command failed");
  });

  test("reopens the same attempt's rows rather than starting over", () => {
    const sql = openSql();
    const first = openJournal(sql);
    first.append(userMessage("ship it"));
    first.append(assistantText("shipped"));
    const reopened = openJournal(sql);
    expect(reopened.rowCount).toBe(2);
    reopened.append(toolResult("call-9", "late"));
    expect(reopened.rows().map((row) => row.ordinal)).toEqual([0, 1, 2]);
  });

  test("writes a browser resume's own row exactly once", () => {
    const sql = openSql();
    const start = {
      kind: "browser_resume",
      message: assistantWithToolCalls([{ id: "call-1", name: "code" }]),
    } as const;
    expect(openJournal(sql, { start }).rowCount).toBe(1);
    expect(openJournal(sql, { start }).rowCount).toBe(1);
  });
});

describe("agent turn journal tail repair", () => {
  test("replays a proven receipt and marks an unprovable call interrupted", async () => {
    const journal = openJournal(openSql());
    journal.append(userMessage("ship it"));
    journal.append(
      assistantWithToolCalls([
        { id: "call-1", name: "exec_command" },
        { id: "call-2", name: "exec_command" },
      ]),
    );
    const asked: string[] = [];
    const sealed = await journal.repairInterruptedTail({
      resolveInterruptedCall: async (call) => {
        asked.push(call.toolCallId);
        return call.toolCallId === "call-1"
          ? toolResult("call-1", "receipt replayed")
          : "interrupted";
      },
      terminalMessage: "This turn was interrupted.",
    });
    expect(asked).toEqual(["call-1", "call-2"]);
    expect(sealed.rows.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "assistant",
    ]);
    const interrupted = JSON.parse(sealed.rows[3]!.payloadJson) as {
      toolCallId: string;
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(interrupted).toMatchObject({
      toolCallId: "call-2",
      isError: true,
    });
    expect(interrupted.content[0]!.text).toBe(INTERRUPTED_TOOL_RESULT_TEXT);
    const terminal = JSON.parse(sealed.rows[4]!.payloadJson) as {
      content: Array<{ text: string }>;
    };
    expect(terminal.content[0]!.text).toBe("This turn was interrupted.");
  });

  test("repairing a sealed journal is a no-op", async () => {
    const journal = openJournal(openSql());
    journal.append(userMessage("ship it"));
    journal.append(assistantText("shipped"));
    const sealed = await journal.seal({ suspended: false });
    const repaired = await journal.repairInterruptedTail({
      resolveInterruptedCall: async () => {
        throw new Error("a sealed journal must not be re-resolved");
      },
      terminalMessage: "unused",
    });
    expect(repaired).toEqual(sealed);
  });

  test("clears the attempt only after the canonical commit", async () => {
    const journal = openJournal(openSql());
    journal.append(userMessage("ship it"));
    journal.append(assistantText("shipped"));
    await journal.seal({ suspended: false });
    journal.clearAfterCanonicalCommit();
    expect(journal.rows()).toEqual([]);
    expect(journal.rowCount).toBe(0);
  });
});
