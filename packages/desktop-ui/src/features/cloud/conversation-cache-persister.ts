import type { JournalRecord } from "@stella/contracts/conversation-protocol";
import type {
  CloudConversationCacheAuthority,
  CloudConversationCacheVersion,
} from "@stella/contracts/cloud-conversation-cache";
import { cloudCacheDelta } from "./cloud-cache-delta";
import {
  cloudConversationCacheClient,
  type RenderableCloudConversationCacheSnapshot,
} from "./cloud-conversation-cache-client";

/** The canonical view a write persists, read when the write actually runs. */
export type ConversationCacheSnapshot = {
  epoch: number;
  headSeq: number;
  floorSeq: number;
  title: string;
  records: readonly JournalRecord[];
};

/**
 * Longest a pending write waits for an idle frame. A streaming turn can keep
 * the renderer busy for a long time; the cache is disposable, so a write that
 * lands a second late is fine, but it must eventually land.
 */
const CACHE_WRITE_IDLE_TIMEOUT_MS = 1_000;

const cacheVersionsEqual = (
  left: CloudConversationCacheVersion | null,
  right: CloudConversationCacheVersion | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.epoch === right.epoch &&
    left.headSeq === right.headSeq &&
    left.floorSeq === right.floorSeq &&
    left.revision === right.revision);

const versionOf = (
  snapshot: RenderableCloudConversationCacheSnapshot | null,
): CloudConversationCacheVersion | null =>
  snapshot
    ? {
        epoch: snapshot.epoch,
        headSeq: snapshot.headSeq,
        floorSeq: snapshot.floorSeq,
        revision: snapshot.revision,
      }
    : null;

/**
 * Runs `callback` when the renderer is idle, or after the timeout when it never
 * is. Returns a cancel function.
 */
const whenIdle = (callback: () => void): (() => void) => {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(callback, {
      timeout: CACHE_WRITE_IDLE_TIMEOUT_MS,
    });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(callback, CACHE_WRITE_IDLE_TIMEOUT_MS);
  return () => clearTimeout(handle);
};

/**
 * Writes one conversation's canonical view to the desktop's disposable SQLite
 * replica, off the hot path.
 *
 * Diffing the retained window against the last write is linear in the window,
 * so it never runs per frame: a write is scheduled for the next idle period
 * and reads the view only when it runs, which collapses a streaming burst into
 * one write. Every write is fenced by a generation the store bumps on purge or
 * retirement, and by the main process's compare-and-set version.
 */
export class ConversationCachePersister {
  private readonly authority: CloudConversationCacheAuthority;
  /** False once this store's account generation is no longer the active one. */
  private readonly isCurrent: () => boolean;
  /** The view to persist; null when it is not a complete canonical suffix. */
  private readonly snapshot: () => ConversationCacheSnapshot | null;
  private version: CloudConversationCacheVersion | null = null;
  private persistedRecords: readonly JournalRecord[] = [];
  private operationGeneration = 0;
  private cancelScheduled: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: {
    authority: CloudConversationCacheAuthority;
    isCurrent: () => boolean;
    snapshot: () => ConversationCacheSnapshot | null;
  }) {
    this.authority = Object.freeze({ ...options.authority });
    this.isCurrent = options.isCurrent;
    this.snapshot = options.snapshot;
  }

  /** Bumped by every purge or retirement; a read started before is stale. */
  get generation(): number {
    return this.operationGeneration;
  }

  read(): Promise<RenderableCloudConversationCacheSnapshot | null> {
    return cloudConversationCacheClient.read(this.authority);
  }

  /** Adopts the CAS token of what is on disk, as the last read saw it. */
  observe(cached: RenderableCloudConversationCacheSnapshot | null): void {
    this.version = versionOf(cached);
  }

  /** Persists the view at the next idle period. Repeat calls coalesce. */
  schedule(): void {
    if (this.cancelScheduled) return;
    const generation = this.operationGeneration;
    this.cancelScheduled = whenIdle(() => {
      this.cancelScheduled = null;
      this.chain = this.chain.then(() => this.persist(generation));
    });
  }

  /** Drops pending writes and forgets the persisted view, leaving the disk. */
  retire(): void {
    this.operationGeneration += 1;
    this.cancelPending();
    this.version = null;
    this.persistedRecords = [];
  }

  /** Drops pending writes and deletes the conversation's replica. */
  purge(): void {
    this.retire();
    const authority = this.authority;
    this.chain = this.chain.then(async () => {
      await cloudConversationCacheClient.purgeConversation(authority);
    });
  }

  private cancelPending(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
  }

  private async persist(generation: number): Promise<void> {
    if (generation !== this.operationGeneration || !this.isCurrent()) return;
    const view = this.snapshot();
    if (!view) return;
    const records = [...view.records];
    const tail = records.at(-1)?.seq ?? -1;
    // `ready` can name a head before all replay frames arrive. Persist only a
    // complete suffix so a crash can never turn an in-flight hole into cache.
    if (tail !== view.headSeq) return;
    let expected = this.version;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await cloudConversationCacheClient.replace({
        ...this.authority,
        expected,
        epoch: view.epoch,
        headSeq: view.headSeq,
        floorSeq: view.floorSeq,
        title: view.title,
        ...(expected?.epoch === view.epoch
          ? cloudCacheDelta(this.persistedRecords, records)
          : { records }),
      });
      if (generation !== this.operationGeneration || !this.isCurrent()) {
        return;
      }
      if (result.status === "applied") {
        this.version = result.version;
        this.persistedRecords = records;
        return;
      }
      if (result.status === "inactive") {
        const reactivated =
          await cloudConversationCacheClient.activateAuthority({
            accountScope: this.authority.accountScope,
            ownerGeneration: this.authority.ownerGeneration,
          });
        if (!reactivated || !this.isCurrent()) return;
        const currentVersion = versionOf(await this.read());
        // Main-process restart may forget only the in-memory active authority.
        // Reuse the on-disk CAS token only when it is still the exact token this
        // writer had already observed. Cache loss (null) is also rebuildable.
        if (
          currentVersion !== null &&
          !cacheVersionsEqual(currentVersion, expected)
        ) {
          return;
        }
        expected = currentVersion;
        this.version = currentVersion;
        continue;
      }
      // A null conflict means the disposable file/window vanished between our
      // read and write, so one null-CAS rebuild is safe. A non-null conflict is
      // another writer's exact epoch/head/floor/revision fence; adopting that
      // token would let a stale pre-reset epoch overwrite its successor.
      if (result.current !== null) return;
      this.version = null;
      this.persistedRecords = [];
      expected = null;
    }
  }
}
