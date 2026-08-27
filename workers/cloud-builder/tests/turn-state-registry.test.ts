import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  TURN_STATE_OBJECT_FORMAT,
  TURN_STATE_SCHEMA_VERSION,
  assertTurnStateTransferSourceEmpty,
  commitTurnStateOperation,
  confirmTurnStateRestore,
  drainTurnStateRetirements,
  markTurnStateObjectUploaded,
  prepareTurnStateOperation,
  publishTurnStateWorkspace,
  purgeTurnState,
  resolveTurnState,
  type PreparedTurnStateOperation,
  type StrongTurnStateStorage,
  type TurnStateArchive,
  type TurnStateIdentity,
  type TurnStateNativeCheckpoint,
  type TurnStateObjectStore,
} from "../src/turn-state-registry.js";

const clone = <T>(value: T): T => structuredClone(value);

type StorageListCall = {
  prefix?: string;
  startAfter?: string;
  limit?: number;
};

class FakeStrongStorage implements StrongTurnStateStorage {
  private values: Map<string, unknown>;
  readonly listCalls: StorageListCall[];

  constructor(
    values: Map<string, unknown> = new Map(),
    listCalls: StorageListCall[] = [],
  ) {
    this.values = new Map(
      [...values].map(([key, value]) => [key, clone(value)]),
    );
    this.listCalls = listCalls;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : clone(value as T);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, clone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async list<T = unknown>(
    options: StorageListCall = {},
  ): Promise<Map<string, T>> {
    this.listCalls.push({ ...options });
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    const rows = [...this.values]
      .filter(
        ([key]) =>
          (!options.prefix || key.startsWith(options.prefix)) &&
          (!options.startAfter || key > options.startAfter),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, limit)
      .map(([key, value]) => [key, clone(value as T)] as const);
    return new Map(rows);
  }

  async transaction<T>(
    closure: (transaction: StrongTurnStateStorage) => Promise<T>,
  ): Promise<T> {
    const transaction = new FakeStrongStorage(this.values, this.listCalls);
    const result = await closure(transaction);
    this.values = transaction.values;
    return result;
  }

  setRaw(key: string, value: unknown): void {
    this.values.set(key, clone(value));
  }

  entries(prefix = ""): Map<string, unknown> {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, clone(value)]),
    );
  }
}

type StoredObject = { size: number; etag: string };

class FakeR2 implements TurnStateObjectStore {
  private readonly objects = new Map<string, StoredObject>();
  private readonly deleteFailures = new Map<string, number>();
  readonly listCalls: Array<{ prefix: string; cursor?: string }> = [];
  readonly headCalls: string[] = [];

  constructor(private readonly pageSize = 1_000) {}

  putArchive(archive: TurnStateArchive): void {
    this.objects.set(archive.key, {
      size: archive.sizeBytes,
      etag: archive.etag,
    });
  }

  put(
    key: string,
    value: StoredObject = { size: 1, etag: "orphan-etag" },
  ): void {
    this.objects.set(key, clone(value));
  }

  failNextDeletes(key: string, count = 1): void {
    this.deleteFailures.set(key, count);
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
  }

  async list(
    prefix: string,
    cursor?: string,
  ): Promise<{ keys: string[]; cursor?: string; complete: boolean }> {
    this.listCalls.push({ prefix, ...(cursor ? { cursor } : {}) });
    const remaining = this.keys(prefix).filter(
      (key) => !cursor || key > cursor,
    );
    const keys = remaining.slice(0, this.pageSize);
    const complete = remaining.length <= this.pageSize;
    return {
      keys,
      ...(complete ? {} : { cursor: keys.at(-1)! }),
      complete,
    };
  }

  async delete(key: string): Promise<void> {
    const remainingFailures = this.deleteFailures.get(key) ?? 0;
    if (remainingFailures > 0) {
      if (remainingFailures === 1) this.deleteFailures.delete(key);
      else this.deleteFailures.set(key, remainingFailures - 1);
      throw new Error("injected R2 delete failure");
    }
    this.objects.delete(key);
  }

