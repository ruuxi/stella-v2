import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LIVE_CLOSE } from "@stella/contracts/backend/protocol";
import { openSqlStorageFake, type SqlStorageFake } from "./fixtures/sql-storage.js";
import { installWebSocketPair, type FakeSocket } from "./helpers/owner-gate-harness.js";
import { number, object, string } from "../src/owner-store/args.js";
import { RpcError } from "../src/owner-store/errors.js";
import {
  createOwnerRegistry,
  type OwnerCaller,
  type OwnerDomain,
} from "../src/owner-store/registry.js";
import { OwnerStore } from "../src/owner-store/store.js";

installWebSocketPair();

const OWNER = "https://issuer.example|user-1";

const caller = (overrides: Partial<OwnerCaller> = {}): OwnerCaller => ({
  ownerId: OWNER,
  subject: "user-1",
  sessionId: "session-1",
  isAnonymous: false,
  expiresAtMs: Date.now() + 30 * 60_000,
  ...overrides,
});

const jobRuns: unknown[] = [];
let failNextJob = 0;

const notesDomain = {
  name: "notes",
  migrations: [
    {
      id: "notes.1-init",
      statements: [
        "CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
        "CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)",
      ],
    },
  ],
  calls: {
    "notes.add": {
      scope: "owner",
      parse: object({ id: string({ max: 64 }), body: string() }),
      handler: (ctx: any, args: { id: string; body: string }) => {
        ctx.db.run("INSERT INTO notes (id, body) VALUES (?, ?)", args.id, args.body);
        return { id: args.id };
      },
    },
    "notes.bump": {
      scope: "owner",
      parse: object({}),
      handler: (ctx: any) => {
        ctx.db.run(
          "INSERT INTO counters (name, value) VALUES ('bumps', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1",
        );
        return null;
      },
    },
    "notes.private": {
      scope: "owner",
      requireAccount: true,
      parse: object({}),
      handler: () => "secret",
    },
    "notes.explode": {
      scope: "owner",
      parse: object({}),
      handler: () => {
        throw new Error("database exploded with internal details");
      },
    },
    "notes.conflict": {
      scope: "owner",
      parse: object({}),
      handler: () => {
        throw new RpcError("CONFLICT", "Already there.");
      },
    },
    "notes.later": {
      scope: "owner",
      parse: object({ at: number(), id: string() }),
      handler: (ctx: any, args: { at: number; id: string }) => {
        ctx.jobs.schedule("notes.remind", args.at, { id: args.id }, { id: `remind:${args.id}` });
        return null;
      },
    },
  },
  views: {
    "notes.list": {
      parse: object({}),
      read: (ctx: any) => ctx.db.all("SELECT id, body FROM notes ORDER BY id"),
    },
    "notes.one": {
      parse: object({ id: string() }),
      read: (ctx: any, args: { id: string }) =>
        ctx.db.one("SELECT id, body FROM notes WHERE id = ?", args.id),
    },
  },
  jobs: {
    "notes.remind": {
      maxAttempts: 3,
      run: (ctx: any, payload: { id: string }) => {
        if (failNextJob > 0) {
          failNextJob -= 1;
          throw new Error("transient");
        }
        jobRuns.push(payload);
        ctx.db.run("INSERT INTO notes (id, body) VALUES (?, 'reminded')", `job-${payload.id}`);
      },
    },
  },
} as unknown as OwnerDomain;

type Harness = {
  store: OwnerStore;
  fake: SqlStorageFake;
  liveSockets: FakeSocket[];
  verified: Map<string, OwnerCaller>;
};

const createHarness = (domains: OwnerDomain[] = [notesDomain]): Harness => {
  const fake = openSqlStorageFake();
  const accepted: Array<{ socket: FakeSocket; tags: string[] }> = [];
  const verified = new Map<string, OwnerCaller>();
  const ctx = {
    storage: { sql: fake.sql, transactionSync: <T>(fn: () => T) => fn() },
    getWebSockets: (tag?: string) =>
      accepted
        .filter((entry) => !entry.socket.closed && (!tag || entry.tags.includes(tag)))
        .map((entry) => entry.socket),
    acceptWebSocket: (socket: FakeSocket, tags: string[]) => {
      accepted.push({ socket, tags });
    },
  };
  const store = new OwnerStore({
    ctx: ctx as unknown as DurableObjectState,
    env: {} as Cloudflare.Env,
    ownerId: () => OWNER,
    registry: createOwnerRegistry(domains),
    verifyToken: async (token) => verified.get(token) ?? null,
  });
  return {
    store,
    fake,
    get liveSockets() {
      return accepted.map((entry) => entry.socket);
    },
    verified,
  };
};

