import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type {
  ManagedDispatchGuard,
  ManagedDispatchOutcome,
} from "../runtime_ai/managed";

export type RemoteTurnAttemptSource =
  | "desktop"
  | "fast_rescue"
  | "orphan_watchdog"
  | "cron_watchdog";

const ATTEMPT_HEARTBEAT_MS = 20_000;

type RemoteTurnAttemptTuple = {
  requestId: string;
  conversationId: Id<"conversations">;
  ownerId: string;
  ownerGeneration: string;
  attemptId: string;
  source: RemoteTurnAttemptSource;
  deviceId?: string;
};

export type RemoteTurnAttemptGuard = RemoteTurnAttemptTuple & {
  hardExpiresAt: number;
  signal: AbortSignal;
  modelDispatchGuard: ManagedDispatchGuard;
  assertActive: () => Promise<boolean>;
  finish: (outcome: ManagedDispatchOutcome) => Promise<void>;
};

const abortError = (message: string): Error => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw abortError("Remote-turn attempt was aborted.");
};

/**
 * Reserve one durable remote execution attempt and keep its local work joined
 * to the exact DB tuple. The stable signal spans the full tool loop; each
 * physical provider try receives its own shorter DB-backed lease.
 */
export const acquireRemoteTurnAttemptGuard = async (
  ctx: Pick<ActionCtx, "runMutation">,
  args: Omit<RemoteTurnAttemptTuple, "attemptId"> & { attemptId?: string },
): Promise<RemoteTurnAttemptGuard | null> => {
  const attemptId = args.attemptId ?? crypto.randomUUID();
  const tuple: RemoteTurnAttemptTuple = { ...args, attemptId };
  const reserved: {
    acquired: boolean;
    leaseExpiresAt: number;
    hardExpiresAt: number;
  } = await ctx.runMutation(
    internal.channels.connector_delivery.acquireRemoteTurnAttemptInternal,
    { ...tuple, now: Date.now() },
  );
  if (!reserved.acquired) return null;

  const controller = new AbortController();
  let finished = false;
  let wakeMonitor: (() => void) | undefined;
  let leaseExpiresAt = reserved.leaseExpiresAt;
  const hardExpiresAt = reserved.hardExpiresAt;
  let authorityTimer: ReturnType<typeof setTimeout> | undefined;
  const armAuthorityTimer = () => {
    if (authorityTimer) clearTimeout(authorityTimer);
    const deadlineAt = Math.min(leaseExpiresAt, hardExpiresAt);
    authorityTimer = setTimeout(
      () =>
        controller.abort(
          abortError("Remote-turn lease or hard deadline expired."),
        ),
      Math.max(1, deadlineAt - Date.now()),
    );
  };
  armAuthorityTimer();

  const withinAuthority = async <T>(operation: Promise<T>): Promise<T> => {
    throwIfAborted(controller.signal);
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        const onAbort = () => {
          controller.signal.removeEventListener("abort", onAbort);
          reject(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : abortError("Remote-turn authority expired."),
          );
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        void operation.then(
          () => controller.signal.removeEventListener("abort", onAbort),
          () => controller.signal.removeEventListener("abort", onAbort),
        );
      }),
    ]);
  };

  const pulse = async (): Promise<boolean> => {
    if (finished || controller.signal.aborted) return false;
    const result: {
      allowed: boolean;
      leaseExpiresAt: number | null;
      hardExpiresAt: number | null;
    } | null = await withinAuthority(
      ctx.runMutation(
        internal.channels.connector_delivery.heartbeatRemoteTurnAttemptInternal,
        { ...tuple, now: Date.now() },
      ),
    ).catch(() => null);
    if (
      !result?.allowed ||
      result.leaseExpiresAt === null ||
      result.hardExpiresAt !== hardExpiresAt ||
      result.leaseExpiresAt <= Date.now() ||
      result.leaseExpiresAt > hardExpiresAt
    ) {
      if (!controller.signal.aborted) {
        controller.abort(
          abortError(
            "Remote-turn lease was cancelled or could not be renewed.",
          ),
        );
      }
      return false;
    }
    leaseExpiresAt = result.leaseExpiresAt;
    armAuthorityTimer();
    return true;
  };

  const monitor = (async () => {
    while (!finished && !controller.signal.aborted) {
      await Promise.race([
        new Promise<void>((resolve) =>
          setTimeout(resolve, ATTEMPT_HEARTBEAT_MS),
        ),
        new Promise<void>((resolve) => {
          wakeMonitor = resolve;
        }),
      ]);
      wakeMonitor = undefined;
      if (finished || controller.signal.aborted) break;
      await pulse();
    }
  })();

  const modelDispatchGuard: ManagedDispatchGuard = {
    signal: controller.signal,
    beginDispatch: async () => {
      throwIfAborted(controller.signal);
      const providerDispatchId = crypto.randomUUID();
      const lease: { deadlineAt: number } = await withinAuthority(
        ctx.runMutation(
          internal.channels.connector_delivery
            .beginRemoteTurnProviderDispatchInternal,
          {
            ...tuple,
            providerDispatchId,
            now: Date.now(),
          },
        ),
      ).catch((error) => {
        if (!controller.signal.aborted) controller.abort(error);
        throw error;
      });
      throwIfAborted(controller.signal);
      if (
        lease.deadlineAt <= Date.now() ||
        lease.deadlineAt >= leaseExpiresAt ||
        lease.deadlineAt >= hardExpiresAt
      ) {
        controller.abort(abortError("Invalid remote-turn provider deadline."));
        throwIfAborted(controller.signal);
      }

      const physicalController = new AbortController();
      const abortPhysical = () =>
        physicalController.abort(
          controller.signal.reason ??
            abortError("Remote-turn attempt was cancelled."),
        );
      controller.signal.addEventListener("abort", abortPhysical, {
        once: true,
      });
      const deadlineTimer = setTimeout(
        () =>
          physicalController.abort(
            abortError("Remote-turn provider deadline expired."),
          ),
        Math.max(1, lease.deadlineAt - Date.now()),
      );
      let settled = false;

      return {
        signal: physicalController.signal,
        deadlineAt: lease.deadlineAt,
        settle: async (outcome: ManagedDispatchOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadlineTimer);
          controller.signal.removeEventListener("abort", abortPhysical);
          const accepted: boolean = await withinAuthority(
            ctx.runMutation(
              internal.channels.connector_delivery
                .settleRemoteTurnProviderDispatchInternal,
              {
                ...tuple,
                providerDispatchId,
                outcome,
                now: Date.now(),
              },
            ),
          ).catch((error) => {
            if (!controller.signal.aborted) controller.abort(error);
            throw error;
          });
          if (!accepted) {
            const error = new Error(
              "Remote-turn provider settlement lost exact attempt authority.",
            );
            if (!controller.signal.aborted) controller.abort(error);
            throw error;
          }
        },
      };
    },
  };

  return {
    ...tuple,
    hardExpiresAt,
    signal: controller.signal,
    modelDispatchGuard,
    assertActive: pulse,
    finish: async (outcome) => {
      if (finished) return;
      finished = true;
      if (authorityTimer) clearTimeout(authorityTimer);
      wakeMonitor?.();
      await monitor.catch(() => undefined);
      await ctx.runMutation(
        internal.channels.connector_delivery.finishRemoteTurnAttemptInternal,
        { ...tuple, outcome, now: Date.now() },
      );
      if (!controller.signal.aborted) {
        controller.abort(abortError("Remote-turn attempt finished."));
      }
    },
  };
};
