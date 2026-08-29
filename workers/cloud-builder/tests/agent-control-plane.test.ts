import { describe, expect, test } from "bun:test";
import {
  AgentControlPlaneError,
  TranscriptNotCanonicalError,
  createAgentControlPlane,
} from "../src/agent-control-plane.js";
import type { SealedTurnTranscript } from "../src/agent-turn-journal.js";
import { sha256Hex } from "../src/hash.js";
import { interiorBuildRequestKey } from "../src/interior-build-request.js";
import { nativeHistoryCursorFromRows } from "../src/native-state-checkpoint.js";

const IDENTITY = {
  ownerId: "owner-1",
  ownerGeneration: "generation-7",
  threadId: "thread-1",
  turnId: "turn-9",
  attemptGeneration: 3,
  sessionId: "session-1",
} as const;

const SERVICE_SECRET = "service-secret";
const TURN_TOKEN = "turn-token";
const BASE = "https://convex.example.com";

type Capture = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
};

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

const harness = (respond: (capture: Capture, index: number) => Response) => {
  const captures: Capture[] = [];
  const { values, storage } = fakeStorage();
  const send: typeof fetch = async (input, init) => {
    const capture: Capture = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    captures.push(capture);
    return respond(capture, captures.length - 1);
  };
  return {
    captures,
    values,
    control: createAgentControlPlane({
      convexCallbackBase: `${BASE}/`,
      serviceSecret: SERVICE_SECRET,
      turnToken: TURN_TOKEN,
      identity: IDENTITY,
      storage,
      fetch: send,
    }),
  };
};

const ROW = {
  turnId: IDENTITY.turnId,
  role: "assistant",
  payloadJson: JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
  }),
} as const;

const sealed = async (): Promise<SealedTurnTranscript> => ({
  turnId: IDENTITY.turnId,
  attemptGeneration: IDENTITY.attemptGeneration,
  historyCursor: await nativeHistoryCursorFromRows([{ ...ROW }]),
  rows: [{ ordinal: 0, role: "assistant", payloadJson: ROW.payloadJson }],
});

const historyResponse = (
  rows: readonly { turnId: string; role: string; payloadJson: string }[],
): Response =>
  Response.json({
    messages: rows.map((row, index) => ({ seq: index, ...row })),
  });

describe("resident transcript append", () => {
  test("retries the identical bytes once, then verifies the canonical cursor", async () => {
    const batch = await sealed();
    const { captures, control } = harness((capture, index) => {
      if (capture.url.endsWith("/api/cloud/messages")) {
        return index === 0
          ? new Response("nope", { status: 500 })
          : Response.json({ ok: true });
      }
      return historyResponse([ROW]);
    });

    const receipt = await control.appendAndVerifyTranscript(batch);

    expect(receipt).toEqual({
      kind: "canonical_transcript",
      historyCursor: batch.historyCursor,
      rowCount: 1,
    });
    const appends = captures.filter((capture) =>
      capture.url.endsWith("/api/cloud/messages"),
    );
    expect(appends).toHaveLength(2);
    expect(appends[1]?.body).toBe(appends[0]?.body);
    expect(JSON.parse(appends[0]?.body ?? "null")).toEqual({
      conversationId: IDENTITY.threadId,
      turnId: IDENTITY.turnId,
      messages: [
        { ordinal: 0, role: "assistant", payloadJson: ROW.payloadJson },
      ],
    });
    expect(appends[0]?.headers["x-stella-turn-token"]).toBe(TURN_TOKEN);
    expect(appends[0]?.headers.authorization).toBeUndefined();
  });

  test("posts once when the first append is accepted", async () => {
    const batch = await sealed();
    const { captures, control } = harness((capture) =>
      capture.url.endsWith("/api/cloud/messages")
        ? Response.json({ ok: true })
        : historyResponse([ROW]),
    );

    await control.appendAndVerifyTranscript(batch);

    expect(
      captures.filter((capture) => capture.url.endsWith("/api/cloud/messages")),
    ).toHaveLength(1);
  });

  test("refuses a transcript Convex did not make canonical", async () => {
    const batch = await sealed();
    const { control } = harness((capture) =>
      capture.url.endsWith("/api/cloud/messages")
        ? Response.json({ ok: true })
        : historyResponse([{ ...ROW, payloadJson: '{"role":"assistant"}' }]),
    );

    await expect(control.appendAndVerifyTranscript(batch)).rejects.toBeInstanceOf(
      TranscriptNotCanonicalError,
    );
  });

  test("gives up after the second identical attempt fails", async () => {
    const batch = await sealed();
    const { captures, control } = harness(
      () => new Response("nope", { status: 503 }),
    );

    await expect(
      control.appendAndVerifyTranscript(batch),
    ).rejects.toBeInstanceOf(AgentControlPlaneError);
    expect(captures).toHaveLength(2);
    expect(captures[1]?.body).toBe(captures[0]?.body);
  });
});