  async head(key: string): Promise<StoredObject | null> {
    this.headCalls.push(key);
    const value = this.objects.get(key);
    return value ? clone(value) : null;
  }
}

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const identity = (turn: number): TurnStateIdentity => ({
  ownerId: "owner-1",
  ownerGeneration: "owner-generation-1",
  workspace: "drive",
  threadId: "thread-1",
  turnId: `turn-${turn}`,
  attemptGeneration: 1,
});

const nativeCheckpoint = (
  historyCursor: string,
): TurnStateNativeCheckpoint => ({
  engine: "anthropic",
  sessionId: `session-${historyCursor}`,
  cursor: historyCursor,
  tree: {
    algorithm: "sha256",
    digest: digest(`tree:${historyCursor}`),
    entries: 2,
    bytes: 128,
  },
  mac: digest(`mac:${historyCursor}`),
});

const preparationArgs = (
  turn: number,
  options: {
    historyCursor?: string;
    native?: boolean;
    baseWorkspaceRevision?: number;
    threadId?: string;
  } = {},
) => {
  const historyCursor = options.historyCursor ?? `v1:history:${turn}`;
  return {
    identity: {
      ...identity(turn),
      ...(options.threadId ? { threadId: options.threadId } : {}),
    },
    requestFingerprint: digest(`request:${turn}`),
    historyCursor,
    baseWorkspaceRevision: options.baseWorkspaceRevision ?? 0,
    ...(options.native
      ? { nativeCheckpoint: nativeCheckpoint(historyCursor) }
      : {}),
    createdAt: 1_000 + turn,
  };
};

const prepare = async (
  storage: StrongTurnStateStorage,
  turn: number,
  options: {
    historyCursor?: string;
    native?: boolean;
    baseWorkspaceRevision?: number;
    threadId?: string;
  } = {},
): Promise<{
  prepared: PreparedTurnStateOperation;
  args: ReturnType<typeof preparationArgs>;
}> => {
  const args = preparationArgs(turn, options);
  return {
    prepared: await prepareTurnStateOperation(storage, args),
    args,
  };
};

const archive = (
  prepared: PreparedTurnStateOperation,
  kind: "workspace" | "native",
): TurnStateArchive => {
  const key = prepared.objectKeys[kind];
  if (!key) throw new Error(`missing ${kind} object key`);
  return {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    kind,
    format: TURN_STATE_OBJECT_FORMAT,
    key,
    sizeBytes: kind === "workspace" ? 1_024 : 512,
    sha256: digest(`${kind}:${key}`),
    etag: `etag-${kind}-${prepared.operationId}`,
    complete: true,
  };
};

const uploadAndMark = async (
  storage: StrongTurnStateStorage,
  r2: FakeR2,
  prepared: PreparedTurnStateOperation,
  kind: "workspace" | "native",
): Promise<TurnStateArchive> => {
  const descriptor = archive(prepared, kind);
  r2.putArchive(descriptor);
  await markTurnStateObjectUploaded(storage, {
    operationId: prepared.operationId,
    archive: descriptor,
  });
  return descriptor;
};

const resolveIdentity = {
  ownerId: "owner-1",
  ownerGeneration: "owner-generation-1",
  workspace: "drive",
  threadId: "thread-1",
} as const;

