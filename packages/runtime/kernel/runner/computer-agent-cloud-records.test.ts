import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeDesktopDatabase } from "../storage/database-init.js";
import { SessionStore } from "../storage/session-store.js";
import type { SqliteDatabase } from "../storage/shared.js";
import {
  CloudAgentStartAdmissionError,
  createComputerAgentCloudRecords as createComputerAgentCloudRecordsRaw,
  isCloudAgentStartAdmissionError,
  resolveConvexJwtOwnerScope,
} from "./computer-agent-cloud-records.js";

const OWNER_A_GENERATION = "owner-a-generation-1";
const OWNER_B_GENERATION = "owner-b-generation-1";
const activeRecords = new Set<
  ReturnType<typeof createComputerAgentCloudRecordsRaw>
>();
const openDatabases = new Set<Database>();

const createComputerAgentCloudRecords = (
  options: Parameters<typeof createComputerAgentCloudRecordsRaw>[0],
) => {
  const records = createComputerAgentCloudRecordsRaw(options);
  activeRecords.add(records);
  return records;
};

afterEach(() => {
  for (const records of activeRecords) records.stop();
  activeRecords.clear();
  for (const database of openDatabases) {
    try {
      database.close();
    } catch {
      // A test may have already closed its database on the happy path.
    }
  }
  openDatabases.clear();
});

const refs = {
  local_agent_threads: {
    startMyComputerAgentThread: "start",
    completeMyComputerAgentThread: "complete",
    getMyComputerAgentThread: "get",
    cancelMyComputerAgentThread: "cancel",
  },
};

const createStore = (database = new Database(":memory:")) => {
  openDatabases.add(database);
  initializeDesktopDatabase(database as unknown as SqliteDatabase);
  return {
    database,
    store: new SessionStore(database as unknown as SqliteDatabase),
  };
};

const authToken = (subject: string): string => {
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://auth.stella.test",
      sub: subject,
      tokenIdentifier: `https://auth.stella.test|${subject}`,
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
};

const ownerAAuthToken = authToken("owner-a");
const ownerBAuthToken = authToken("owner-b");

const waitUntil = async (
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for computer-agent reconciliation.");
    }
    await Bun.sleep(10);
  }
};

