import type { CloudHomeStore } from "./cloud-home-store.js";
import type { MemoryPolicy } from "@stella/contracts/turn-plane/memory-policy";

export type OwnerHomeContext = {
  revision: number;
  memory: Awaited<ReturnType<CloudHomeStore["getMemoryContext"]>>;
  skills: Awaited<ReturnType<CloudHomeStore["loadSkillCatalog"]>>;
};
const CACHE = "homeContext:cache:v1";
const VERSION = "homeContext:revision:v1:";

/** Content changes invalidate metadata; permission changes are checked locally
 * by the owner policy coordinator, including pending wipes and fence changes. */
export class OwnerHomeContextCache {
  private resident?: OwnerHomeContext;
  constructor(private readonly storage: DurableObjectStorage) {}

  async changed(ownerGeneration: string, revision: number): Promise<void> {
    const key = VERSION + ownerGeneration;
    await this.storage.transaction(async (txn) => {
      const current = (await txn.get<number>(key)) ?? 0;
      if (revision <= current) return;
      await txn.put(key, revision);
      const cached = await txn.get<OwnerHomeContext>(CACHE);
      if (cached?.memory.preference.ownerGeneration === ownerGeneration)
        await txn.delete(CACHE);
    });
    this.resident = undefined;
  }

  async load(args: {
    ownerGeneration: string;
    assertPolicy(policy: MemoryPolicy): Promise<void>;
    fetch(): Promise<Omit<OwnerHomeContext, "revision">>;
  }): Promise<OwnerHomeContext> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision =
        (await this.storage.get<number>(VERSION + args.ownerGeneration)) ?? 0;
      const cached =
        this.resident ?? (await this.storage.get<OwnerHomeContext>(CACHE));
      if (
        cached &&
        cached.revision === revision &&
        cached.memory.preference.ownerGeneration === args.ownerGeneration
      ) {
        try {
          await args.assertPolicy(cached.memory.preference);
          // Policy validation can yield to a notification.
          if (
            ((await this.storage.get<number>(VERSION + args.ownerGeneration)) ??
              0) === revision
          ) {
            this.resident = cached;
            return cached;
          }
        } catch {
          // Reload only on policy/fence change. The fresh policy must pass too.
        }
      }
      const loaded = { ...(await args.fetch()), revision };
      await args.assertPolicy(loaded.memory.preference);
      if (
        ((await this.storage.get<number>(VERSION + args.ownerGeneration)) ??
          0) !== revision
      )
        continue;
      // SQLite KV values are capped at 128 KiB. Oversized catalogs stay resident
      // and refill once after eviction, rather than failing an otherwise valid turn.
      if (
        new TextEncoder().encode(JSON.stringify(loaded)).byteLength < 100_000
      ) {
        await this.storage.put(CACHE, loaded);
      } else await this.storage.delete(CACHE);
      this.resident = loaded;
      return loaded;
    }
    throw new Error(
      "Cloud home context changed repeatedly during preparation.",
    );
  }
}
