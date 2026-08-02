/**
 * Per-thread background compaction scheduler.
 *
 * Keeps compaction off the user-visible finalize path. Each thread gets at
 * most one active run and one queued follow-up, which bounds stale history
 * without letting back-to-back turns spawn unbounded summary work.
 *
 * Ownership model (M5 surface 3): this is the keyed fiber executor for
 * compaction — one supervised Effect fiber per active run keyed by
 * `threadKey`, same-key schedules coalesce into the pending slot (never a
 * duplicate run), failures are logged and never block the next schedule,
 * and shutdown interrupts each run's abort signal and joins settlement.
 * Durable SQLite state remains the only truth; fibers are executors.
 */

import { createRuntimeLogger } from "../debug.js";
import { createSupervisedScope } from "../shared/supervised-scope.js";

const logger = createRuntimeLogger("compaction-scheduler");

export type CompactionScheduleArgs = {
  threadKey: string;
  /**
   * Idempotent work; coalescing may drop this callback in favor of a queued
   * one. The signal aborts when the scheduler is shut down mid-run; honoring
   * it keeps shutdown joins bounded (the summarization LLM call is aborted
   * instead of racing SQLite teardown).
   */
  run: (signal?: AbortSignal) => Promise<void>;
  /** Invoked after a successful run; coalesced callbacks all fire in order. */
  onSuccess?: () => void;
};

type QueuedSlot = {
  promise: Promise<void>;
  args: CompactionScheduleArgs;
  onSuccessChain: Array<() => void>;
  resolve: () => void;
};

type ThreadEntry = {
  active: Promise<void>;
  pending?: QueuedSlot;
};

export class BackgroundCompactionScheduler {
  private readonly threads = new Map<string, ThreadEntry>();
  /**
   * Every active run executes under a supervising fiber: shutdown closes the
   * scope, which interrupts each run (aborting its signal) and joins its
   * settlement — runs can no longer outlive the store they write to.
   */
  private readonly supervision = createSupervisedScope("compaction-scheduler");
  private shutdownPromise: Promise<void> | null = null;

  schedule(args: CompactionScheduleArgs): Promise<void> {
    if (this.shutdownPromise) {
      logger.debug("compaction.rejected-after-shutdown", {
        threadKey: args.threadKey,
      });
      return Promise.resolve();
    }
    const existing = this.threads.get(args.threadKey);

    if (!existing) {
      const onSuccessChain: Array<() => void> = args.onSuccess
        ? [args.onSuccess]
        : [];
      const active = this.runActive(args, onSuccessChain);
      this.threads.set(args.threadKey, { active });
      return active;
    }

    if (!existing.pending) {
      const onSuccessChain: Array<() => void> = args.onSuccess
        ? [args.onSuccess]
        : [];
      let resolveOuter: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        resolveOuter = resolve;
      });
      existing.pending = {
        promise,
        args,
        onSuccessChain,
        resolve: resolveOuter,
      };
      logger.debug("compaction.queued-followup", {
        threadKey: args.threadKey,
      });
      return promise;
    }

    if (args.onSuccess) {
      existing.pending.onSuccessChain.push(args.onSuccess);
    }
    logger.debug("compaction.coalesced-into-pending", {
      threadKey: args.threadKey,
      onSuccessChainLength: existing.pending.onSuccessChain.length,
    });
    return existing.pending.promise;
  }

  private runActive(
    args: CompactionScheduleArgs,
    onSuccessChain: Array<() => void>,
  ): Promise<void> {
    const ownThreadKey = args.threadKey;
    const promise = this.executeRun(args, onSuccessChain).finally(() => {
      const entry = this.threads.get(ownThreadKey);
      if (!entry) return;
      if (entry.pending) {
        const nextSlot = entry.pending;
        entry.pending = undefined;
        const nextActive = this.executeRun(
          nextSlot.args,
          nextSlot.onSuccessChain,
        ).finally(() => {
          nextSlot.resolve();
          this.advanceAfter(ownThreadKey, nextActive);
        });
        entry.active = nextActive;
        return;
      }
      this.threads.delete(ownThreadKey);
    });
    return promise;
  }

  private advanceAfter(threadKey: string, currentActive: Promise<void>): void {
    const entry = this.threads.get(threadKey);
    if (!entry || entry.active !== currentActive) return;
    if (entry.pending) {
      const nextSlot = entry.pending;
      entry.pending = undefined;
      const nextActive = this.executeRun(
        nextSlot.args,
        nextSlot.onSuccessChain,
      ).finally(() => {
        nextSlot.resolve();
        this.advanceAfter(threadKey, nextActive);
      });
      entry.active = nextActive;
      return;
    }
    this.threads.delete(threadKey);
  }

  private executeRun(
    args: CompactionScheduleArgs,
    onSuccessChain: Array<() => void>,
  ): Promise<void> {
    // Effect-ratchet pin (1 new AbortController): the genuine seam
    // controller for the supervised compaction run — `supervise` fires it
    // on interrupt/shutdown and the REAL AbortSignal rides into the
    // compaction's LLM calls (plain-TS AbortSignal consumers).
    const controller = new AbortController();
    const settled = this.executeRunInner(args, onSuccessChain, controller);
    this.supervision.supervise({
      label: `compaction:${args.threadKey}`,
      abort: (reason) => controller.abort(reason),
      settled,
    });
    return settled;
  }

  private async executeRunInner(
    args: CompactionScheduleArgs,
    onSuccessChain: Array<() => void>,
    controller: AbortController,
  ): Promise<void> {
    try {
      if (controller.signal.aborted) return;
      await args.run(controller.signal);
      if (controller.signal.aborted) return;
      for (const cb of onSuccessChain) {
        try {
          cb();
        } catch (error) {
          logger.warn("compaction.on-success-failed", {
            threadKey: args.threadKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.warn("compaction.background-failed", {
        threadKey: args.threadKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Currently in-flight compaction for `threadKey`, if any. */
  pending(threadKey: string): Promise<void> | null {
    return this.threads.get(threadKey)?.active ?? null;
  }

  /** Wait for every active and queued compaction to settle before shutdown. */
  async drain(): Promise<void> {
    while (this.threads.size > 0) {
      const promises: Array<Promise<void>> = [];
      for (const entry of this.threads.values()) {
        promises.push(entry.active);
        if (entry.pending) promises.push(entry.pending.promise);
      }
      await Promise.allSettled(promises);
    }
  }

  /**
   * Structured shutdown: stop admitting work, drop queued follow-ups, then
   * interrupt every active run (aborting its signal) and join its
   * settlement. Resolves only once no compaction work is live. Idempotent.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    for (const [threadKey, entry] of this.threads) {
      if (entry.pending) {
        logger.debug("compaction.dropped-queued-on-shutdown", { threadKey });
        entry.pending.resolve();
        entry.pending = undefined;
      }
    }
    this.shutdownPromise = this.supervision
      .close("scheduler-shutdown")
      .then(() => this.drain());
    return this.shutdownPromise;
  }
}
