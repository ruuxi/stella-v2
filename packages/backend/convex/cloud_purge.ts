// Owner-scoped teardown for the cloud stack.
//
// Every store this owner has outside Convex (the owner object's data, each
// conversation's DO, R2, the Browser Gateway profile) is purged by the
// cloud-builder worker: this module opens the worker's owner fence, runs its
// `/owners/purge` owner-level pass and, for a reset, releases the fence.
// Each step is idempotent and resumable; anything the worker reports pending
// keeps the purge job open and is retried.

import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const purgeOperationArgs = {
  ownerId: v.string(),
  operationId: v.string(),
  generation: v.string(),
} as const;

const logPurge = (event: string, fields: Record<string, unknown>): void => {
  console.warn(
    JSON.stringify({ service: "convex-cloud-purge", event, ...fields }),
  );
};

// ─── The builder worker ──────────────────────────────────────────────────────

type BuilderEndpoint = { url: string; secret: string };

const builderEndpoint = (): BuilderEndpoint | null => {
  const url = process.env.CLOUD_BUILDER_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return url && secret ? { url, secret } : null;
};

type ExternalPurgeRequest = {
  browserProfiles?: string[];
  /** The owner-level pass: also purges the owner object's own data. */
  mode?: "reset" | "delete";
};

const requireBuilderEndpoint = (): BuilderEndpoint => {
  const builder = builderEndpoint();
  if (!builder) {
    throw new Error(
      "Cloud owner purge cannot be verified because CLOUD_BUILDER_URL or BUILDER_SERVICE_SECRET is missing.",
    );
  }
  return builder;
};

