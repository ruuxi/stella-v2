/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js"]);
const createTest = () => convexTest(schema, modules);

const OWNER_ID = "hls-provider-outcome-owner";
const OWNER_GENERATION = "legacy";
const TICKET = "hls-provider-outcome-ticket";

const functions = internal as unknown as {
  tts_hls: {
    synthesizeHls: FunctionReference<
      "action",
      "internal",
      { ticket: string; ownerId: string; ownerGeneration: string },
      null
    >;
    discardOwnerTtsSessionsForMigrationInternal: FunctionReference<
      "mutation",
      "internal",
      { ownerId: string },
      { ready: boolean; deleted: number; pending: "" | "segments" | "tickets" }
    >;
  };
};

const seedHlsTicket = async (
  t: ReturnType<typeof createTest>,
  text = "synthesize this text",
) => {
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("tts_stream_tickets", {
      ticket: TICKET,
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      text,
      voice: "Brooke",
      model: "inworld-tts-2-flash",
      hlsStatus: "pending",
      hlsSegments: [],
      hlsDone: false,
      createdAt: now,
      expiresAt: now + 15 * 60_000,
    });
  });
  return text;
};

const runHlsSynthesis = async (t: ReturnType<typeof createTest>) => {
  await t.action(functions.tts_hls.synthesizeHls, {
    ticket: TICKET,
    ownerId: OWNER_ID,
    ownerGeneration: OWNER_GENERATION,
  });
};