describe("computer agent cloud lifecycle records", () => {
  test("publishes the exact local thread and attempt into the cloud row", async () => {
    const { database, store } = createStore();
    const calls: Array<{ ref: unknown; args: unknown }> = [];
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-1",
      store,
      getAuthToken: () => ownerAAuthToken,
      mutation: async (ref, args) => {
        calls.push({ ref, args });
        return { agentId: "thread-7" };
      },
      query: async () => null,
    });

    await expect(
      records.create({
        agentId: "thread-7",
        conversationId: "conversation-1",
        description: "Inspect the workspace",
        agentType: "general",
        attemptGeneration: 3,
        ownerGeneration: OWNER_A_GENERATION,
      }),
    ).resolves.toEqual({ agentId: "thread-7" });
    expect(calls).toEqual([
      {
        ref: "start",
        args: {
          threadId: "thread-7",
          conversationId: "conversation-1",
          originDeviceId: "device-1",
          description: "Inspect the workspace",
          agentType: "general",
          attemptGeneration: 3,
          ownerGeneration: OWNER_A_GENERATION,
        },
      },
    ]);
    expect(records.pending()).toBe(0);
    records.stop();
    database.close();
  });

  test("maps local error and cancel states into fenced cloud mutations", async () => {
    const { database, store } = createStore();
    store.bindComputerAgentCloudThreadAuthority(
      "thread-7",
      resolveConvexJwtOwnerScope(ownerAAuthToken)!,
      OWNER_A_GENERATION,
    );
    const calls: Array<{ ref: unknown; args: unknown }> = [];
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-1",
      store,
      getAuthToken: () => ownerAAuthToken,
      mutation: async (ref, args) => {
        calls.push({ ref, args });
        return ref === "cancel" ? { canceled: true } : { updated: true };
      },
      query: async () => null,
    });

    await records.complete({
      agentId: "thread-7",
      attemptGeneration: 4,
      ownerGeneration: OWNER_A_GENERATION,
      status: "error",
      error: "Provider failed",
    });
    await expect(
      records.cancel("thread-7", "Paused", 5, OWNER_A_GENERATION),
    ).resolves.toEqual({
      canceled: true,
    });
    expect(calls).toEqual([
      {
        ref: "complete",
        args: {
          threadId: "thread-7",
          originDeviceId: "device-1",
          attemptGeneration: 4,
          ownerGeneration: OWNER_A_GENERATION,
          status: "failed",
          error: "Provider failed",
        },
      },
      {
        ref: "cancel",
        args: {
          threadId: "thread-7",
          originDeviceId: "device-1",
          attemptGeneration: 5,
          ownerGeneration: OWNER_A_GENERATION,
          reason: "Paused",
        },
      },
    ]);
    expect(records.pending()).toBe(0);
    records.stop();
    database.close();
  });

  test("reads canonical computer-agent snapshots and fails closed signed out", async () => {
    const signedInStorage = createStore();
    const signedIn = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-1",
      store: signedInStorage.store,
      getAuthToken: () => ownerAAuthToken,
      mutation: async () => ({ canceled: false }),
      query: async () => ({
        id: "thread-7",
        status: "completed",
        description: "Inspect the workspace",
        startedAt: 10,
        completedAt: 20,
        result: "Done",
        error: null,
      }),
    });
    signedInStorage.store.bindComputerAgentCloudThreadAuthority(
      "thread-7",
      resolveConvexJwtOwnerScope(ownerAAuthToken)!,
      OWNER_A_GENERATION,
    );
    await expect(signedIn.get("thread-7")).resolves.toEqual({
      id: "thread-7",
      status: "completed",
      description: "Inspect the workspace",
      startedAt: 10,
      completedAt: 20,
      result: "Done",
    });

    const signedOutStorage = createStore();
    const signedOut = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-1",
      store: signedOutStorage.store,
      getAuthToken: () => null,
      mutation: async () => {
        throw new Error("must not run");
      },
      query: async () => {
        throw new Error("must not run");
      },
    });
    await expect(signedOut.get("thread-7")).resolves.toBeNull();
    await expect(signedOut.cancel("thread-7")).resolves.toEqual({
      canceled: false,
    });
    signedIn.stop();
    signedOut.stop();
    signedInStorage.database.close();
    signedOutStorage.database.close();
  });

  test("fails closed without an exact attempt generation even while signed in", async () => {
    const { database, store } = createStore();
    const ownerScope = resolveConvexJwtOwnerScope(ownerAAuthToken)!;
    store.bindComputerAgentCloudThreadAuthority(
      "thread-unknown-attempt",
      ownerScope,
      OWNER_A_GENERATION,
    );
    let mutations = 0;
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-unknown-attempt",
      store,
      getAuthToken: () => ownerAAuthToken,
      mutation: async () => {
        mutations += 1;
        return { canceled: true };
      },
      query: async () => null,
    });

    await expect(
      records.cancel(
        "thread-unknown-attempt",
        "Unknown local agent",
        undefined,
        OWNER_A_GENERATION,
      ),
    ).resolves.toEqual({ canceled: false });
    expect(mutations).toBe(0);
    expect(records.pending()).toBe(0);

    records.stop();
    database.close();
  });

  test("retries a durably admitted start as soon as authentication arrives", async () => {
    const { database, store } = createStore();
    // The runtime saw owner A before a refresh gap. That is enough to bind
    // new local work to A without ever guessing a different future account.
    let token: string | null = ownerAAuthToken;
    const calls: unknown[] = [];
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-auth-late",
      store,
      getAuthToken: () => token,
      mutation: async (ref) => {
        calls.push(ref);
        return { agentId: "thread-auth-late" };
      },
      query: async () => null,
    });

    token = null;
    const error = await records
      .create({
        agentId: "thread-auth-late",
        conversationId: "conversation-1",
        description: "Wait for sign in",
        agentType: "general",
        attemptGeneration: 1,
        ownerGeneration: OWNER_A_GENERATION,
      })
      .catch((caught: unknown) => caught);
    expect(isCloudAgentStartAdmissionError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "COMPUTER_AGENT_START_ACK_PENDING",
      retryable: true,
    });
    expect(records.pending()).toBe(1);
    expect(calls).toEqual([]);

    token = ownerAAuthToken;
    records.resume();
    await waitUntil(() => records.pending() === 0);
    expect(calls).toEqual(["start"]);

    records.stop();
    database.close();
  });

  test("keeps network failures queued and retries without duplicating the canonical id", async () => {
    const { database, store } = createStore();
    let failNetwork = true;
    const calls: unknown[] = [];
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-network",
      store,
      getAuthToken: () => ownerAAuthToken,
      mutation: async (ref) => {
        calls.push(ref);
        if (failNetwork) throw new Error("offline");
        return { agentId: "thread-network" };
      },
      query: async () => null,
    });

    await expect(
      records.create({
        agentId: "thread-network",
        conversationId: "conversation-1",
        description: "Retry offline start",
        agentType: "general",
        attemptGeneration: 2,
        ownerGeneration: OWNER_A_GENERATION,
      }),
    ).rejects.toMatchObject({
      code: "COMPUTER_AGENT_START_ACK_PENDING",
      retryable: true,
    });
    expect(records.pending()).toBe(1);

    failNetwork = false;
    records.resume();
    await waitUntil(() => records.pending() === 0);
    expect(calls).toEqual(["start", "start"]);

    records.stop();
    database.close();
  });

  test("terminalizes a canonical start rejection instead of retrying it", async () => {
    const { database, store } = createStore();
    let calls = 0;
    const rejected = Object.assign(new Error("attempt generation is not next"), {
      data: {
        code: "COMPUTER_AGENT_START_REJECTED",
        reason: "attempt_not_next",
        message: "Computer agent attempt generation is not next.",
      },
    });
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-canonical-rejection",
      store,
      getAuthToken: () => ownerAAuthToken,
      mutation: async () => {
        calls += 1;
        throw rejected;
      },
      query: async () => null,
    });

    const error = await records
      .create({
        agentId: "thread-canonical-rejection",
        conversationId: "conversation-1",
        description: "Impossible generation",
        agentType: "general",
        attemptGeneration: 4,
        ownerGeneration: OWNER_A_GENERATION,
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "CloudAgentStartAdmissionError",
      code: "COMPUTER_AGENT_START_REJECTED",
      retryable: false,
    });
    expect(records.pending()).toBe(0);
    records.resume();
    await Bun.sleep(20);
    expect(calls).toBe(1);

    records.stop();
    database.close();
  });

  test("a lost start response never admits provider work until a later exact ACK", async () => {
    const { database, store } = createStore();
    let loseResponse = true;
    let calls = 0;
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-lost-start-response",
      store,
      getAuthToken: () => ownerAAuthToken,
      mutation: async () => {
        calls += 1;
        if (loseResponse) throw new Error("response lost after canonical commit");
        return { agentId: "thread-lost-start-response" };
      },
      query: async () => null,
    });
    const start = {
      agentId: "thread-lost-start-response",
      conversationId: "conversation-1",
      description: "Lost response",
      agentType: "general",
      attemptGeneration: 1,
      ownerGeneration: OWNER_A_GENERATION,
    };

    await expect(records.create(start)).rejects.toMatchObject({
      code: "COMPUTER_AGENT_START_ACK_PENDING",
      retryable: true,
    });
    expect(records.pending()).toBe(1);
    expect(calls).toBe(1);

    // Background reconciliation may prove the original canonical commit, but
    // it cannot retroactively release an admission caller that already failed.
    loseResponse = false;
    records.resume();
    await waitUntil(() => records.pending() === 0);
    expect(calls).toBe(2);

    // Recovery replays the deterministic exact start and only this observed
    // ACK is allowed to release the provider attempt.
    await expect(records.create(start)).resolves.toEqual({
      agentId: "thread-lost-start-response",
    });
    expect(calls).toBe(3);

    records.stop();
    database.close();
  });

  test("replays start then restart terminal from SQLite after a worker restart", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stella-computer-agent-outbox-"),
    );
    const databasePath = path.join(temporaryRoot, "stella.sqlite");
    try {
      const firstStorage = createStore(new Database(databasePath));
      const first = createComputerAgentCloudRecords({
        convexApi: refs,
        deviceId: "device-restart",
        store: firstStorage.store,
        getAuthToken: () => ownerAAuthToken,
        mutation: async () => {
          throw new Error("offline before restart");
        },
        query: async () => null,
      });
      await expect(
        first.create({
          agentId: "thread-restart",
          conversationId: "conversation-1",
          description: "Interrupted by restart",
          agentType: "general",
          attemptGeneration: 7,
          ownerGeneration: OWNER_A_GENERATION,
        }),
      ).rejects.toMatchObject({
        code: "COMPUTER_AGENT_START_ACK_PENDING",
        retryable: true,
      });
      // Runtime shutdown stops networking before it cancels active tasks.
      // Admission must remain synchronous and durable while delivery is
      // stopped so the replacement worker can reconcile the terminal.
      first.stop();
      await first.complete({
        agentId: "thread-restart",
        attemptGeneration: 7,
        ownerGeneration: OWNER_A_GENERATION,
        status: "canceled",
        error: "Stella restarted while this task was running.",
      });
      expect(first.pending()).toBe(2);
      firstStorage.database.close();

      const calls: Array<{ ref: unknown; args: unknown }> = [];
      const restartedStorage = createStore(new Database(databasePath));
      const restarted = createComputerAgentCloudRecords({
        convexApi: refs,
        deviceId: "device-restart",
        store: restartedStorage.store,
        getAuthToken: () => ownerAAuthToken,
        mutation: async (ref, args) => {
          calls.push({ ref, args });
          return ref === "start"
            ? { agentId: "thread-restart" }
            : { updated: true };
        },
        query: async () => null,
      });
      await waitUntil(() => restarted.pending() === 0);
      expect(calls.map((call) => call.ref)).toEqual(["start", "complete"]);
      expect(calls[1]?.args).toEqual({
        threadId: "thread-restart",
        originDeviceId: "device-restart",
        attemptGeneration: 7,
        ownerGeneration: OWNER_A_GENERATION,
        status: "canceled",
        error: "Stella restarted while this task was running.",
      });
      restarted.stop();
      restartedStorage.database.close();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("lets owner B progress past owner A, then resumes A on return", async () => {
    const { database, store } = createStore();
    let token = ownerAAuthToken;
    let ownerAOffline = true;
    const calls: Array<{ ownerScope: string | null; threadId: string }> = [];
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-switch",
      store,
      getAuthToken: () => token,
      mutation: async (_ref, rawArgs) => {
        const args = rawArgs as { threadId: string };
        const ownerScope = resolveConvexJwtOwnerScope(token);
        calls.push({ ownerScope, threadId: args.threadId });
        if (ownerScope === resolveConvexJwtOwnerScope(ownerAAuthToken)) {
          if (ownerAOffline) throw new Error("owner A offline");
        }
        return { agentId: args.threadId };
      },
      query: async () => null,
    });

    await expect(
      records.create({
        agentId: "thread-owner-a",
        conversationId: "conversation-a",
        description: "Owner A task",
        agentType: "general",
        attemptGeneration: 1,
        ownerGeneration: OWNER_A_GENERATION,
      }),
    ).rejects.toBeInstanceOf(CloudAgentStartAdmissionError);
    expect(records.pending()).toBe(1);

    token = ownerBAuthToken;
    records.resume();
    await records.create({
      agentId: "thread-owner-b",
      conversationId: "conversation-b",
      description: "Owner B task",
      agentType: "general",
      attemptGeneration: 1,
      ownerGeneration: OWNER_B_GENERATION,
    });
    await waitUntil(() => records.pending() === 1);
    expect(calls.some((call) => call.threadId === "thread-owner-b")).toBe(true);
    expect(
      store.listComputerAgentCloudOutbox(
        resolveConvexJwtOwnerScope(ownerAAuthToken)!,
      ),
    ).toHaveLength(1);

    ownerAOffline = false;
    token = ownerAAuthToken;
    records.resume();
    await waitUntil(() => records.pending() === 0);
    expect(
      calls.filter((call) => call.threadId === "thread-owner-a"),
    ).toHaveLength(2);

    records.stop();
    database.close();
  });

  test("does not acknowledge owner A when auth switches during delivery", async () => {
    const { database, store } = createStore();
    let token = ownerAAuthToken;
    let releaseOwnerA: (() => void) | null = null;
    let ownerAAttempts = 0;
    const calls: string[] = [];
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-inflight-switch",
      store,
      getAuthToken: () => token,
      mutation: async (_ref, rawArgs) => {
        const args = rawArgs as { threadId: string };
        calls.push(args.threadId);
        if (args.threadId === "thread-owner-a") {
          ownerAAttempts += 1;
          if (ownerAAttempts === 1) {
            await new Promise<void>((resolve) => {
              releaseOwnerA = resolve;
            });
          }
        }
        return { agentId: args.threadId };
      },
      query: async () => null,
    });

    const ownerACreate = records.create({
      agentId: "thread-owner-a",
      conversationId: "conversation-a",
      description: "Owner A in flight",
      agentType: "general",
      attemptGeneration: 1,
      ownerGeneration: OWNER_A_GENERATION,
    });
    await waitUntil(() => releaseOwnerA !== null);

    token = ownerBAuthToken;
    records.resume();
    releaseOwnerA!();
    await expect(ownerACreate).rejects.toMatchObject({
      code: "COMPUTER_AGENT_START_ACK_PENDING",
      retryable: true,
    });
    await records.create({
      agentId: "thread-owner-b",
      conversationId: "conversation-b",
      description: "Owner B after switch",
      agentType: "general",
      attemptGeneration: 1,
      ownerGeneration: OWNER_B_GENERATION,
    });
    await waitUntil(() => calls.includes("thread-owner-b"));
    expect(records.pending()).toBe(1);

    token = ownerAAuthToken;
    records.resume();
    await waitUntil(() => records.pending() === 0);
    expect(ownerAAttempts).toBe(2);

    records.stop();
    database.close();
  });

  test("quarantines legacy unscoped rows without blocking a scoped owner", async () => {
    const { database, store } = createStore();
    store.putComputerAgentCloudOutbox({
      id: "legacy-unscoped",
      kind: "start",
      threadId: "thread-legacy",
      attemptGeneration: 1,
      ownerScope: null,
      ownerGeneration: null,
      payloadJson: JSON.stringify({
        conversationId: "legacy-conversation",
        description: "Legacy task",
        agentType: "general",
      }),
    });
    const calls: string[] = [];
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-legacy",
      store,
      getAuthToken: () => ownerBAuthToken,
      mutation: async (_ref, rawArgs) => {
        const args = rawArgs as { threadId: string };
        calls.push(args.threadId);
        return { agentId: args.threadId };
      },
      query: async () => null,
    });

    await records.create({
      agentId: "thread-owner-b",
      conversationId: "conversation-b",
      description: "Owner B task",
      agentType: "general",
      attemptGeneration: 1,
      ownerGeneration: OWNER_B_GENERATION,
    });
    await waitUntil(() => calls.includes("thread-owner-b"));
    expect(calls).toEqual(["thread-owner-b"]);
    expect(records.pending()).toBe(1);
    expect(store.hasUnscopedComputerAgentCloudOutbox("thread-legacy")).toBe(
      true,
    );

    records.stop();
    database.close();
  });

  test("tombstones an exact generation when Convex reports it stale", async () => {
    const { database, store } = createStore();
    const stale = Object.assign(new Error("generation stale"), {
      data: { code: "OWNER_DATA_GENERATION_STALE" },
    });
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-stale",
      store,
      getAuthToken: () => ownerAAuthToken,
      mutation: async () => {
        throw stale;
      },
      query: async () => null,
    });

    await expect(
      records.create({
        agentId: "thread-stale",
        conversationId: "conversation-a",
        description: "Old generation",
        agentType: "general",
        attemptGeneration: 1,
        ownerGeneration: OWNER_A_GENERATION,
      }),
    ).rejects.toThrow("OWNER_DATA_GENERATION_STALE");

    expect(records.pending()).toBe(0);
    expect(
      store.getComputerAgentCloudThreadAuthority("thread-stale"),
    ).toBeNull();
    expect(
      store.isComputerAgentCloudGenerationRetired({
        threadId: "thread-stale",
        ownerScope: resolveConvexJwtOwnerScope(ownerAAuthToken)!,
        ownerGeneration: OWNER_A_GENERATION,
      }),
    ).toBe(true);
    records.stop();
    database.close();
  });

  test("rebinds one mutable thread id to N+1 and deletes queued generation N", async () => {
    const { database, store } = createStore();
    const generationTwo = "owner-a-generation-2";
    let offline = true;
    const delivered: Array<Record<string, unknown>> = [];
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-aba",
      store,
      getAuthToken: () => ownerAAuthToken,
      mutation: async (_ref, args) => {
        if (offline) throw new Error("offline");
        delivered.push(args as Record<string, unknown>);
        return { agentId: "thread-aba" };
      },
      query: async () => null,
    });

    await expect(
      records.create({
        agentId: "thread-aba",
        conversationId: "conversation-a",
        description: "Generation N",
        agentType: "general",
        attemptGeneration: 1,
        ownerGeneration: OWNER_A_GENERATION,
      }),
    ).rejects.toMatchObject({ retryable: true });
    await expect(
      records.create({
        agentId: "thread-aba",
        conversationId: "conversation-a",
        description: "Generation N+1",
        agentType: "general",
        attemptGeneration: 1,
        ownerGeneration: generationTwo,
      }),
    ).rejects.toMatchObject({ retryable: true });

    const ownerScope = resolveConvexJwtOwnerScope(ownerAAuthToken)!;
    expect(store.listComputerAgentCloudOutbox(ownerScope)).toMatchObject([
      { threadId: "thread-aba", ownerGeneration: generationTwo },
    ]);
    expect(store.getComputerAgentCloudThreadAuthority("thread-aba")).toEqual({
      ownerScope,
      ownerGeneration: generationTwo,
    });

    offline = false;
    records.resume();
    await waitUntil(() => records.pending() === 0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.ownerGeneration).toBe(generationTwo);
    records.stop();
    database.close();
  });

  test("an in-flight generation N ACK cannot release work after N+1 rebinds the thread", async () => {
    const { database, store } = createStore();
    const generationTwo = "owner-a-generation-2";
    let releaseGenerationOne!: () => void;
    let observeGenerationOne!: () => void;
    const generationOneStarted = new Promise<void>((resolve) => {
      observeGenerationOne = resolve;
    });
    const generationOneGate = new Promise<void>((resolve) => {
      releaseGenerationOne = resolve;
    });
    const delivered: string[] = [];
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-inflight-aba",
      store,
      getAuthToken: () => ownerAAuthToken,
      mutation: async (_ref, rawArgs) => {
        const args = rawArgs as { ownerGeneration: string };
        delivered.push(args.ownerGeneration);
        if (args.ownerGeneration === OWNER_A_GENERATION) {
          observeGenerationOne();
          await generationOneGate;
        }
        return { agentId: "thread-inflight-aba" };
      },
      query: async () => null,
    });

    const generationOne = records.create({
      agentId: "thread-inflight-aba",
      conversationId: "conversation-a",
      description: "Generation N",
      agentType: "general",
      attemptGeneration: 1,
      ownerGeneration: OWNER_A_GENERATION,
    });
    await generationOneStarted;
    const generationTwoAdmission = records.create({
      agentId: "thread-inflight-aba",
      conversationId: "conversation-a",
      description: "Generation N+1",
      agentType: "general",
      attemptGeneration: 1,
      ownerGeneration: generationTwo,
    });
    releaseGenerationOne();

    await expect(generationOne).rejects.toMatchObject({
      code: "OWNER_DATA_GENERATION_STALE",
      retryable: false,
    });
    await expect(generationTwoAdmission).resolves.toEqual({
      agentId: "thread-inflight-aba",
    });
    expect(delivered).toEqual([OWNER_A_GENERATION, generationTwo]);
    expect(store.getComputerAgentCloudThreadAuthority("thread-inflight-aba"))
      .toEqual({
        ownerScope: resolveConvexJwtOwnerScope(ownerAAuthToken),
        ownerGeneration: generationTwo,
      });

    records.stop();
    database.close();
  });

  test("rejects a delayed generation N after N+1 without deleting N+1", async () => {
    const { database, store } = createStore();
    const generationTwo = "owner-a-generation-2";
    let calls = 0;
    const records = createComputerAgentCloudRecords({
      convexApi: refs,
      deviceId: "device-reverse-aba",
      store,
      getAuthToken: () => ownerAAuthToken,
      mutation: async () => {
        calls += 1;
        throw new Error("offline");
      },
      query: async () => null,
    });

    await expect(
      records.create({
        agentId: "thread-reverse-aba",
        conversationId: "conversation-a",
        description: "Generation N",
        agentType: "general",
        attemptGeneration: 1,
        ownerGeneration: OWNER_A_GENERATION,
      }),
    ).rejects.toMatchObject({ retryable: true });
    await expect(
      records.create({
        agentId: "thread-reverse-aba",
        conversationId: "conversation-a",
        description: "Generation N+1",
        agentType: "general",
        attemptGeneration: 1,
        ownerGeneration: generationTwo,
      }),
    ).rejects.toMatchObject({ retryable: true });

    await expect(
      records.create({
        agentId: "thread-reverse-aba",
        conversationId: "conversation-a",
        description: "Late generation N",
        agentType: "general",
        attemptGeneration: 2,
        ownerGeneration: OWNER_A_GENERATION,
      }),
    ).rejects.toThrow("OWNER_DATA_GENERATION_STALE");
    await expect(
      records.complete({
        agentId: "thread-reverse-aba",
        attemptGeneration: 2,
        ownerGeneration: OWNER_A_GENERATION,
        status: "completed",
        result: "late",
      }),
    ).rejects.toThrow("OWNER_DATA_GENERATION_STALE");

    const ownerScope = resolveConvexJwtOwnerScope(ownerAAuthToken)!;
    expect(
      store.getComputerAgentCloudThreadAuthority("thread-reverse-aba"),
    ).toEqual({
      ownerScope,
      ownerGeneration: generationTwo,
    });
    expect(store.listComputerAgentCloudOutbox(ownerScope)).toMatchObject([
      { threadId: "thread-reverse-aba", ownerGeneration: generationTwo },
    ]);
    expect(calls).toBe(2);
    records.stop();
    database.close();
  });
});