export const beginExternalOwnerPurge = async (
  ownerId: string,
  mode: "temporary" | "permanent",
  requestId: string,
  expectedGeneration?: string,
): Promise<{ generation: string; rejoined: boolean }> => {
  const builder = requireBuilderEndpoint();
  const response = await fetch(`${builder.url}/owners/purge/begin`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${builder.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ownerId,
      mode,
      requestId,
      ...(expectedGeneration ? { expectedGeneration } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const verdict = (await response.json().catch(() => null)) as {
    generation?: string;
    rejoined?: boolean;
  } | null;
  if (!response.ok || !verdict?.generation) {
    throw new Error(
      `Cloud owner activity could not be quiesced before purge (${response.status}).`,
    );
  }
  return {
    generation: verdict.generation,
    rejoined: verdict.rejoined === true,
  };
};

/**
 * Idempotently open/rejoin the worker fence and durably bind its generation to
 * the Convex purge job before any long-running drain starts.
 */
export const ensureExternalOwnerPurge = async (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    operationId: string;
    generation: string;
    mode: "reset" | "delete";
  },
): Promise<string> => {
  const job: { externalGeneration?: string } | null = await ctx.runQuery(
    internal.owner_lifecycle.getOwnerPurgeJobInternal,
    { ownerId: args.ownerId, operationId: args.operationId },
  );
  if (job?.externalGeneration) {
    // Always rejoin. A reset can crash after the worker release response but
    // before lifecycle completion; the durable job still carries the released
    // generation. The worker accepts that exact replay and returns a new fence
    // generation with `rejoined:true`. Delete also uses this call to upgrade a
    // temporary reset fence to permanent.
    const joined = await beginExternalOwnerPurge(
      args.ownerId,
      args.mode === "delete" ? "permanent" : "temporary",
      args.operationId,
      job.externalGeneration,
    );
    if (joined.generation === job.externalGeneration) {
      return job.externalGeneration;
    }
    if (!joined.rejoined) {
      throw new Error(
        "Cloud owner fence changed outside this purge operation.",
      );
    }
    const reboundGeneration: string = await ctx.runMutation(
      internal.owner_lifecycle.rebindOwnerExternalPurgeGenerationInternal,
      {
        ownerId: args.ownerId,
        operationId: args.operationId,
        generation: args.generation,
        previousExternalGeneration: job.externalGeneration,
        externalGeneration: joined.generation,
        now: Date.now(),
      },
    );
    if (args.mode === "delete") {
      // A released-generation rejoin deliberately creates a temporary fence,
      // even when the rejoining request asked for permanent mode. Upgrade the
      // exact replacement generation before deletion proceeds; otherwise a
      // crash between the CAS above and a later retry could leave delete under
      // a releasable reset fence.
      const permanent = await beginExternalOwnerPurge(
        args.ownerId,
        "permanent",
        args.operationId,
        reboundGeneration,
      );
      if (permanent.generation !== reboundGeneration || permanent.rejoined) {
        throw new Error(
          "Cloud owner delete fence could not be upgraded to permanent.",
        );
      }
    }
    return reboundGeneration;
  }
  const external = await beginExternalOwnerPurge(
    args.ownerId,
    args.mode === "delete" ? "permanent" : "temporary",
    args.operationId,
  );
  return await ctx.runMutation(
    internal.owner_lifecycle.recordOwnerExternalPurgeGenerationInternal,
    {
      ownerId: args.ownerId,
      operationId: args.operationId,
      generation: args.generation,
      externalGeneration: external.generation,
      now: Date.now(),
    },
  );
};

const releaseExternalOwnerPurge = async (
  ownerId: string,
  purgeGeneration: string,
): Promise<void> => {
  const builder = requireBuilderEndpoint();
  const response = await fetch(`${builder.url}/owners/purge/release`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${builder.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ownerId, purgeGeneration }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Cloud owner activity remained fenced after reset (${response.status}).`,
    );
  }
};

/**
 * One pass of the worker-side purge. `pending` non-empty means the worker
 * could not finish, and the purge job stays open for a retry.
 *
 * Missing builder configuration is fail-closed. This action cannot prove that
 * an older deployment never wrote external state, so absence of credentials
 * is never evidence that the external tier is empty.
 */
const purgeExternalStores = async (
  ownerId: string,
  ownerGeneration: string,
  request: ExternalPurgeRequest,
  purgeGeneration: string,
): Promise<{ pending: string[] }> => {
  const builder = requireBuilderEndpoint();
  try {
    const response = await fetch(`${builder.url}/owners/purge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${builder.secret}`,
        "content-type": "application/json",
      },
      // `ownerGeneration` is Convex's current lifecycle generation. It is a
      // separate authority from the Builder's external `purgeGeneration` and
      // must never be substituted with that worker-fence value.
      body: JSON.stringify({
        ownerId,
        ownerGeneration,
        purgeGeneration,
        ...request,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      logPurge("owner_storage_purge_unavailable", { status: response.status });
      return { pending: ["builder-storage"] };
    }
    const verdict = (await response.json().catch(() => null)) as {
      pending?: string[];
    } | null;
    // A body that cannot be read is not a purge that succeeded.
    if (!verdict || !Array.isArray(verdict.pending)) {
      logPurge("owner_storage_purge_unreadable", { status: response.status });
      return { pending: ["builder-storage"] };
    }
    return { pending: verdict.pending };
  } catch (error) {
    logPurge("owner_storage_purge_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return { pending: ["builder-storage"] };
  }
};

// ─── The whole cloud stack ───────────────────────────────────────────────────

/**
 * The whole cloud stack for one owner.
 *
 * The worker's owner-level pass purges everything outside Convex, including
 * the owner object's data (its schedules, drive, memory and skills among
 * them) and each conversation's DO.
 *
 * Reset and deletion share the same checked purge. Their durable lifecycle job
 * supplies the mode; both retain every fence and retry until strict
 * completeness succeeds.
 */
export const purgeOwnerCloudStack = internalAction({
  args: purgeOperationArgs,
  returns: v.object({ pending: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const { ownerId } = args;
    const fence = {
      ownerId,
      operationId: args.operationId,
      generation: args.generation,
    };
    const leaseId = crypto.randomUUID();
    const claim: {
      claimed: boolean;
      complete: boolean;
      mode: "reset" | "delete";
    } = await ctx.runMutation(
      internal.owner_lifecycle.claimOwnerPurgeStageInternal,
      {
        ...fence,
        stage: "cloud",
        leaseId,
        now: Date.now(),
      },
    );
    if (claim.complete) return { pending: [] };
    if (!claim.claimed) {
      throw new Error("Owner cloud purge is already leased or not ready.");
    }
    const pending: string[] = [];
    try {
      // The worker fence was normally opened by the core stage. Rejoin it by
      // its durable generation on retry; opening here is the crash-safe fallback.
      const purgeGeneration = await ensureExternalOwnerPurge(ctx, {
        ...fence,
        mode: claim.mode,
      });
      const assertCloudLease = async (): Promise<void> => {
        await ctx.runMutation(
          internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
          {
            ...fence,
            stage: "cloud",
            leaseId,
            mode: claim.mode,
            now: Date.now(),
          },
        );
      };
      const purgeExternalStoresFenced = async (
        request: ExternalPurgeRequest,
      ): Promise<{ pending: string[] }> => {
        await assertCloudLease();
        return await purgeExternalStores(
          ownerId,
          args.generation,
          request,
          purgeGeneration,
        );
      };

      // Owner-level object storage: the owner object's own data
      // (conversations and each one's DO, agent threads, integrations,
      // engines, projects, browser interactions, home, drive, schedules and
      // preferences), the agent-home memory prefix, the Browser Gateway
      // profile, and the owner's world checkpoint.
      const external = await purgeExternalStoresFenced({
        browserProfiles: ["default"],
        mode: claim.mode,
      });
      if (external.pending.length > 0) {
        pending.push(...external.pending.map((store) => `builder:${store}`));
      }

      const unfinished = Array.from(new Set(pending));

      if (unfinished.length > 0) {
        logPurge("owner_cloud_purge_incomplete", { stores: unfinished });
      }
      if (unfinished.length > 0) {
        throw new Error(
          `Cloud deletion is waiting for storage to be purged (${unfinished.join(", ")}); the owner activity fence remains active.`,
        );
      }
      if (claim.mode === "reset") {
        await ctx.runMutation(
          internal.owner_lifecycle.assertOwnerPurgeLeaseInternal,
          {
            ...fence,
            stage: "cloud",
            leaseId,
            mode: "reset",
          },
        );
        await releaseExternalOwnerPurge(ownerId, purgeGeneration);
      }
      const finished: boolean = await ctx.runMutation(
        internal.owner_lifecycle.finishOwnerCloudPurgeInternal,
        {
          ...fence,
          leaseId,
          nextGeneration: crypto.randomUUID(),
          now: Date.now(),
        },
      );
      if (!finished) {
        throw new Error("Owner lifecycle changed before purge completion.");
      }
      return { pending: unfinished };
    } catch (error) {
      await ctx.runMutation(
        internal.owner_lifecycle.scheduleOwnerPurgeRetryInternal,
        {
          ...fence,
          stage: "cloud",
          leaseId,
          error: error instanceof Error ? error.message : String(error),
          now: Date.now(),
        },
      );
      throw error;
    }
  },
});
