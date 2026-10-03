import {
  memoryPoliciesMatch,
  type MemoryPolicy,
  type MemoryPolicyChange,
} from "@stella/contracts/turn-plane/memory-policy";
import type { OwnerPurgeFence } from "./owner-fence-do.js";

const CACHE_KEY = "memoryPolicy:cache:v1";
const CHANGE_KEY = "memoryPolicy:change:v1";
const RETRY_MS = 5_000;
type CachedPolicy = { fenceGeneration: string; policy: MemoryPolicy };
type PendingChange = {
  change: MemoryPolicyChange;
  phase: "applying" | "wiping";
};

export type OwnerMemoryPolicyHooks = {
  /** Closes grant-backed local assertions during owner fence/purge barriers. */
  issuanceOpen?: () => Promise<boolean>;
  /**
   * Called while a policy change is durably pending and before it is applied
   * to the owner's home state. It must durably freeze local reader grants or
   * throw; a throw leaves the pending change closed for alarm retry.
   */
  revokeReaders?: (change: MemoryPolicyChange) => Promise<void>;
};

export class MemoryPolicyError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/**
 * The owner gate's memory permission coordinator. A change is recorded as
 * pending, reader grants are frozen, and only then is it applied to the
 * owner's home state (`transport`). While a change is pending, provider
 * admission is closed. A wipe stays pending until its new epoch opens.
 * Failures leave the exact operation for alarm replay; expiry never silently
 * reopens access.
 */
export class OwnerMemoryPolicy {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly ownerId: string,
    private readonly transport: {
      read(ownerGeneration: string): Promise<MemoryPolicy>;
      apply(change: MemoryPolicyChange): Promise<void>;
    },
    private readonly hooks: OwnerMemoryPolicyHooks = {},
  ) {}

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = await this.ctx.blockConcurrencyWhile(
      async (): Promise<
        { kind: "ok"; value: T } | { kind: "error"; error: unknown }
      > => {
        try {
          return { kind: "ok", value: await work() };
        } catch (error) {
          return { kind: "error", error };
        }
      },
    );
    if (result.kind === "error") throw result.error;
    return result.value;
  }

  private async get<T>(key: string): Promise<T | undefined> {
    return this.ctx.storage.kv
      ? this.ctx.storage.kv.get<T>(key)
      : await this.ctx.storage.get<T>(key);
  }

  private async put(key: string, value: unknown): Promise<void> {
    if (this.ctx.storage.kv) this.ctx.storage.kv.put(key, value);
    else await this.ctx.storage.put(key, value);
  }

  private async remove(key: string): Promise<void> {
    if (this.ctx.storage.kv) this.ctx.storage.kv.delete(key);
    else await this.ctx.storage.delete(key);
  }

  private async arm(): Promise<void> {
    const at = Date.now() + RETRY_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async pending(): Promise<boolean> {
    return (await this.get<PendingChange>(CHANGE_KEY)) !== undefined;
  }

  async invalidate(): Promise<void> {
    await this.remove(CACHE_KEY);
  }

  private async assertCurrent(
    expected: MemoryPolicy,
    fenceGeneration: string,
  ): Promise<void> {
    const fence = await this.get<OwnerPurgeFence>("ownerPurgeFence");
    if (fence?.state !== "open" || fence.generation !== fenceGeneration) {
      throw new MemoryPolicyError("OWNER_FENCE_CHANGED");
    }
    if (this.hooks.issuanceOpen && !(await this.hooks.issuanceOpen())) {
      throw new MemoryPolicyError("OWNER_FENCE_CHANGED");
    }
    const pending = await this.get<PendingChange>(CHANGE_KEY);
    if (pending) {
      if (pending.change.expectedOwnerGeneration === expected.ownerGeneration) {
        throw new MemoryPolicyError("MEMORY_POLICY_CHANGING");
      }
      // The caller's live owner lease proves a new account generation.
      // An old generation's pending operation cannot mutate the new one.
      await this.remove(CHANGE_KEY);
      await this.remove(CACHE_KEY);
    }
    let cached = await this.get<CachedPolicy>(CACHE_KEY);
    if (
      !cached ||
      cached.fenceGeneration !== fenceGeneration ||
      cached.policy.ownerGeneration !== expected.ownerGeneration
    ) {
      const policy = await this.transport.read(expected.ownerGeneration);
      cached = { fenceGeneration, policy };
      await this.put(CACHE_KEY, cached);
    }
    if (!memoryPoliciesMatch(cached.policy, expected)) {
      throw new MemoryPolicyError("MEMORY_POLICY_CHANGED");
    }
  }

  async assert(expected: MemoryPolicy, fenceGeneration: string): Promise<void> {
    await this.exclusive(() => this.assertCurrent(expected, fenceGeneration));
  }

  async authorizeGrant<T>(
    expected: MemoryPolicy,
    fenceGeneration: string,
    issue: () => T | Promise<T>,
  ): Promise<T> {
    return await this.exclusive(async () => {
      await this.assertCurrent(expected, fenceGeneration);
      return await issue();
    });
  }

  async change(change: MemoryPolicyChange): Promise<void> {
    if (change.ownerId !== this.ownerId)
      throw new MemoryPolicyError("OWNER_MISMATCH");
    await this.exclusive(async () => {
      const pending = await this.get<PendingChange>(CHANGE_KEY);
      if (
        pending &&
        JSON.stringify(pending.change) !== JSON.stringify(change)
      ) {
        throw new MemoryPolicyError("MEMORY_POLICY_CHANGE_BUSY");
      }
      if (pending?.phase === "wiping") return;
      const intent: PendingChange = { change, phase: "applying" };
      await this.put(CHANGE_KEY, intent);
      await this.arm();
      await this.finish(intent);
    });
  }

  private async finish(pending: PendingChange): Promise<void> {
    try {
      if (pending.phase === "applying") {
        await this.hooks.revokeReaders?.(pending.change);
        await this.transport.apply(pending.change);
        if (pending.change.kind === "wipe") {
          await this.put(CHANGE_KEY, {
            ...pending,
            phase: "wiping",
          } satisfies PendingChange);
          await this.remove(CACHE_KEY);
          return;
        }
      }
      const policy = await this.transport.read(
        pending.change.expectedOwnerGeneration,
      );
      if (
        pending.change.kind === "wipe" &&
        policy.memoryEpoch === pending.change.expectedMemoryEpoch
      ) {
        throw new MemoryPolicyError("MEMORY_WIPE_PENDING", 503);
      }
      const fence = await this.get<OwnerPurgeFence>("ownerPurgeFence");
      await this.put(CACHE_KEY, {
        fenceGeneration: fence?.generation ?? "",
        policy,
      } satisfies CachedPolicy);
      await this.remove(CHANGE_KEY);
    } catch (error) {
      // A definitive mutation refusal did not change authority. Unknown
      // outcomes retain the intent, and the original request id is retried.
      if (error instanceof MemoryPolicyError && error.status === 400) {
        await this.remove(CHANGE_KEY);
        await this.remove(CACHE_KEY);
      }
      throw error;
    }
  }

  async retry(): Promise<void> {
    await this.exclusive(async () => {
      const pending = await this.get<PendingChange>(CHANGE_KEY);
      if (!pending) return;
      try {
        await this.finish(pending);
      } finally {
        if (await this.pending()) await this.arm();
      }
    });
  }
}
