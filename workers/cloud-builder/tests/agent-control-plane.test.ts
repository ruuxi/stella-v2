import { describe, expect, test } from "bun:test";
import {
  TranscriptNotCanonicalError,
  createAgentControlPlane,
  type AgentControlPlaneTransport,
} from "../src/agent-control-plane.js";
import type { SealedTurnTranscript } from "../src/agent-turn-journal.js";
import { nativeHistoryCursorFromRows } from "../src/native-state-checkpoint.js";
import {
  appendThreadMessages,
  readThreadHistory,
} from "../src/thread-transcript.js";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";

const IDENTITY = {
  ownerId: "owner-1",
  ownerGeneration: "generation-7",
  threadId: "thread-1",
  turnId: "turn-9",
  attemptGeneration: 3,
  sessionId: "session-1",
} as const;

const fakeStorage = () => {
  const values = new Map<string, unknown>();
  return {
    values,
    storage: {
      put: async (key: string, value: unknown): Promise<void> => {
        values.set(key, value);
      },
    } as unknown as DurableObjectStorage,
  };
};

/**
 * The BuildSession-owned half of the control plane, backed by the same SQLite
 * helpers the Durable Object uses, so a test exercises the real transcript
 * semantics (idempotent ordinals, rowid ordering) rather than a stand-in.
 */
const fakeTransport = () => {
  const { sql, close } = openSqlStorageFake();
  const events: Array<{
    seq: number | "auto";
    kind: string;
    payload: unknown;
    terminal: boolean;
  }> = [];
  const appends: Array<
    ReadonlyArray<{ ordinal: number; role: string; payloadJson: string }>
  > = [];
  const searches: Array<{ query: string; category?: string }> = [];
  let failAppend: Error | null = null;
  const transport: AgentControlPlaneTransport = {
    readHistory: ({ excludeCurrentTurn }) =>
      readThreadHistory(sql, {
        ...(excludeCurrentTurn ? { excludeTurnId: IDENTITY.turnId } : {}),
      }),
    appendMessages: async (messages) => {
      if (failAppend) throw failAppend;
      appends.push(messages);
      appendThreadMessages(sql, {
        turnId: IDENTITY.turnId,
        attemptGeneration: IDENTITY.attemptGeneration,
        messages,
        now: 1_800_000_000_000,
      });
    },
    emitEvent: async (args) => {
      events.push({
        seq: args.seq,
        kind: args.kind,
        payload: args.payload,
        terminal: args.terminal,
      });
    },
    webSearch: async (request) => {
      searches.push(request);
      return { text: "results", results: [] };
    },
  };
  return {
    sql,
    close,
    events,
    appends,
    searches,
    transport,
    seed: (
      rows: ReadonlyArray<{
        ordinal: number;
        role: string;
        payloadJson: string;
      }>,
      turnId = "turn-earlier",
    ) =>
      appendThreadMessages(sql, {
        turnId,
        attemptGeneration: 1,
        messages: rows,
        now: 1_799_000_000_000,
      }),
    failNextAppend: (error: Error) => {
      failAppend = error;
    },
  };
};

const harness = () => {
  const { values, storage } = fakeStorage();
  const transport = fakeTransport();
  return {
    values,
    transport,
    control: createAgentControlPlane({
      identity: IDENTITY,
      storage,
      transport: transport.transport,
    }),
  };
};

const PAYLOAD_JSON = JSON.stringify({
  role: "assistant",
  content: [{ type: "text", text: "done" }],
});

const sealed = async (): Promise<SealedTurnTranscript> => ({
  turnId: IDENTITY.turnId,
  attemptGeneration: IDENTITY.attemptGeneration,
  historyCursor: await nativeHistoryCursorFromRows([
    { turnId: IDENTITY.turnId, role: "assistant", payloadJson: PAYLOAD_JSON },
  ]),
  rows: [{ ordinal: 0, role: "assistant", payloadJson: PAYLOAD_JSON }],
});