describe("strong turn state registry", () => {
  test("prepare is exact-idempotent and conflicts with a changed durable replay", async () => {
    const storage = new FakeStrongStorage();
    const args = preparationArgs(1, { native: true });

    const first = await prepareTurnStateOperation(storage, args);
    const replay = await prepareTurnStateOperation(storage, args);
    expect(replay).toEqual({ ...first, replayed: true });

    await expect(
      prepareTurnStateOperation(storage, {
        ...args,
        createdAt: args.createdAt + 1,
      }),
    ).rejects.toThrow("conflicts with its durable replay");

    const durable = (await storage.get<Record<string, unknown>>(
      `turn-state:v1:operation:${first.operationId}`,
    ))!;
    expect(durable.createdAt).toBe(args.createdAt);
  });

  test("full-prefix purge removes both unmarked and marked upload crashes", async () => {
    const storage = new FakeStrongStorage();
    const r2 = new FakeR2(1);

    const unmarked = (await prepare(storage, 1)).prepared;
    const unmarkedArchive = archive(unmarked, "workspace");
    r2.putArchive(unmarkedArchive);

    const marked = (await prepare(storage, 2)).prepared;
    const markedArchive = await uploadAndMark(storage, r2, marked, "workspace");

    const purged = await purgeTurnState(storage, r2, {
      ownerId: "owner-1",
      workspace: "drive",
      ownerPurgeFence: "blocked",
    });

    expect(purged.pending).toBe(false);
    expect(purged.deleted).toBe(2);
    expect(purged.receipt).toMatch(/^[0-9a-f]{64}$/);
    expect(r2.keys(purged.prefix)).toEqual([]);
    expect(storage.entries("turn-state:v1:object:").size).toBe(0);
    expect(storage.entries("turn-state:v1:operation:").size).toBe(0);
    expect(r2.listCalls.some((call) => call.prefix === purged.prefix)).toBe(
      true,
    );
    expect([unmarkedArchive.key, markedArchive.key].sort()).toEqual(
      [unmarked.objectKeys.workspace, marked.objectKeys.workspace].sort(),
    );
  });

  test("pair commit and canonical promotion survive lost-response retries", async () => {
    const storage = new FakeStrongStorage();
    const r2 = new FakeR2();
    const historyCursor = "v1:history:paired";
    const { prepared } = await prepare(storage, 1, {
      historyCursor,
      native: true,
    });
    const workspace = await uploadAndMark(storage, r2, prepared, "workspace");
    const native = await uploadAndMark(storage, r2, prepared, "native");

    const committed = await commitTurnStateOperation(storage, {
      operationId: prepared.operationId,
    });
    const commitRetry = await commitTurnStateOperation(storage, {
      operationId: prepared.operationId,
    });
    expect(commitRetry).toEqual({
      candidate: committed.candidate,
      workspaceHead: committed.workspaceHead,
      replayed: true,
    });
    const published = await publishTurnStateWorkspace(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: historyCursor,
      operationId: prepared.operationId,
    });
    expect(published.workspaceHead).toEqual(committed.workspaceHead);
    expect(
      await publishTurnStateWorkspace(storage, {
        identity: resolveIdentity,
        canonicalHistoryCursor: historyCursor,
        operationId: prepared.operationId,
      }),
    ).toEqual({ ...published, replayed: true });

    const resolved = await resolveTurnState(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: historyCursor,
      requireNative: true,
    });
    expect(resolved.registryPresent).toBe(true);
    expect(resolved.workspaceConfirmationRequired).toBe(true);
    expect(resolved.workspace?.archive).toEqual(workspace);
    expect(resolved.baseWorkspaceRevision).toBe(1);
    expect(resolved.threadRegistryPresent).toBe(true);
    expect(resolved.confirmationRequired).toBe(true);
    expect(resolved.restore?.workspace).toEqual(workspace);
    expect(resolved.restore?.native).toEqual(native);
    expect(resolved.restore?.nativeCheckpoint?.cursor).toBe(historyCursor);

    const promoted = await confirmTurnStateRestore(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: historyCursor,
      workspaceOperationId: prepared.operationId,
      threadOperationId: prepared.operationId,
      now: 2_000,
    });
    expect(promoted.workspace?.promoted).toBe(true);
    expect(promoted.workspace?.replayed).toBe(false);
    expect(promoted.thread?.promoted).toBe(true);
    expect(promoted.thread?.replayed).toBe(false);
    expect(promoted.confirmationReceipt).toMatch(/^[0-9a-f]{64}$/u);

    const resolveRetry = await resolveTurnState(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: historyCursor,
      requireNative: true,
    });
    expect(resolveRetry).toEqual({
      registryPresent: true,
      workspace: promoted.workspace?.restore,
      workspaceConfirmationRequired: false,
      baseWorkspaceRevision: 1,
      threadRegistryPresent: true,
      restore: promoted.thread?.restore,
      confirmationRequired: false,
    });
    const confirmRetry = await confirmTurnStateRestore(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: historyCursor,
      workspaceOperationId: prepared.operationId,
      threadOperationId: prepared.operationId,
      now: 2_001,
    });
    expect(confirmRetry).toEqual({
      ...promoted,
      workspace: {
        ...promoted.workspace!,
        promoted: false,
        replayed: true,
      },
      thread: {
        ...promoted.thread!,
        promoted: false,
        replayed: true,
      },
    });
  });

  test("one workspace head crosses threads while native continuation remains thread-scoped", async () => {
    const storage = new FakeStrongStorage();
    const r2 = new FakeR2();
    const threadA = "thread-a";
    const threadB = "thread-b";
    const cursorA = "v1:history:thread-a";
    const cursorB = "v1:history:thread-b";
    const identityA = { ...resolveIdentity, threadId: threadA };
    const identityB = { ...resolveIdentity, threadId: threadB };

    const firstA = (
      await prepare(storage, 1, {
        threadId: threadA,
        historyCursor: cursorA,
        native: true,
      })
    ).prepared;
    const workspaceA = await uploadAndMark(storage, r2, firstA, "workspace");
    const nativeA = await uploadAndMark(storage, r2, firstA, "native");
    await commitTurnStateOperation(storage, { operationId: firstA.operationId });

    const blockedBRestore = await resolveTurnState(storage, {
      identity: identityB,
      canonicalHistoryCursor: "v1:empty",
      requireNative: false,
    });
    expect(blockedBRestore.workspace).toBeUndefined();
    expect(blockedBRestore.workspacePublication).toEqual({
      operationId: firstA.operationId,
      publishable: false,
    });
    await publishTurnStateWorkspace(storage, {
      identity: identityA,
      canonicalHistoryCursor: cursorA,
      operationId: firstA.operationId,
    });

    const firstBRestore = await resolveTurnState(storage, {
      identity: identityB,
      canonicalHistoryCursor: "v1:empty",
      requireNative: false,
    });
    expect(firstBRestore.threadRegistryPresent).toBe(false);
    expect(firstBRestore.workspace?.archive).toEqual(workspaceA);
    expect(firstBRestore.restore).toBeUndefined();
    await confirmTurnStateRestore(storage, {
      identity: identityB,
      canonicalHistoryCursor: "v1:empty",
      workspaceOperationId: firstA.operationId,
      now: 2_000,
    });

    const firstB = (
      await prepare(storage, 2, {
        threadId: threadB,
        historyCursor: cursorB,
        native: true,
        baseWorkspaceRevision: 1,
      })
    ).prepared;
    const workspaceB = await uploadAndMark(storage, r2, firstB, "workspace");
    const nativeB = await uploadAndMark(storage, r2, firstB, "native");
    await commitTurnStateOperation(storage, { operationId: firstB.operationId });
    await publishTurnStateWorkspace(storage, {
      identity: identityB,
      canonicalHistoryCursor: cursorB,
      operationId: firstB.operationId,
    });

    const continuationA = await resolveTurnState(storage, {
      identity: identityA,
      canonicalHistoryCursor: cursorA,
      requireNative: true,
    });
    expect(continuationA.workspace?.archive).toEqual(workspaceB);
    expect(continuationA.workspace?.operationId).toBe(firstB.operationId);
    expect(continuationA.restore?.native).toEqual(nativeA);
    expect(continuationA.restore?.workspace).toEqual(workspaceA);
    expect(continuationA.restore?.native).not.toEqual(nativeB);
    await confirmTurnStateRestore(storage, {
      identity: identityA,
      canonicalHistoryCursor: cursorA,
      workspaceOperationId: firstB.operationId,
      threadOperationId: firstA.operationId,
      now: 3_000,
    });

    expect(
      (
        await storage.get<Record<string, unknown>>(
          `turn-state:v1:object:${workspaceA.key}`,
        )
      )?.state,
    ).toBe("retiring");
    expect(
      (
        await storage.get<Record<string, unknown>>(
          `turn-state:v1:object:${workspaceB.key}`,
        )
      )?.state,
    ).toBe("referenced");
    expect(
      (
        await storage.get<Record<string, unknown>>(
          `turn-state:v1:object:${nativeA.key}`,
        )
      )?.state,
    ).toBe("referenced");

    await expect(
      prepare(storage, 3, {
        threadId: threadA,
        historyCursor: "v1:history:stale-base",
        baseWorkspaceRevision: 1,
      }),
    ).rejects.toThrow("workspace base revision is stale");
  });

  test("a new canonical cursor promotes its pair and retires the mismatched committed pair", async () => {
    const storage = new FakeStrongStorage();
    const r2 = new FakeR2();
    const firstCursor = "v1:history:first";
    const secondCursor = "v1:history:second";

    const first = (
      await prepare(storage, 1, { historyCursor: firstCursor, native: true })
    ).prepared;
    const firstWorkspace = await uploadAndMark(storage, r2, first, "workspace");
    await uploadAndMark(storage, r2, first, "native");
    await commitTurnStateOperation(storage, { operationId: first.operationId });
    await publishTurnStateWorkspace(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: firstCursor,
      operationId: first.operationId,
    });
    await resolveTurnState(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: firstCursor,
      requireNative: true,
    });
    await confirmTurnStateRestore(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: firstCursor,
      workspaceOperationId: first.operationId,
      threadOperationId: first.operationId,
      now: 2_000,
    });

    const second = (
      await prepare(storage, 2, {
        historyCursor: secondCursor,
        native: true,
        baseWorkspaceRevision: 1,
      })
    ).prepared;
    await uploadAndMark(storage, r2, second, "workspace");
    await uploadAndMark(storage, r2, second, "native");
    await commitTurnStateOperation(storage, {
      operationId: second.operationId,
    });
    await publishTurnStateWorkspace(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: secondCursor,
      operationId: second.operationId,
    });

    const resolved = await resolveTurnState(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: secondCursor,
      requireNative: true,
    });
    expect(resolved.registryPresent).toBe(true);
    expect(resolved.workspaceConfirmationRequired).toBe(true);
    expect(resolved.workspace?.operationId).toBe(second.operationId);
    expect(resolved.confirmationRequired).toBe(true);
    expect(resolved.restore?.operationId).toBe(second.operationId);

    // Merely probing the candidate must not retire the last proven recovery.
    expect(
      await storage.get(`turn-state:v1:retirement:${first.operationId}`),
    ).toBeUndefined();
    expect(
      (
        await storage.get<Record<string, unknown>>(
          `turn-state:v1:object:${firstWorkspace.key}`,
        )
      )?.state,
    ).toBe("referenced");

    const confirmed = await confirmTurnStateRestore(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: secondCursor,
      workspaceOperationId: second.operationId,
      threadOperationId: second.operationId,
      now: 3_000,
    });
    expect(confirmed.workspace?.promoted).toBe(true);
    expect(confirmed.thread?.promoted).toBe(true);

    const retirement = await storage.get<Record<string, unknown>>(
      `turn-state:v1:retirement:${first.operationId}`,
    );
    expect(retirement?.objectKeys).toEqual([
      first.objectKeys.workspace,
      first.objectKeys.native,
    ]);
    expect(
      (
        await storage.get<Record<string, unknown>>(
          `turn-state:v1:object:${firstWorkspace.key}`,
        )
      )?.state,
    ).toBe("retiring");
    expect(
      (
        await storage.get<Record<string, unknown>>(
          `turn-state:v1:object:${second.objectKeys.workspace}`,
        )
      )?.state,
    ).toBe("referenced");

    r2.failNextDeletes(firstWorkspace.key);
    const firstDrain = await drainTurnStateRetirements(storage, r2, {
      ownerId: "owner-1",
      ownerGeneration: "owner-generation-1",
      workspace: "drive",
    });
    expect(firstDrain.pending).toBe(true);
    expect(
      storage.entries("turn-state:v1:retirement:").size,
    ).toBe(1);

    const retryDrain = await drainTurnStateRetirements(storage, r2, {
      ownerId: "owner-1",
      ownerGeneration: "owner-generation-1",
      workspace: "drive",
    });
    expect(retryDrain.pending).toBe(false);
    expect(retryDrain.completed).toBe(1);
    expect(r2.headCalls).toContain(first.objectKeys.workspace);
    expect(r2.headCalls).toContain(first.objectKeys.native!);
    expect(r2.keys().some((key) => key.includes(first.operationId))).toBe(
      false,
    );
    expect(storage.entries("turn-state:v1:retirement:").size).toBe(0);
    expect(
      storage.entries("turn-state:v1:operation:").has(
        `turn-state:v1:operation:${first.operationId}`,
      ),
    ).toBe(false);

    // If the successful drain response is lost, an exact retry observes both
    // bytes and metadata already absent and remains successful.
    expect(
      await drainTurnStateRetirements(storage, r2, {
        ownerId: "owner-1",
        ownerGeneration: "owner-generation-1",
        workspace: "drive",
      }),
    ).toEqual({ pending: false, deleted: 0, completed: 0 });
  });

  test("owner generation drift cannot commit or resolve another generation's thread", async () => {
    const storage = new FakeStrongStorage();
    const r2 = new FakeR2();
    const firstCursor = "v1:history:generation-one";
    const first = (
      await prepare(storage, 1, { historyCursor: firstCursor })
    ).prepared;
    await uploadAndMark(storage, r2, first, "workspace");
    await commitTurnStateOperation(storage, { operationId: first.operationId });
    await publishTurnStateWorkspace(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: firstCursor,
      operationId: first.operationId,
    });
    await resolveTurnState(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: firstCursor,
      requireNative: false,
    });
    await confirmTurnStateRestore(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: firstCursor,
      workspaceOperationId: first.operationId,
      threadOperationId: first.operationId,
      now: 2_000,
    });

    await expect(
      resolveTurnState(storage, {
        identity: {
          ...resolveIdentity,
          ownerGeneration: "owner-generation-2",
        },
        canonicalHistoryCursor: firstCursor,
        requireNative: false,
      }),
    ).rejects.toThrow("owner mismatch");

    await expect(
      confirmTurnStateRestore(storage, {
        identity: {
          ...resolveIdentity,
          ownerGeneration: "owner-generation-2",
        },
        canonicalHistoryCursor: firstCursor,
        workspaceOperationId: first.operationId,
        threadOperationId: first.operationId,
        now: 2_001,
      }),
    ).rejects.toThrow("owner mismatch");

    const nextArgs = preparationArgs(2, {
      historyCursor: "v1:history:generation-two",
      baseWorkspaceRevision: 1,
    });
    const second = await prepareTurnStateOperation(storage, nextArgs);
    await uploadAndMark(storage, r2, second, "workspace");
    const workspaceRecordKey = `turn-state:v1:workspace:${digest("drive")}`;
    storage.setRaw(workspaceRecordKey, {
      ...(await storage.get<Record<string, unknown>>(workspaceRecordKey)),
      ownerGeneration: "owner-generation-2",
    });
    await expect(
      commitTurnStateOperation(storage, { operationId: second.operationId }),
    ).rejects.toThrow("workspace owner generation is stale");
  });

  test("native-required resolution fails closed when only workspace state exists", async () => {
    const storage = new FakeStrongStorage();
    const r2 = new FakeR2();
    const historyCursor = "v1:history:workspace-only";
    const { prepared } = await prepare(storage, 1, { historyCursor });
    await uploadAndMark(storage, r2, prepared, "workspace");
    await commitTurnStateOperation(storage, {
      operationId: prepared.operationId,
    });
    await publishTurnStateWorkspace(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: historyCursor,
      operationId: prepared.operationId,
    });

    await expect(
      resolveTurnState(storage, {
        identity: resolveIdentity,
        canonicalHistoryCursor: historyCursor,
        requireNative: true,
      }),
    ).rejects.toThrow("Canonical native turn state is missing");

    expect(storage.entries("turn-state:v1:retirement:").size).toBe(0);
    expect(
      (
        await storage.get<Record<string, unknown>>(
          `turn-state:v1:object:${prepared.objectKeys.workspace}`,
        )
      )?.state,
    ).toBe("referenced");
  });

  test("resolution distinguishes an unseeded registry from a canonical cursor mismatch without retiring recovery", async () => {
    const empty = new FakeStrongStorage();
    expect(
      await resolveTurnState(empty, {
        identity: resolveIdentity,
        canonicalHistoryCursor: "v1:history:not-seeded",
        requireNative: true,
      }),
    ).toEqual({
      registryPresent: false,
      workspaceConfirmationRequired: false,
      baseWorkspaceRevision: 0,
      threadRegistryPresent: false,
      confirmationRequired: false,
    });

    const storage = new FakeStrongStorage();
    const r2 = new FakeR2();
    const committedCursor = "v1:history:committed";
    const committed = (
      await prepare(storage, 1, {
        historyCursor: committedCursor,
        native: true,
      })
    ).prepared;
    await uploadAndMark(storage, r2, committed, "workspace");
    await uploadAndMark(storage, r2, committed, "native");
    await commitTurnStateOperation(storage, { operationId: committed.operationId });
    await publishTurnStateWorkspace(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: committedCursor,
      operationId: committed.operationId,
    });
    await confirmTurnStateRestore(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: committedCursor,
      workspaceOperationId: committed.operationId,
      threadOperationId: committed.operationId,
      now: 2_000,
    });

    const candidate = (
      await prepare(storage, 2, {
        historyCursor: "v1:history:candidate",
        native: true,
        baseWorkspaceRevision: 1,
      })
    ).prepared;
    await uploadAndMark(storage, r2, candidate, "workspace");
    await uploadAndMark(storage, r2, candidate, "native");
    await commitTurnStateOperation(storage, { operationId: candidate.operationId });
    await publishTurnStateWorkspace(storage, {
      identity: resolveIdentity,
      canonicalHistoryCursor: "v1:history:candidate",
      operationId: candidate.operationId,
    });

    expect(
      await resolveTurnState(storage, {
        identity: resolveIdentity,
        canonicalHistoryCursor: "v1:history:unknown",
        requireNative: true,
      }),
    ).toMatchObject({
      registryPresent: true,
      workspaceConfirmationRequired: true,
      baseWorkspaceRevision: 2,
      threadRegistryPresent: true,
      confirmationRequired: false,
    });
    expect(storage.entries("turn-state:v1:retirement:").size).toBe(0);
    expect(
      (
        await storage.get<Record<string, unknown>>(
          `turn-state:v1:object:${committed.objectKeys.workspace}`,
        )
      )?.state,
    ).toBe("referenced");
    expect(
      (
        await storage.get<Record<string, unknown>>(
          `turn-state:v1:object:${candidate.objectKeys.workspace}`,
        )
      )?.state,
    ).toBe("referenced");
  });

  test("purge failure remains pending and a retry completes bytes-first cleanup", async () => {
    const storage = new FakeStrongStorage();
    const r2 = new FakeR2();
    const { prepared } = await prepare(storage, 1);
    const workspace = await uploadAndMark(storage, r2, prepared, "workspace");
    await commitTurnStateOperation(storage, {
      operationId: prepared.operationId,
    });
    r2.failNextDeletes(workspace.key);

    const first = await purgeTurnState(storage, r2, {
      ownerId: "owner-1",
      workspace: "drive",
      ownerPurgeFence: "blocked",
    });
    expect(first).toEqual({
      pending: true,
      deleted: 0,
      prefix: first.prefix,
    });
    expect(r2.keys(first.prefix)).toEqual([workspace.key]);
    expect(
      (
        await storage.get<Record<string, unknown>>(
          `turn-state:v1:object:${workspace.key}`,
        )
      )?.state,
    ).toBe("retiring");

    const retry = await purgeTurnState(storage, r2, {
      ownerId: "owner-1",
      workspace: "drive",
      ownerPurgeFence: "blocked",
    });
    expect(retry.pending).toBe(false);
    expect(retry.deleted).toBe(1);
    expect(retry.receipt).toMatch(/^[0-9a-f]{64}$/);
    expect(r2.keys(retry.prefix)).toEqual([]);
    expect(storage.entries("turn-state:v1:object:").size).toBe(0);
  });

  test("transfer source proof requires both registry records and the full prefix to be empty", async () => {
    const storage = new FakeStrongStorage();
    const r2 = new FakeR2(1);
    await prepare(storage, 1);

    await expect(
      assertTurnStateTransferSourceEmpty(storage, r2, {
        ownerId: "owner-1",
        workspace: "drive",
      }),
    ).rejects.toThrow("Turn state transfer source is not empty");

    const registryPurge = await purgeTurnState(storage, r2, {
      ownerId: "owner-1",
      workspace: "drive",
      ownerPurgeFence: "blocked",
    });
    expect(registryPurge.pending).toBe(false);

    const orphanKey = `${registryPurge.prefix}orphan-after-upload.sqsh`;
    r2.put(orphanKey);
    await expect(
      assertTurnStateTransferSourceEmpty(storage, r2, {
        ownerId: "owner-1",
        workspace: "drive",
      }),
    ).rejects.toThrow("bytes are not empty");

    const bytesPurge = await purgeTurnState(storage, r2, {
      ownerId: "owner-1",
      workspace: "drive",
      ownerPurgeFence: "blocked",
    });
    expect(bytesPurge.pending).toBe(false);
    expect(bytesPurge.deleted).toBe(1);

    const receipt = await assertTurnStateTransferSourceEmpty(storage, r2, {
      ownerId: "owner-1",
      workspace: "drive",
    });
    expect(receipt).toMatch(/^[0-9a-f]{64}$/);
  });

  test("purge paginates through complete strong-registry and R2 prefixes", async () => {
    const storage = new FakeStrongStorage();
    const r2 = new FakeR2(11);
    const count = 130;
    for (let turn = 1; turn <= count; turn += 1) {
      const { prepared } = await prepare(storage, turn);
      r2.putArchive(archive(prepared, "workspace"));
    }

    const purged = await purgeTurnState(storage, r2, {
      ownerId: "owner-1",
      workspace: "drive",
      ownerPurgeFence: "blocked",
    });

    expect(purged.pending).toBe(false);
    expect(purged.deleted).toBe(count);
    expect(r2.keys(purged.prefix)).toEqual([]);
    expect(
      storage.listCalls.filter(
        (call) => call.prefix === "turn-state:v1:object:",
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      storage.listCalls.some(
        (call) =>
          call.prefix === "turn-state:v1:object:" &&
          typeof call.startAfter === "string",
      ),
    ).toBe(true);
    expect(
      r2.listCalls.filter((call) => call.prefix === purged.prefix).length,
    ).toBeGreaterThan(11);
  });
});
