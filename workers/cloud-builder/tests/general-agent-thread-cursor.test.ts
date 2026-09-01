import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { requiresExactThreadCandidate } from "../src/general-agent-turn.js";
import {
  commitTurnStateOperation,
  markTurnStateObjectUploaded,
  prepareTurnStateOperation,
  resolveTurnState,
  TURN_STATE_OBJECT_FORMAT,
  TURN_STATE_SCHEMA_VERSION,
  type StrongTurnStateStorage,
} from "../src/turn-state-registry.js";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

class MemoryStorage implements StrongTurnStateStorage {
  private values = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async list<T = unknown>(
    options: { prefix?: string; startAfter?: string; limit?: number } = {},
  ): Promise<Map<string, T>> {
    const rows = [...this.values]
      .filter(
        ([key]) =>
          (!options.prefix || key.startsWith(options.prefix)) &&
          (!options.startAfter || key > options.startAfter),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER)
      .map(([key, value]) => [key, structuredClone(value) as T] as const);
    return new Map(rows);
  }

  async transaction<T>(
    closure: (transaction: StrongTurnStateStorage) => Promise<T>,
  ): Promise<T> {
    return await closure(this);
  }

  size(): number {
    return this.values.size;
  }
}

const IDENTITY = {
  ownerId: "owner-1",
  ownerGeneration: "owner-generation-1",
  threadId: "thread-1",
} as const;

const execution = (
  engine: CloudExecutionSelection["engine"],
): CloudExecutionSelection =>
  ({
    engine,
    provider: engine === "stella" ? "anthropic" : engine,
    model: `${engine}/model`,
    reasoningEffort: "default",
  }) as CloudExecutionSelection;

/**
 * One checkpointed turn, which is what puts a thread record in the registry.
 * Every later chat-only turn resolves against it with a cursor it never saw.
 */
const seedCheckpointedTurn = async (
  storage: MemoryStorage,
  historyCursor: string,
): Promise<void> => {
  const prepared = await prepareTurnStateOperation(storage, {
    identity: { ...IDENTITY, turnId: "turn-0", attemptGeneration: 1 },
    requestFingerprint: digest("request:0"),
    historyCursor,
    baseWorkspaceRevision: 0,
    createdAt: 1_000,
  });
  const key = prepared.objectKeys.workspace;
  if (!key) throw new Error("the prepared operation has no workspace object");
  await markTurnStateObjectUploaded(storage, {
    operationId: prepared.operationId,
    archive: {
      schemaVersion: TURN_STATE_SCHEMA_VERSION,
      kind: "workspace",
      format: TURN_STATE_OBJECT_FORMAT,
      key,
      sizeBytes: 1_024,
      sha256: digest(`workspace:${key}`),
      etag: `etag-${prepared.operationId}`,
      complete: true,
    },
  });
  await commitTurnStateOperation(storage, {
    operationId: prepared.operationId,
  });
};

/**
 * The exact gate `runAgentTurn` applies before a turn is allowed to start,
 * restated over the resolver's own answer so the matrix below binds to
 * `resolveTurnState` rather than to a hand-written stand-in for it.
 */
const bricked = (
  resolved: { threadRegistryPresent: boolean; restore?: unknown },
  selection: CloudExecutionSelection,
): boolean =>
  resolved.threadRegistryPresent &&
  !resolved.restore &&
  requiresExactThreadCandidate(selection);

describe("thread candidate requirement", () => {
  test("only Claude restores from its thread candidate", () => {
    expect(requiresExactThreadCandidate(execution("stella"))).toBe(false);
    expect(requiresExactThreadCandidate(execution("anthropic"))).toBe(true);
    expect(requiresExactThreadCandidate(execution("openai-codex"))).toBe(false);
    expect(requiresExactThreadCandidate(undefined)).toBe(true);
  });

  test("a stella turn continues cold when no candidate matches its cursor", async () => {
    const storage = new MemoryStorage();
    await seedCheckpointedTurn(storage, "v1:history:0");

    const resolved = await resolveTurnState(storage, {
      identity: IDENTITY,
      canonicalHistoryCursor: "v1:history:1",
      requireNative: false,
    });

    expect(resolved.threadRegistryPresent).toBe(true);
    expect(resolved.restore).toBeUndefined();
    expect(bricked(resolved, execution("stella"))).toBe(false);
  });

  test("an anthropic turn still refuses a registry with no matching candidate", async () => {
    const storage = new MemoryStorage();
    await seedCheckpointedTurn(storage, "v1:history:0");

    const resolved = await resolveTurnState(storage, {
      identity: IDENTITY,
      canonicalHistoryCursor: "v1:history:1",
      requireNative: false,
    });

    expect(bricked(resolved, execution("anthropic"))).toBe(true);
  });

  test("both engines still restore from the candidate that does match", async () => {
    const storage = new MemoryStorage();
    await seedCheckpointedTurn(storage, "v1:history:0");

    const resolved = await resolveTurnState(storage, {
      identity: IDENTITY,
      canonicalHistoryCursor: "v1:history:0",
      requireNative: false,
    });

    expect(resolved.restore).toBeDefined();
    expect(bricked(resolved, execution("stella"))).toBe(false);
    expect(bricked(resolved, execution("anthropic"))).toBe(false);
  });

  test("twelve consecutive chat-only stella turns neither brick nor accumulate state", async () => {
    const storage = new MemoryStorage();
    await seedCheckpointedTurn(storage, "v1:history:0");
    const afterSeed = storage.size();

    for (let turn = 1; turn <= 12; turn += 1) {
      const resolved = await resolveTurnState(storage, {
        identity: IDENTITY,
        // A chat-only turn writes no checkpoint and still appends transcript
        // rows, so every turn arrives with a cursor the registry has never
        // seen. That is the condition the old gate treated as a broken thread.
        canonicalHistoryCursor: `v1:history:${turn}`,
        requireNative: false,
      });
      expect(resolved.threadRegistryPresent).toBe(true);
      expect(resolved.restore).toBeUndefined();
      expect(bricked(resolved, execution("stella"))).toBe(false);
      expect(bricked(resolved, execution("anthropic"))).toBe(true);
    }

    expect(storage.size()).toBe(afterSeed);
  });
});