describe("resident transcript append", () => {
  test("commits to the thread's own table and verifies the canonical cursor", async () => {
    const batch = await sealed();
    const { control, transport } = harness();

    const receipt = await control.appendAndVerifyTranscript(batch);

    expect(receipt).toEqual({
      kind: "canonical_transcript",
      historyCursor: batch.historyCursor,
      rowCount: 1,
    });
    expect(transport.appends).toEqual([
      [{ ordinal: 0, role: "assistant", payloadJson: PAYLOAD_JSON }],
    ]);
    expect(
      readThreadHistory(transport.sql, {}).map((row) => ({
        turnId: row.turnId,
        role: row.role,
      })),
    ).toEqual([{ turnId: IDENTITY.turnId, role: "assistant" }]);
    transport.close();
  });

  test("a replayed commit writes the rows once", async () => {
    const batch = await sealed();
    const { control, transport } = harness();

    await control.appendAndVerifyTranscript(batch);
    await control.appendAndVerifyTranscript(batch);

    expect(readThreadHistory(transport.sql, {})).toHaveLength(1);
    transport.close();
  });

  test("refuses a transcript the thread's own rows did not make canonical", async () => {
    const batch = await sealed();
    const { control, transport } = harness();

    // A cursor that does not name the last committed row means the sealed
    // batch and the thread's rows disagree; the commit must not be reported
    // as canonical.
    await expect(
      control.appendAndVerifyTranscript({
        ...batch,
        historyCursor: `${batch.historyCursor}-stale`,
      }),
    ).rejects.toBeInstanceOf(TranscriptNotCanonicalError);
    transport.close();
  });

  test("surfaces a failed commit rather than reporting a canonical transcript", async () => {
    const batch = await sealed();
    const { control, transport } = harness();
    transport.failNextAppend(new Error("storage refused"));

    await expect(control.appendAndVerifyTranscript(batch)).rejects.toThrow(
      /storage refused/u,
    );
    transport.close();
  });
});

describe("authoritative history load", () => {
  test("reads this thread's rows and can exclude the current turn", async () => {
    const { control, transport } = harness();
    transport.seed([
      { ordinal: 0, role: "user", payloadJson: '{"role":"user"}' },
    ]);
    transport.transport.appendMessages([
      { ordinal: 0, role: "assistant", payloadJson: PAYLOAD_JSON },
    ]);

    const whole = await control.loadAuthoritativeHistory({
      excludeCurrentTurn: false,
    });
    const prior = await control.loadAuthoritativeHistory({
      excludeCurrentTurn: true,
    });

    expect(whole.map((row) => row.turnId)).toEqual([
      "turn-earlier",
      IDENTITY.turnId,
    ]);
    expect(prior.map((row) => row.turnId)).toEqual(["turn-earlier"]);
    transport.close();
  });

  test("an empty thread loads no rows", async () => {
    const { control, transport } = harness();

    expect(
      await control.loadAuthoritativeHistory({ excludeCurrentTurn: false }),
    ).toEqual([]);
    transport.close();
  });
});

describe("turn events and web search", () => {
  test("an event goes to the session's outbox transport", async () => {
    const { control, transport } = harness();

    await control.emit({
      seq: 4,
      kind: "assistant_delta",
      payload: { text: "hi" },
      terminal: false,
    });

    expect(transport.events).toEqual([
      {
        seq: 4,
        kind: "assistant_delta",
        payload: { text: "hi" },
        terminal: false,
      },
    ]);
    transport.close();
  });

  test("a web search goes to the owner's search transport", async () => {
    const { control, transport } = harness();

    const result = await control.web({ query: "effect fibers" });

    expect(transport.searches).toEqual([{ query: "effect fibers" }]);
    expect(result.details).toEqual({
      mode: "search",
      query: "effect fibers",
      text: "results",
    });
    transport.close();
  });

  test("the web tool takes a query or a url, never both and never neither", async () => {
    const { control, transport } = harness();

    await expect(control.web({})).rejects.toThrow(/Either query or url/u);
    await expect(
      control.web({ query: "a", url: "https://example.com" }),
    ).rejects.toThrow(/not both/u);
    transport.close();
  });
});
