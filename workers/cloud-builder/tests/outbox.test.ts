import { describe, expect, test } from "bun:test";
import {
  CONVEX_OUTBOX_PATH,
  OUTBOX_MAX_BATCH,
  type OutboxEvent,
} from "@stella/contracts/turn-plane/outbox";
import {
  deliverOutboxBatch,
  enqueueOutbox,
  isOutboxEvent,
} from "../src/outbox.js";
import { fakeOutbox } from "./helpers/turn-plane-fakes.js";

const event = (key: string, kind: OutboxEvent["kind"] = "turn.event") =>
  ({
    v: 1,
    kind,
    key,
    ownerId: "owner-1",
    ownerGeneration: "generation-1",
    emittedAt: 1,
    turnId: "turn-1",
    sessionId: "chat-1",
    eventSeq: 1,
    eventKind: "started",
    payload: {},
    terminal: false,
    createdAt: 1,
  }) as OutboxEvent;

const batchOf = (bodies: unknown[]) => {
  const acked: unknown[] = [];
  let ackedAll = 0;
  let retriedAll = 0;
  return {
    batch: {
      messages: bodies.map((body) => ({
        body,
        ack: () => {
          acked.push(body);
        },
      })),
      ackAll: () => {
        ackedAll += 1;
      },
      retryAll: () => {
        retriedAll += 1;
      },
    },
    acked,
    ackedAll: () => ackedAll,
    retriedAll: () => retriedAll,
  };
};

const env = {
  STELLA_CONVEX_SITE_URL: "https://convex.example/",
  BUILDER_SERVICE_SECRET: "builder-secret",
};

describe("outbox producer", () => {
  test("sends in OUTBOX_MAX_BATCH-sized sendBatch calls and nothing for an empty list", async () => {
    const outbox = fakeOutbox();
    const events = Array.from({ length: OUTBOX_MAX_BATCH * 2 + 3 }, (_, i) =>
      event(`k-${i}`),
    );
    await enqueueOutbox({ TURN_OUTBOX: outbox.queue }, events);
    expect(outbox.batches.map((batch) => batch.length)).toEqual([
      OUTBOX_MAX_BATCH,
      OUTBOX_MAX_BATCH,
      3,
    ]);
    expect(outbox.events.map((entry) => entry.key)).toEqual(
      events.map((entry) => entry.key),
    );
    await enqueueOutbox({ TURN_OUTBOX: outbox.queue }, []);
    expect(outbox.batches).toHaveLength(3);
  });

  test("throws when the queue is unbound or refuses, leaving the retry to the caller", async () => {
    await expect(enqueueOutbox({}, [event("k")])).rejects.toThrow(
      "TURN_OUTBOX queue is not bound.",
    );
    const outbox = fakeOutbox();
    outbox.failNext(1);
    await expect(
      enqueueOutbox({ TURN_OUTBOX: outbox.queue }, [event("k")]),
    ).rejects.toThrow("queue unavailable");
    expect(outbox.events).toHaveLength(0);
  });

  test("recognizes only well-formed events", () => {
    expect(isOutboxEvent(event("k"))).toBe(true);
    expect(isOutboxEvent({ ...event("k"), v: 2 })).toBe(false);
    expect(isOutboxEvent({ ...event("k"), key: "" })).toBe(false);
    expect(isOutboxEvent({ ...event("k"), ownerGeneration: undefined })).toBe(
      false,
    );
    expect(isOutboxEvent("nope")).toBe(false);
  });
});

describe("outbox consumer", () => {
  test("posts the batch with the service secret and acks on a 2xx verdict, logging rejections", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const { batch, ackedAll, retriedAll } = batchOf([
      event("a"),
      event("b"),
      event("c"),
    ]);
    const delivery = await deliverOutboxBatch(batch, env, {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        return Response.json({
          applied: ["turn.event:a"],
          duplicate: ["turn.event:b"],
          rejected: [{ kind: "turn.event", key: "c", reason: "unknown_turn" }],
        });
      }) as typeof fetch,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`https://convex.example${CONVEX_OUTBOX_PATH}`);
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer builder-secret");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      v: 1,
      events: [event("a"), event("b"), event("c")],
    });
    expect(delivery).toMatchObject({
      disposition: "acked",
      status: 200,
      events: 3,
      applied: 1,
      duplicate: 1,
      rejected: 1,
    });
    expect(ackedAll()).toBe(1);
    expect(retriedAll()).toBe(0);
  });

  test("retries the whole batch on 5xx, 429, 408, timeouts, and malformed 2xx verdicts", async () => {
    for (const respond of [
      () => new Response("down", { status: 503 }),
      () => new Response("slow down", { status: 429 }),
      () => new Response("timeout", { status: 408 }),
      () => {
        throw new Error("network");
      },
      () => new Response("<html>proxy</html>", { status: 200 }),
    ]) {
      const { batch, ackedAll, retriedAll } = batchOf([event("a")]);
      const delivery = await deliverOutboxBatch(batch, env, {
        fetch: (async () => respond()) as typeof fetch,
      });
      expect(delivery.disposition).toBe("retried");
      expect(retriedAll()).toBe(1);
      expect(ackedAll()).toBe(0);
    }
  });

  test("acks and logs a non-retryable 4xx so a poisoned batch cannot block the queue", async () => {
    const { batch, ackedAll, retriedAll } = batchOf([event("a"), event("b")]);
    const delivery = await deliverOutboxBatch(batch, env, {
      fetch: (async () =>
        Response.json({ error: "bad contract" }, { status: 400 })) as typeof fetch,
    });
    expect(delivery).toMatchObject({
      disposition: "acked",
      status: 400,
      events: 2,
      rejected: 2,
    });
    expect(ackedAll()).toBe(1);
    expect(retriedAll()).toBe(0);
  });

  test("acks malformed messages individually and never posts them", async () => {
    let posted = 0;
    const { batch, acked, ackedAll } = batchOf([
      { garbage: true },
      event("real"),
    ]);
    const delivery = await deliverOutboxBatch(batch, env, {
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        posted += 1;
        expect(JSON.parse(String(init?.body)).events).toEqual([event("real")]);
        return Response.json({ applied: ["turn.event:real"], duplicate: [], rejected: [] });
      }) as typeof fetch,
    });
    expect(acked).toEqual([{ garbage: true }]);
    expect(posted).toBe(1);
    expect(delivery.events).toBe(1);
    expect(ackedAll()).toBe(1);

    const onlyGarbage = batchOf([null, 42]);
    const empty = await deliverOutboxBatch(onlyGarbage.batch, env, {
      fetch: (async () => {
        throw new Error("must not post");
      }) as typeof fetch,
    });
    expect(empty.disposition).toBe("empty");
    expect(onlyGarbage.acked).toHaveLength(2);
    expect(onlyGarbage.ackedAll()).toBe(1);
  });

  test("an unconfigured consumer retries with a delay instead of dropping projections", async () => {
    const { batch, retriedAll } = batchOf([event("a")]);
    const delivery = await deliverOutboxBatch(batch, {}, {
      fetch: (async () => {
        throw new Error("must not post");
      }) as typeof fetch,
    });
    expect(delivery.disposition).toBe("retried");
    expect(retriedAll()).toBe(1);
  });
});
