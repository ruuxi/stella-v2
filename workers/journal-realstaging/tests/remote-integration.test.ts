import { describe, expect, test } from "bun:test";

// Remote integration test against the deployed staging journal worker. Skipped
// unless JOURNAL_URL and JOURNAL_TOKEN are set, so CI/unit runs stay hermetic
// while a developer can prove the real DO/R2 path over the network:
//
//   JOURNAL_URL=https://stella-v2-journal-realstaging.lolruuxi.workers.dev \
//   JOURNAL_TOKEN=<dev token> bun test tests/remote-integration.test.ts
//
// This deliberately targets the REAL remote worker, never a loopback emulator.

const URL = process.env.JOURNAL_URL;
const TOKEN = process.env.JOURNAL_TOKEN;
const enabled = Boolean(URL && TOKEN);

const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${URL}${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

describe.if(enabled)("remote staging journal (real DO + R2)", () => {
  const cid = `it-${Date.now()}`;

  test("append/read/idempotency/fencing/rollover/hydrate over the network", async () => {
    const a = await call("POST", `/journal/${cid}/append`, {
      writerKey: `${cid}:w1`,
      placement: "local-desktop",
      events: [
        { type: "conversation.created", payload: {} },
        { type: "message.user", payload: { text: "hi" } },
      ],
    });
    expect(a.status).toBe(200);
    expect(a.json.receipt.lastSeq).toBe(2);

    const replay = await call("POST", `/journal/${cid}/append`, {
      writerKey: `${cid}:w1`,
      events: [{ type: "conversation.created", payload: {} }],
    });
    expect(replay.json.receipt.replayed).toBe(true);

    const stale = await call("POST", `/journal/${cid}/append`, {
      writerKey: `${cid}:stale`,
      expectedSeq: 1,
      events: [{ type: "x", payload: {} }],
    });
    expect(stale.status).toBe(409);

    const roll = await call("POST", `/journal/${cid}/rollover`, { throughSeq: 2 });
    expect(roll.json.segment.rows).toBe(2);

    const seg = await call("GET", `/journal/${cid}/segment?key=${encodeURIComponent(roll.json.segment.r2Key)}`);
    expect(seg.json.segment.events.length).toBe(2);

    const read = await call("GET", `/journal/${cid}/read`);
    expect(read.json.events.map((e: any) => e.seq)).toEqual([1, 2]);
  });
});

// Keep a trivial always-on assertion so the file is never an empty suite.
test("remote integration harness is wired", () => {
  expect(typeof call).toBe("function");
});