const readOutcomeState = async (t: ReturnType<typeof createTest>) =>
  await t.run(async (ctx) => {
    const usage = await ctx.db
      .query("internal_tts_usage")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
      .take(4);
    const lease = await ctx.db
      .query("tts_provider_dispatch_leases")
      .withIndex("by_dispatchId", (q) => q.eq("dispatchId", `hls:${TICKET}`))
      .unique();
    const ticket = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", TICKET))
      .unique();
    return { usage, lease, ticket };
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("HLS TTS provider dispatch outcomes", () => {
  it("discards migration-fenced segment children before ephemeral tickets", async () => {
    const t = createTest();
    const now = Date.now();
    await seedHlsTicket(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("tts_hls_segments", {
        ticket: TICKET,
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        seq: 0,
        audio: "AQID",
        durationSec: 1,
        createdAt: now,
        expiresAt: now + 60_000,
      });
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: OWNER_ID,
        toOwnerId: "hls-destination-owner",
        status: "running",
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      t.mutation(
        functions.tts_hls.discardOwnerTtsSessionsForMigrationInternal,
        { ownerId: OWNER_ID },
      ),
    ).resolves.toEqual({ ready: false, deleted: 1, pending: "segments" });
    await expect(
      t.run(async (ctx) => ({
        segment: await ctx.db
          .query("tts_hls_segments")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", OWNER_ID),
          )
          .first(),
        ticket: await ctx.db
          .query("tts_stream_tickets")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", OWNER_ID),
          )
          .first(),
      })),
    ).resolves.toMatchObject({ segment: null, ticket: { ticket: TICKET } });
    await expect(
      t.mutation(
        functions.tts_hls.discardOwnerTtsSessionsForMigrationInternal,
        { ownerId: OWNER_ID },
      ),
    ).resolves.toEqual({ ready: false, deleted: 1, pending: "tickets" });
    await expect(
      t.mutation(
        functions.tts_hls.discardOwnerTtsSessionsForMigrationInternal,
        { ownerId: OWNER_ID },
      ),
    ).resolves.toEqual({ ready: true, deleted: 0, pending: "" });
  });

  it("settles a fully consumed successful stream before publishing HLS completion", async () => {
    vi.stubEnv("INWORLD_API_KEY", "test-inworld-key");
    const t = createTest();
    const text = await seedHlsTicket(t);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        `${JSON.stringify({ result: { audioContent: "AQID" } })}\n`,
        { status: 200 },
      ),
    );

    await runHlsSynthesis(t);

    const state = await readOutcomeState(t);
    expect(state.lease).toBeNull();
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      provider: "inworld",
      model: "inworld-tts-2-flash",
      voice: "Brooke",
      streaming: true,
      requestChars: text.length,
      providerDispatchOutcome: "settled",
      status: "completed",
      synthesizedChars: text.length,
      audioBytes: 3,
    });
    expect(state.ticket).toMatchObject({ hlsStatus: "done", hlsDone: true });
  });

  it("settles a fully consumed non-OK response with conservative full-request usage", async () => {
    vi.stubEnv("INWORLD_API_KEY", "test-inworld-key");
    const t = createTest();
    const text = await seedHlsTicket(t);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("provider rejected request", { status: 429 }),
    );

    await runHlsSynthesis(t);

    const state = await readOutcomeState(t);
    expect(state.lease).toBeNull();
    expect(state.usage[0]).toMatchObject({
      providerDispatchOutcome: "settled",
      status: "failed",
      synthesizedChars: text.length,
      audioBytes: 0,
    });
    expect(state.usage[0]?.costMicroCents).toBeGreaterThan(0);
    expect(state.ticket).toMatchObject({ hlsStatus: "error", hlsDone: true });
  });

  it("retains ambiguous spend debt when the provider fetch loses its response", async () => {
    vi.stubEnv("INWORLD_API_KEY", "test-inworld-key");
    const t = createTest();
    const text = await seedHlsTicket(t);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("connection reset after request write"),
    );

    await runHlsSynthesis(t);

    const state = await readOutcomeState(t);
    expect(state.lease).toMatchObject({
      dispatchId: `hls:${TICKET}`,
      kind: "hls",
      state: "cancel_requested",
      providerState: "may_have_dispatched",
      outcome: "may_have_dispatched",
    });
    expect(state.usage[0]).toMatchObject({
      providerDispatchOutcome: "may_have_dispatched",
      status: "interrupted",
      requestChars: text.length,
      synthesizedChars: text.length,
      audioBytes: 0,
    });
    expect(state.usage[0]?.costMicroCents).toBeGreaterThan(0);
    expect(state.ticket).toMatchObject({ hlsStatus: "error", hlsDone: true });
  });

  it("retains partial ambiguous spend when the provider body resets before EOF", async () => {
    vi.stubEnv("INWORLD_API_KEY", "test-inworld-key");
    const t = createTest();
    const text = await seedHlsTicket(t);
    const encoder = new TextEncoder();
    let pullCount = 0;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pullCount === 0) {
              pullCount += 1;
              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({ result: { audioContent: "AQID" } })}\n`,
                ),
              );
              return;
            }
            controller.error(new Error("provider body reset"));
          },
        }),
        { status: 200 },
      ),
    );

    await runHlsSynthesis(t);

    const state = await readOutcomeState(t);
    expect(state.lease).toMatchObject({
      state: "cancel_requested",
      outcome: "may_have_dispatched",
    });
    expect(state.usage[0]).toMatchObject({
      providerDispatchOutcome: "may_have_dispatched",
      status: "partial",
      requestChars: text.length,
      synthesizedChars: text.length,
      audioBytes: 3,
    });
    expect(state.ticket).toMatchObject({ hlsStatus: "error", hlsDone: true });
  });

  it("cancels a hung body after reset fencing and preserves ambiguous debt", async () => {
    vi.stubEnv("INWORLD_API_KEY", "test-inworld-key");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = createTest();
    const text = await seedHlsTicket(t);
    let resolveReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      resolveReadStarted = resolve;
    });
    let resolveReaderCanceled!: (reason: unknown) => void;
    const readerCanceled = new Promise<unknown>((resolve) => {
      resolveReaderCanceled = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel(reason) {
          resolveReaderCanceled(reason);
        },
      });
      const originalGetReader = body.getReader.bind(body);
      Object.defineProperty(body, "getReader", {
        value: () => {
          const reader = originalGetReader();
          const originalRead = reader.read.bind(reader);
          Object.defineProperty(reader, "read", {
            value: () => {
              resolveReadStarted();
              return originalRead();
            },
          });
          return reader;
        },
      });
      return new Response(body, { status: 200 });
    });

    const action = runHlsSynthesis(t).then(
      () => null,
      (error: unknown) => error,
    );
    await readStarted;

    const purge = await t.mutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId: OWNER_ID,
        operationId: "reset-hung-hls",
        mode: "reset",
        now: Date.now(),
      },
    );
    const leaseId = "reset-hung-hls-core-lease";
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId: OWNER_ID,
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "core",
      leaseId,
      now: Date.now(),
    });
    const canceled = await t.mutation(
      internal.tts_dispatch.cancelOwnerTtsProviderDispatchesInternal,
      {
        ownerId: OWNER_ID,
        operationId: purge.operationId,
        generation: purge.generation,
        leaseId,
        mode: "reset",
        now: Date.now(),
      },
    );
    expect(canceled.ready).toBe(false);

    await expect(readerCanceled).resolves.toBeTruthy();
    const actionError = await action;
    expect(String(actionError)).toMatch(/reset/u);

    const state = await readOutcomeState(t);
    expect(state.lease).toMatchObject({
      state: "cancel_requested",
      outcome: "may_have_dispatched",
    });
    expect(state.usage[0]).toMatchObject({
      providerDispatchOutcome: "may_have_dispatched",
      status: "interrupted",
      requestChars: text.length,
      synthesizedChars: text.length,
      audioBytes: 0,
    });
  });
});