describe("authoritative history load", () => {
  test("scopes the fetch to this owner, thread and excluded attempt", async () => {
    const { captures, control } = harness(() => historyResponse([ROW]));

    const rows = await control.loadAuthoritativeHistory({
      excludeCurrentTurn: true,
    });

    expect(rows).toHaveLength(1);
    const url = new URL(captures[0]?.url ?? "");
    expect(url.pathname).toBe("/api/cloud/context");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      conversationId: IDENTITY.threadId,
      ownerId: IDENTITY.ownerId,
      ownerGeneration: IDENTITY.ownerGeneration,
      excludeTurnId: IDENTITY.turnId,
    });
    expect(captures[0]?.headers.authorization).toBe(`Bearer ${SERVICE_SECRET}`);
  });

  test("omits the exclusion when the caller wants the whole thread", async () => {
    const { captures, control } = harness(() => historyResponse([]));

    await control.loadAuthoritativeHistory({ excludeCurrentTurn: false });

    expect(
      new URL(captures[0]?.url ?? "").searchParams.get("excludeTurnId"),
    ).toBeNull();
  });

  test("rejects a row that is not a history row", async () => {
    const { control } = harness(() =>
      Response.json({ messages: [{ seq: 0, role: "assistant" }] }),
    );

    await expect(
      control.loadAuthoritativeHistory({ excludeCurrentTurn: false }),
    ).rejects.toBeInstanceOf(AgentControlPlaneError);
  });

  test("rejects a body that is not history at all", async () => {
    const { control } = harness(() => new Response("<html>", { status: 200 }));

    await expect(
      control.loadAuthoritativeHistory({ excludeCurrentTurn: false }),
    ).rejects.toBeInstanceOf(AgentControlPlaneError);
  });
});

describe("worker-authenticated callbacks", () => {
  test("an event names the exact attempt and proves the turn token", async () => {
    const { captures, control } = harness(() => Response.json({ ok: true }));

    await control.emit({
      seq: 4,
      kind: "assistant_delta",
      payload: { text: "hi" },
      terminal: false,
    });

    expect(captures[0]?.url).toBe(`${BASE}/api/cloud/events`);
    expect(captures[0]?.headers.authorization).toBe(
      `Bearer ${SERVICE_SECRET}`,
    );
    expect(JSON.parse(captures[0]?.body ?? "null")).toEqual({
      turnId: IDENTITY.turnId,
      attemptGeneration: IDENTITY.attemptGeneration,
      sessionId: IDENTITY.sessionId,
      seq: 4,
      kind: "assistant_delta",
      payload: { text: "hi" },
      terminal: false,
      ownerId: IDENTITY.ownerId,
      ownerGeneration: IDENTITY.ownerGeneration,
      tokenHash: await sha256Hex(TURN_TOKEN),
    });
  });

  test("a failing callback surfaces its status", async () => {
    const { control } = harness(() => new Response("no", { status: 401 }));

    await expect(
      control.emit({ seq: "auto", kind: "turn_end", payload: {} }),
    ).rejects.toThrow(/failed with 401/u);
  });

  test("a web search reaches the search route and reports no results plainly", async () => {
    const { captures, control } = harness(() => Response.json({}));

    const result = await control.web({ query: "effect fibers" });

    expect(captures[0]?.url).toBe(`${BASE}/api/cloud/web-search`);
    expect(result.content).toEqual([
      { type: "text", text: "No results found." },
    ]);
    expect(result.details).toEqual({
      mode: "search",
      query: "effect fibers",
      text: "",
    });
  });

  test("the web tool takes a query or a url, never both and never neither", async () => {
    const { control } = harness(() => Response.json({}));

    await expect(control.web({})).rejects.toThrow(/Either query or url/u);
    await expect(
      control.web({ query: "a", url: "https://example.com" }),
    ).rejects.toThrow(/not both/u);
  });
});

describe("interior build request", () => {
  test("records the request under the exact attempt's key", async () => {
    const { values, control } = harness(() => Response.json({ ok: true }));

    await control.recordInteriorBuildRequest(
      { schemaVersion: 1, note: "ship the interior" },
      1_800_000_000_000,
    );

    expect(
      values.get(
        interiorBuildRequestKey(IDENTITY.turnId, IDENTITY.attemptGeneration),
      ),
    ).toEqual({
      schemaVersion: 1,
      turnId: IDENTITY.turnId,
      attemptGeneration: IDENTITY.attemptGeneration,
      requestedAt: 1_800_000_000_000,
      note: "ship the interior",
    });
  });
});
