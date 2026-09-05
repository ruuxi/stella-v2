import {
  MEMORY_POLICY_APPLY_PATH,
  memoryPoliciesMatch,
  parseMemoryPolicy,
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

export class MemoryPolicyError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}

/**
 * The owner gate receives permission changes before Convex applies them.
 * While a change is pending, provider admission is closed. Acknowledgement
 * follows the DB commit and durable cache replacement. Lost responses leave
 * the exact operation for alarm replay; expiry never silently reopens access.
 */
export class OwnerMemoryPolicy {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly ownerId: string,
    private readonly transport: {
      read(ownerGeneration: string): Promise<MemoryPolicy>;
      apply(change: MemoryPolicyChange): Promise<void>;
    },
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

  async assert(expected: MemoryPolicy, fenceGeneration: string): Promise<void> {
    await this.exclusive(async () => {
      const fence = await this.get<OwnerPurgeFence>("ownerPurgeFence");
      if (fence?.state !== "open" || fence.generation !== fenceGeneration) {
        throw new MemoryPolicyError("OWNER_FENCE_CHANGED");
      }
      const pending = await this.get<PendingChange>(CHANGE_KEY);
      if (pending) {
        if (
          pending.change.expectedOwnerGeneration === expected.ownerGeneration
        ) {
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

export const memoryPolicyTransport = (
  env: { STELLA_CONVEX_SITE_URL?: string; BUILDER_SERVICE_SECRET?: string },
  ownerId: string,
) => {
  const request = async (
    path: string,
    body: unknown,
    applying = false,
  ): Promise<unknown> => {
    if (!env.STELLA_CONVEX_SITE_URL || !env.BUILDER_SERVICE_SECRET) {
      throw new MemoryPolicyError("MEMORY_POLICY_UNCONFIGURED", 503);
    }
    const response = await fetch(
      `${env.STELLA_CONVEX_SITE_URL.replace(/\/+$/, "")}${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.BUILDER_SERVICE_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      if (applying && response.status === 400) {
        const body: unknown = await response.json().catch(() => null);
        const code =
          body &&
          typeof body === "object" &&
          "code" in body &&
          typeof body.code === "string" &&
          /^[A-Z_]{1,100}$/u.test(body.code)
            ? body.code
            : "MEMORY_POLICY_CHANGE_REFUSED";
        throw new MemoryPolicyError(code, 400);
      }
      throw new MemoryPolicyError("MEMORY_POLICY_UNAVAILABLE", 503);
    }
    return await response.json();
  };
  return {
    async read(ownerGeneration: string): Promise<MemoryPolicy> {
      const policy = parseMemoryPolicy(
        await request("/api/cloud/home/memory/preference", {
          ownerId,
          ownerGeneration,
        }),
      );
      if (!policy || policy.ownerGeneration !== ownerGeneration) {
        throw new MemoryPolicyError("MEMORY_POLICY_INVALID", 503);
      }
      return policy;
    },
    async apply(change: MemoryPolicyChange): Promise<void> {
      await request(MEMORY_POLICY_APPLY_PATH, change, true);
    },
  };
};