/** `acceptLive` returns the client end; the server end is what the store holds. */
const openLive = (harness: Harness, who = caller()): FakeSocket => {
  harness.store.acceptLive(who);
  return harness.liveSockets.at(-1)!;
};

const frames = (socket: FakeSocket) => socket.sent as unknown as Array<Record<string, any>>;

describe("OwnerStore", () => {
  let harness: Harness;
  beforeEach(() => {
    jobRuns.length = 0;
    failNextJob = 0;
    harness = createHarness();
  });
  afterEach(() => harness.fake.close());

  test("runs each migration once", () => {
    harness.store.ensureSchema();
    const second = new OwnerStore({
      ctx: { storage: { sql: harness.fake.sql } } as unknown as DurableObjectState,
      env: {} as Cloudflare.Env,
      ownerId: () => OWNER,
      registry: createOwnerRegistry([notesDomain]),
      verifyToken: async () => null,
    });
    second.ensureSchema();
    const applied = harness.fake.sql
      .exec<{ id: string }>("SELECT id FROM _owner_migrations")
      .toArray();
    expect(applied.map((row) => row.id)).toEqual(["notes.1-init"]);
  });

  test("calls return values and shaped errors", async () => {
    expect(await harness.store.call("notes.add", { id: "a", body: "hello" }, caller())).toEqual({
      ok: true,
      value: { id: "a" },
    });
    expect(await harness.store.call("notes.missing", {}, caller())).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await harness.store.call("notes.add", { id: 3 }, caller())).toMatchObject({
      ok: false,
      error: { code: "BAD_REQUEST", message: "id must be a string." },
    });
    expect(
      await harness.store.call("notes.add", { id: "b", body: "x", extra: 1 }, caller()),
    ).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    expect(
      await harness.store.call("notes.private", {}, caller({ isAnonymous: true })),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(
      await harness.store.call("notes.private", {}, caller({ ownerId: "someone-else" })),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await harness.store.call("notes.conflict", {}, caller())).toEqual({
      ok: false,
      error: { code: "CONFLICT", message: "Already there.", retryable: false },
    });
    const exploded = await harness.store.call("notes.explode", {}, caller());
    expect(exploded).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(exploded)).not.toContain("internal details");
  });

  test("pushes a view on subscribe and again only when its value changes", async () => {
    const socket = openLive(harness);
    await harness.store.onLiveMessage(
      socket as unknown as WebSocket,
      JSON.stringify({ t: "sub", id: "1", view: "notes.list", args: {} }),
    );
    expect(frames(socket)).toEqual([{ t: "value", id: "1", value: [] }]);

    await harness.store.call("notes.add", { id: "a", body: "hello" }, caller());
    expect(frames(socket).at(-1)).toEqual({
      t: "value",
      id: "1",
      value: [{ id: "a", body: "hello" }],
    });

    // A write the view can't see leaves it alone.
    const before = frames(socket).length;
    await harness.store.call("notes.bump", {}, caller());
    expect(frames(socket).length).toBe(before);

    await harness.store.onLiveMessage(
      socket as unknown as WebSocket,
      JSON.stringify({ t: "unsub", id: "1" }),
    );
    await harness.store.call("notes.add", { id: "b", body: "two" }, caller());
    expect(frames(socket).length).toBe(before);
  });

  test("fans a change out to every socket and drops subscriptions on close", async () => {
    const first = openLive(harness);
    const second = openLive(harness);
    for (const [socket, id] of [[first, "x"], [second, "y"]] as const) {
      await harness.store.onLiveMessage(
        socket as unknown as WebSocket,
        JSON.stringify({ t: "sub", id, view: "notes.one", args: { id: "a" } }),
      );
    }
    await harness.store.call("notes.add", { id: "a", body: "hi" }, caller());
    expect(frames(first).at(-1)).toEqual({ t: "value", id: "x", value: { id: "a", body: "hi" } });
    expect(frames(second).at(-1)).toEqual({ t: "value", id: "y", value: { id: "a", body: "hi" } });

    harness.store.onLiveClose(first as unknown as WebSocket);
    const rows = harness.fake.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM owner_live_subs")
      .toArray()[0]!.n;
    expect(rows).toBe(1);
  });

  test("reports view errors once and refuses unknown views", async () => {
    const socket = openLive(harness);
    await harness.store.onLiveMessage(
      socket as unknown as WebSocket,
      JSON.stringify({ t: "sub", id: "1", view: "notes.nope", args: {} }),
    );
    expect(frames(socket)).toEqual([
      { t: "error", id: "1", error: expect.objectContaining({ code: "NOT_FOUND" }) },
    ]);
    await harness.store.call("notes.add", { id: "a", body: "x" }, caller());
    expect(frames(socket).length).toBe(1);
  });

  test("asks for a fresh token before expiry and closes at expiry", async () => {
    const expiresAtMs = Date.now() + 60_000;
    const socket = openLive(harness, caller({ expiresAtMs }));
    expect(harness.store.nextDeadline()).toBe(expiresAtMs - 120_000);

    await harness.store.onAlarm(Date.now());
    expect(frames(socket).at(-1)).toEqual({ t: "reauth", expiresAtMs });
    expect(harness.store.nextDeadline()).toBe(expiresAtMs);

    const renewed = caller({ expiresAtMs: Date.now() + 30 * 60_000 });
    harness.verified.set("fresh-token", renewed);
    await harness.store.onLiveMessage(
      socket as unknown as WebSocket,
      JSON.stringify({ t: "auth", token: "fresh-token" }),
    );
    expect(socket.closed).toBe(false);
    expect(harness.store.nextDeadline()).toBe(renewed.expiresAtMs - 120_000);

    const stale = openLive(harness, caller({ expiresAtMs: Date.now() + 1_000 }));
    await harness.store.onAlarm(Date.now() + 2_000);
    expect(stale.closes).toEqual([{ code: LIVE_CLOSE.unauthenticated, reason: "token_expired" }]);
  });

  test("rejects a refreshed token for a different account", async () => {
    const socket = openLive(harness);
    harness.verified.set("other", caller({ ownerId: "other-owner", subject: "user-2" }));
    await harness.store.onLiveMessage(
      socket as unknown as WebSocket,
      JSON.stringify({ t: "auth", token: "other" }),
    );
    expect(socket.closes).toEqual([{ code: LIVE_CLOSE.unauthenticated, reason: "token_rejected" }]);
  });

  test("runs due jobs, retries with backoff, and dedupes by id", async () => {
    const now = Date.now();
    await harness.store.call("notes.later", { at: now + 5_000, id: "a" }, caller());
    await harness.store.call("notes.later", { at: now + 1_000, id: "a" }, caller());
    expect(harness.store.nextDeadline()).toBe(now + 1_000);

    expect(await harness.store.runDueJobs(now)).toBe(0);

    failNextJob = 1;
    await harness.store.runDueJobs(now + 1_000);
    expect(jobRuns).toEqual([]);
    expect(harness.store.nextDeadline()).toBe(now + 1_000 + 1_000);

    await harness.store.runDueJobs(now + 2_000);
    expect(jobRuns).toEqual([{ id: "a" }]);
    expect(harness.store.nextDeadline()).toBe(Number.POSITIVE_INFINITY);
  });

  test("a job's write reaches live views", async () => {
    const socket = openLive(harness);
    await harness.store.onLiveMessage(
      socket as unknown as WebSocket,
      JSON.stringify({ t: "sub", id: "1", view: "notes.list", args: {} }),
    );
    const now = Date.now();
    await harness.store.call("notes.later", { at: now, id: "z" }, caller());
    await harness.store.runDueJobs(now);
    expect(frames(socket).at(-1)).toEqual({
      t: "value",
      id: "1",
      value: [{ id: "job-z", body: "reminded" }],
    });
  });

  test("drops a job after its last attempt", async () => {
    const now = Date.now();
    await harness.store.call("notes.later", { at: now, id: "q" }, caller());
    failNextJob = 3;
    await harness.store.runDueJobs(now);
    await harness.store.runDueJobs(now + 10_000);
    await harness.store.runDueJobs(now + 20_000);
    expect(harness.store.nextDeadline()).toBe(Number.POSITIVE_INFINITY);
    expect(jobRuns).toEqual([]);
  });
});
