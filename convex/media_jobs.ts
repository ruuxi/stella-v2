import { ConvexError, type Value, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type {
  MediaGenerateRequest,
  MediaRequestSummary,
  MediaJobStatus,
  MediaSourceReference,
} from "./media_contract";
import {
  mediaJobErrorValidator,
  mediaJobBillingValidator,
  mediaJobResponseValidator,
  mediaRequestSummaryValidator,
} from "./schema/media";
import {
  isRecord,
  jsonValueValidator,
  optionalJsonValueValidator,
} from "./shared_validators";
import { extractDeliveryMediaFromOutput } from "./channels/connector_media_types";

export const PUBLIC_MEDIA_TEST_OWNER_ID = "__public_media_test__";

export const isMediaPublicTestModeEnabled = (): boolean =>
  process.env.MEDIA_PUBLIC_TEST_MODE?.trim() === "1";

type MediaRequestSourceSummary = {
  kind: "url" | "data_uri" | "base64_object";
  mimeType?: string;
  url?: string;
};

type StoredMediaRequestSummary = MediaRequestSummary & {
  input?: Record<string, Value>;
};

const redactLargeString = (value: string): string => {
  const trimmed = value.trim();
  if (/^data:[^;,\s]+;base64,/i.test(trimmed)) {
    return "[data-uri omitted]";
  }
  if (trimmed.length > 2048 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    return "[base64 omitted]";
  }
  return trimmed;
};

const sanitizeJsonValue = (value: unknown, depth = 0): Value => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return redactLargeString(value);
  }
  if (Array.isArray(value)) {
    if (depth >= 6) {
      return [];
    }
    return value.map((entry) => sanitizeJsonValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    if (depth >= 6) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        sanitizeJsonValue(entryValue, depth + 1),
      ]),
    );
  }
  return String(value);
};

const toSourceSummary = (
  source: MediaSourceReference | undefined,
): MediaRequestSourceSummary | undefined => {
  if (!source) {
    return undefined;
  }
  if (typeof source === "string") {
    if (/^data:/i.test(source.trim())) {
      const mimeType = source.trim().match(/^data:([^;,\s]+);base64,/i)?.[1];
      return {
        kind: "data_uri",
        ...(mimeType ? { mimeType } : {}),
      };
    }
    return { kind: "url", url: source.trim() };
  }
  return {
    kind: "base64_object",
    ...(source.mimeType.trim() ? { mimeType: source.mimeType.trim() } : {}),
  };
};

export const summarizeMediaRequestForStorage = (
  request: MediaGenerateRequest,
): StoredMediaRequestSummary => {
  const source =
    toSourceSummary(request.source) ??
    (request.sourceUrl
      ? { kind: "url" as const, url: request.sourceUrl }
      : undefined);
  const sources = request.sources
    ? Object.fromEntries(
        Object.entries(request.sources)
          .map(([key, value]) => [key, toSourceSummary(value)])
          .filter(
            (entry): entry is [string, MediaRequestSourceSummary] =>
              entry[1] !== undefined,
          ),
      )
    : undefined;

  const sanitizedInput = sanitizeJsonValue(request.input);
  return {
    ...(request.prompt ? { prompt: request.prompt } : {}),
    ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
    ...(source ? { source } : {}),
    ...(sources && Object.keys(sources).length > 0 ? { sources } : {}),
    ...(isRecord(sanitizedInput) && Object.keys(sanitizedInput).length > 0
      ? { input: sanitizedInput as Record<string, Value> }
      : {}),
  };
};

/**
 * Hard cap on how many child-table log entries we hydrate per job response.
 * Long-running jobs may accumulate many webhook entries; clients only need
 * the most recent few for display.
 */
const MAX_JOB_LOGS_RETURNED = 100;
const DEFAULT_STALE_MEDIA_JOB_LIMIT = 100;
const STALE_IMAGE_JOB_CAPABILITIES = [
  "text_to_image",
  "image_edit",
  "icon",
] as const;

const idempotentJobLookupValidator = v.object({
  jobId: v.string(),
  capability: v.string(),
  profile: v.string(),
  status: v.union(
    v.literal("queued"),
    v.literal("running"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("canceled"),
  ),
  upstreamStatus: v.string(),
  clientRequestHash: v.optional(v.string()),
});

const toStoredMediaJobResponse = (
  job: {
    jobId: string;
    capability: string;
    profile: string;
    request: StoredMediaRequestSummary;
    status: MediaJobStatus;
    upstreamStatus: string;
    queuePosition: number | null;
    output?: Value;
    error?: { message: string; code?: string; details?: Value };
    createdAt: number;
    updatedAt: number;
    startedAt?: number;
    completedAt?: number;
  },
  childLogs?: Value[],
) => {
  return {
    jobId: job.jobId,
    capability: job.capability,
    profile: job.profile,
    request: job.request,
    status: job.status,
    upstreamStatus: job.upstreamStatus,
    queuePosition: job.queuePosition,
    ...(childLogs && childLogs.length > 0 ? { logs: childLogs } : {}),
    ...(job.output !== undefined ? { output: job.output } : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt !== undefined ? { completedAt: job.completedAt } : {}),
  };
};

/**
 * Load the most recent webhook log entries for a job from the child
 * `media_job_logs` table. Returns chronologically-ordered entries (oldest
 * first) so callers can render them top-to-bottom.
 */
const loadJobLogs = async (
  ctx: Pick<QueryCtx, "db">,
  jobId: string,
): Promise<Value[]> => {
  const rows = await ctx.db
    .query("media_job_logs")
    .withIndex("by_jobId_and_ordinal", (q) => q.eq("jobId", jobId))
    .order("desc")
    .take(MAX_JOB_LOGS_RETURNED);
  return rows.reverse().map((row) => row.entry);
};

const toViewerOwnerId = async (ctx: QueryCtx): Promise<string> => {
  const ownerId = await toViewerOwnerIdOrNull(ctx);
  if (!ownerId) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    });
  }
  return ownerId;
};

/**
 * Read-side variant: returns null when no identity is attached so subscribed
 * queries can return empty/null instead of throwing into the React error
 * boundary during sign-in / sign-out transitions.
 */
const toViewerOwnerIdOrNull = async (ctx: QueryCtx): Promise<string | null> => {
  const identity = await ctx.auth.getUserIdentity();
  if (identity?.tokenIdentifier) {
    return identity.tokenIdentifier;
  }
  if (isMediaPublicTestModeEnabled()) {
    return PUBLIC_MEDIA_TEST_OWNER_ID;
  }
  return null;
};

const toInitialMediaJobStatus = (upstreamStatus: string): MediaJobStatus => {
  switch (upstreamStatus.trim().toUpperCase()) {
    case "COMPLETED":
    case "OK":
      return "succeeded";
    case "FAILED":
    case "ERROR":
      return "failed";
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    case "IN_PROGRESS":
    case "RUNNING":
      return "running";
    default:
      return "queued";
  }
};

const toWebhookMediaJobStatus = (upstreamStatus: string): MediaJobStatus => {
  switch (upstreamStatus.trim().toUpperCase()) {
    case "OK":
    case "COMPLETED":
      return "succeeded";
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    case "FAILED":
    case "ERROR":
    default:
      return "failed";
  }
};

const getJobByJobId = async (ctx: Pick<QueryCtx, "db">, jobId: string) =>
  await ctx.db
    .query("media_jobs")
    .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
    .unique();

const getJobByProviderRequestId = async (
  ctx: Pick<QueryCtx, "db">,
  providerRequestId: string,
) =>
  await ctx.db
    .query("media_jobs")
    .withIndex("by_provider_and_providerRequestId", (q) =>
      q.eq("provider", "fal").eq("providerRequestId", providerRequestId),
    )
    .unique();

const getJobByClientRequestKey = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  clientRequestKey: string,
) =>
  await ctx.db
    .query("media_jobs")
    .withIndex("by_ownerId_and_clientRequestKey", (q) =>
      q.eq("ownerId", ownerId).eq("clientRequestKey", clientRequestKey),
    )
    .unique();

export const getByJobId = query({
  args: {
    jobId: v.string(),
  },
  returns: v.union(v.null(), mediaJobResponseValidator),
  handler: async (ctx, args) => {
    const ownerId = await toViewerOwnerIdOrNull(ctx);
    if (!ownerId) {
      return null;
    }
    const job = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_jobId", (q) =>
        q.eq("ownerId", ownerId).eq("jobId", args.jobId),
      )
      .unique();

    if (!job) {
      return null;
    }

    const childLogs = await loadJobLogs(ctx, job.jobId);
    return toStoredMediaJobResponse(job, childLogs);
  },
});

export const getByOwnerJobId = internalQuery({
  args: {
    ownerId: v.string(),
    jobId: v.string(),
  },
  returns: v.union(v.null(), mediaJobResponseValidator),
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_jobId", (q) =>
        q.eq("ownerId", args.ownerId).eq("jobId", args.jobId),
      )
      .unique();

    return job ? toStoredMediaJobResponse(job) : null;
  },
});

export const getByOwnerClientRequestKey = internalQuery({
  args: {
    ownerId: v.string(),
    clientRequestKey: v.string(),
  },
  returns: v.union(v.null(), idempotentJobLookupValidator),
  handler: async (ctx, args) => {
    const job = await getJobByClientRequestKey(
      ctx,
      args.ownerId,
      args.clientRequestKey,
    );
    return job
      ? {
          jobId: job.jobId,
          capability: job.capability,
          profile: job.profile,
          status: job.status,
          upstreamStatus: job.upstreamStatus,
          ...(job.clientRequestHash
            ? { clientRequestHash: job.clientRequestHash }
            : {}),
        }
      : null;
  },
});

/**
 * Reactive feed of every succeeded media job for the current viewer that
 * completed at-or-after `since`. The desktop renderer subscribes to this on
 * boot so the Display sidebar can surface any media output regardless of who
 * started the job (MediaStudio, the agent's `MediaGenerate` tool, a CLI…).
 *
 * `since` is a `completedAt` lower bound (millis). Pass `Date.now()` on first
 * subscribe to get only jobs that finish after the app launches, or pass a
 * smaller value (e.g., last-seen timestamp from local storage) to also
 * back-fill recently missed completions.
 */
export const listSucceededSince = query({
  args: {
    since: v.number(),
    limit: v.optional(v.number()),
    /**
     * When `true`, hydrate the per-job webhook log entries from
     * `media_job_logs`. Defaults to `false` because the desktop materializer
     * (the primary subscriber) only consumes `output`/`status`/`request` and
     * doesn't need the noisy log array.
     */
    includeLogs: v.optional(v.boolean()),
  },
  returns: v.array(mediaJobResponseValidator),
  handler: async (ctx, args) => {
    const ownerId = await toViewerOwnerIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
    const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
    // Indexed on `(ownerId, status, completedAt)` so we read only succeeded
    // rows in completion order — no JS-side status filter and no over-fetch.
    const succeeded = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_status_and_completedAt", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("status", "succeeded")
          .gte("completedAt", args.since),
      )
      .order("desc")
      .take(limit);

    const wantsLogs = args.includeLogs === true;
    const logs = wantsLogs
      ? await Promise.all(succeeded.map((row) => loadJobLogs(ctx, row.jobId)))
      : succeeded.map(() => undefined);
    return succeeded.map((row, index) =>
      toStoredMediaJobResponse(row, logs[index]),
    );
  },
});

export const listFailedSince = query({
  args: {
    since: v.number(),
    limit: v.optional(v.number()),
    includeLogs: v.optional(v.boolean()),
  },
  returns: v.array(mediaJobResponseValidator),
  handler: async (ctx, args) => {
    const ownerId = await toViewerOwnerIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
    const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
    const failed = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_status_and_completedAt", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("status", "failed")
          .gte("completedAt", args.since),
      )
      .order("desc")
      .take(limit);

    const wantsLogs = args.includeLogs === true;
    const logs = wantsLogs
      ? await Promise.all(failed.map((row) => loadJobLogs(ctx, row.jobId)))
      : failed.map(() => undefined);
    return failed.map((row, index) =>
      toStoredMediaJobResponse(row, logs[index]),
    );
  },
});

export const getWebhookJob = internalQuery({
  args: {
    jobId: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Fal webhook URLs normally embed `?jobId=`, but fall back to the
    // provider request id so a webhook that lost the query param still
    // resolves the job (and therefore still meters usage).
    const job =
      (args.jobId ? await getJobByJobId(ctx, args.jobId) : null) ??
      (args.providerRequestId
        ? await getJobByProviderRequestId(ctx, args.providerRequestId)
        : null);
    if (!job) {
      return null;
    }
    return {
      jobId: job.jobId,
      ownerId: job.ownerId,
      request: job.request,
      endpointId: job.endpointId,
      providerRequestId: job.providerRequestId,
      providerResponseUrl: job.providerResponseUrl,
      providerStatusUrl: job.providerStatusUrl,
    };
  },
});

export const createJob = internalMutation({
  args: {
    ownerId: v.string(),
    jobId: v.string(),
    capability: v.string(),
    profile: v.string(),
    provider: v.union(v.literal("fal"), v.literal("google_lyria")),
    endpointId: v.string(),
    request: mediaRequestSummaryValidator,
    connectorRequestId: v.optional(v.string()),
    billing: v.optional(mediaJobBillingValidator),
  },
  handler: async (ctx, args) => {
    const existing = await getJobByJobId(ctx, args.jobId);
    if (existing) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Media job already exists.",
      });
    }

    const now = Date.now();
    await ctx.db.insert("media_jobs", {
      ownerId: args.ownerId,
      jobId: args.jobId,
      capability: args.capability,
      profile: args.profile,
      provider: args.provider,
      endpointId: args.endpointId,
      request: args.request,
      ...(args.connectorRequestId
        ? { connectorRequestId: args.connectorRequestId }
        : {}),
      ...(args.billing ? { billing: args.billing } : {}),
      status: "queued",
      upstreamStatus: "IN_QUEUE",
      queuePosition: null,
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});

const reserveIdempotentJobResultValidator = v.union(
  v.object({
    state: v.literal("created"),
    jobId: v.string(),
    status: v.literal("queued"),
    upstreamStatus: v.string(),
  }),
  v.object({
    state: v.literal("existing"),
    jobId: v.string(),
    capability: v.string(),
    profile: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    upstreamStatus: v.string(),
  }),
  v.object({
    state: v.literal("conflict"),
    jobId: v.string(),
  }),
  v.object({ state: v.literal("canceled") }),
);

/**
 * Atomically reserve an owner-scoped media request identity. Retried POSTs
 * attach to the existing row and never repeat provider submission. A
 * cancellation tombstone wins even when DELETE arrives before this mutation.
 */
export const reserveIdempotentJob = internalMutation({
  args: {
    ownerId: v.string(),
    jobId: v.string(),
    clientRequestKey: v.string(),
    clientRequestHash: v.string(),
    capability: v.string(),
    profile: v.string(),
    provider: v.union(v.literal("fal"), v.literal("google_lyria")),
    endpointId: v.string(),
    request: mediaRequestSummaryValidator,
    connectorRequestId: v.optional(v.string()),
    billing: v.optional(mediaJobBillingValidator),
  },
  returns: reserveIdempotentJobResultValidator,
  handler: async (ctx, args) => {
    const canceled = await ctx.db
      .query("media_request_cancellations")
      .withIndex("by_ownerId_and_clientRequestKey", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("clientRequestKey", args.clientRequestKey),
      )
      .unique();
    if (canceled) return { state: "canceled" as const };

    const existing = await getJobByClientRequestKey(
      ctx,
      args.ownerId,
      args.clientRequestKey,
    );
    if (existing) {
      if (existing.clientRequestHash !== args.clientRequestHash) {
        return { state: "conflict" as const, jobId: existing.jobId };
      }
      return {
        state: "existing" as const,
        jobId: existing.jobId,
        capability: existing.capability,
        profile: existing.profile,
        status: existing.status,
        upstreamStatus: existing.upstreamStatus,
      };
    }

    if (await getJobByJobId(ctx, args.jobId)) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Media job already exists.",
      });
    }

    const now = Date.now();
    await ctx.db.insert("media_jobs", {
      ownerId: args.ownerId,
      jobId: args.jobId,
      clientRequestKey: args.clientRequestKey,
      clientRequestHash: args.clientRequestHash,
      capability: args.capability,
      profile: args.profile,
      provider: args.provider,
      endpointId: args.endpointId,
      request: args.request,
      ...(args.connectorRequestId
        ? { connectorRequestId: args.connectorRequestId }
        : {}),
      ...(args.billing ? { billing: args.billing } : {}),
      status: "queued",
      upstreamStatus: "IN_QUEUE",
      queuePosition: null,
      createdAt: now,
      updatedAt: now,
    });
    return {
      state: "created" as const,
      jobId: args.jobId,
      status: "queued" as const,
      upstreamStatus: "IN_QUEUE",
    };
  },
});

export const beginSubmission = internalMutation({
  args: { ownerId: v.string(), jobId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job || job.ownerId !== args.ownerId || job.status === "canceled") {
      return false;
    }
    return !job.providerRequestId;
  },
});

const cancelIdempotentRequestResultValidator = v.object({
  state: v.union(
    v.literal("canceled"),
    v.literal("succeeded"),
    v.literal("failed"),
  ),
  jobId: v.optional(v.string()),
  endpointId: v.optional(v.string()),
  providerRequestId: v.optional(v.string()),
});

/** Persist cancellation before attempting provider cancellation. */
export const cancelIdempotentRequest = internalMutation({
  args: {
    ownerId: v.string(),
    clientRequestKey: v.string(),
    canceledAt: v.number(),
  },
  returns: cancelIdempotentRequestResultValidator,
  handler: async (ctx, args) => {
    const existingTombstone = await ctx.db
      .query("media_request_cancellations")
      .withIndex("by_ownerId_and_clientRequestKey", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("clientRequestKey", args.clientRequestKey),
      )
      .unique();
    if (!existingTombstone) {
      await ctx.db.insert("media_request_cancellations", {
        ownerId: args.ownerId,
        clientRequestKey: args.clientRequestKey,
        createdAt: args.canceledAt,
      });
    }

    const job = await getJobByClientRequestKey(
      ctx,
      args.ownerId,
      args.clientRequestKey,
    );
    if (!job) return { state: "canceled" as const };
    if (job.status === "succeeded" || job.status === "failed") {
      return {
        state: job.status,
        jobId: job.jobId,
        endpointId: job.endpointId,
        ...(job.providerRequestId
          ? { providerRequestId: job.providerRequestId }
          : {}),
      };
    }
    if (job.status !== "canceled") {
      await ctx.db.patch(job._id, {
        status: "canceled",
        upstreamStatus: "CANCELED",
        queuePosition: null,
        error: { message: "Image generation was canceled.", code: "CANCELED" },
        updatedAt: args.canceledAt,
        completedAt: args.canceledAt,
      });
    }
    return {
      state: "canceled" as const,
      jobId: job.jobId,
      endpointId: job.endpointId,
      ...(job.providerRequestId
        ? { providerRequestId: job.providerRequestId }
        : {}),
    };
  },
});

export const markSubmitted = internalMutation({
  args: {
    jobId: v.string(),
    providerRequestId: v.string(),
    providerGatewayRequestId: v.optional(v.string()),
    providerResponseUrl: v.optional(v.string()),
    providerStatusUrl: v.optional(v.string()),
    upstreamStatus: v.string(),
    queuePosition: v.optional(v.number()),
  },
  returns: v.object({ cancelRequested: v.boolean() }),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Media job not found.",
      });
    }

    const now = Date.now();
    const cancelRequested = job.status === "canceled";
    const status = cancelRequested
      ? "canceled"
      : toInitialMediaJobStatus(args.upstreamStatus);
    await ctx.db.patch(job._id, {
      providerRequestId: args.providerRequestId,
      ...(args.providerGatewayRequestId
        ? { providerGatewayRequestId: args.providerGatewayRequestId }
        : {}),
      ...(args.providerResponseUrl
        ? { providerResponseUrl: args.providerResponseUrl }
        : {}),
      ...(args.providerStatusUrl
        ? { providerStatusUrl: args.providerStatusUrl }
        : {}),
      upstreamStatus: cancelRequested ? "CANCELED" : args.upstreamStatus,
      status,
      queuePosition: cancelRequested
        ? null
        : args.queuePosition !== undefined
          ? args.queuePosition
          : job.queuePosition,
      updatedAt: now,
      ...(status === "running" && job.startedAt === undefined
        ? { startedAt: now }
        : {}),
      ...(status === "succeeded" || status === "failed" || status === "canceled"
        ? { completedAt: now }
        : {}),
    });
    return { cancelRequested };
  },
});

export const markSubmissionFailed = internalMutation({
  args: {
    jobId: v.string(),
    upstreamStatus: v.string(),
    error: mediaJobErrorValidator,
  },
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) {
      return null;
    }
    if (job.status === "canceled") return null;
    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: "failed",
      upstreamStatus: args.upstreamStatus,
      error: args.error,
      updatedAt: now,
      completedAt: now,
    });
    return null;
  },
});

export const markStaleJobsFailed = internalMutation({
  args: {
    cutoffMs: v.optional(v.number()),
    staleMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(
      1,
      Math.min(args.limit ?? DEFAULT_STALE_MEDIA_JOB_LIMIT, 500),
    );
    const cutoffMs =
      args.cutoffMs ?? Date.now() - (args.staleMs ?? 15 * 60_000);
    const terminalError = {
      message: "Image generation timed out after 15 minutes.",
      code: "TIMEOUT",
    };
    let updated = 0;

    for (const status of ["queued", "running"] as const) {
      for (const capability of STALE_IMAGE_JOB_CAPABILITIES) {
        const jobs = await ctx.db
          .query("media_jobs")
          .withIndex("by_status_and_capability_and_updatedAt", (q) =>
            q
              .eq("status", status)
              .eq("capability", capability)
              .lt("updatedAt", cutoffMs),
          )
          .take(limit - updated);

        const now = Date.now();
        for (const job of jobs) {
          await ctx.db.patch(job._id, {
            status: "failed",
            upstreamStatus: "TIMEOUT",
            queuePosition: null,
            error: terminalError,
            updatedAt: now,
            completedAt: now,
          });
          updated += 1;
        }

        if (updated >= limit) {
          break;
        }
      }
      if (updated >= limit) break;
    }

    return { updated };
  },
});

export const markGenerated = internalMutation({
  args: {
    jobId: v.string(),
    upstreamStatus: v.string(),
    output: jsonValueValidator,
    billing: v.optional(mediaJobBillingValidator),
  },
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) {
      return null;
    }
    if (job.status === "canceled") return null;
    const now = Date.now();
    const output = sanitizeJsonValue(args.output);
    // `connectorMediaDeliveryScheduledAt` is the dedup gate: we set it in
    // the same patch that schedules `deliverMediaJobToConnector`, so a
    // duplicate `markGenerated` / `applyFalWebhook` for the same job won't
    // re-schedule. `connectorMediaDeliveredAt` is set by the delivery
    // action itself on success — keeping the two flags separate means a
    // transient delivery failure leaves a clear `scheduledAt && !deliveredAt`
    // state for the watchdog (or manual recovery) to retry.
    const shouldScheduleConnectorDelivery =
      Boolean(job.connectorRequestId) &&
      !job.connectorMediaDeliveredAt &&
      !job.connectorMediaDeliveryScheduledAt &&
      extractDeliveryMediaFromOutput(output).length > 0;
    await ctx.db.patch(job._id, {
      status: "succeeded",
      upstreamStatus: args.upstreamStatus,
      queuePosition: null,
      output,
      ...(args.billing ? { billing: args.billing } : {}),
      updatedAt: now,
      startedAt: job.startedAt ?? now,
      completedAt: now,
      ...(shouldScheduleConnectorDelivery
        ? { connectorMediaDeliveryScheduledAt: now }
        : {}),
    });
    if (shouldScheduleConnectorDelivery) {
      await ctx.scheduler.runAfter(
        0,
        internal.channels.connector_delivery.deliverMediaJobToConnector,
        {
          requestId: job.connectorRequestId!,
          jobId: job.jobId,
          output,
        },
      );
    }
    // The fal path charges usage from the webhook handler; jobs completed
    // via `markGenerated` (e.g. Lyria) must charge here or the generation
    // never counts against the owner's usage windows. The receipt table in
    // `recordMediaCompletedUsage` makes this idempotent per job.
    if (args.billing) {
      await ctx.scheduler.runAfter(
        0,
        internal.billing.recordMediaCompletedUsage,
        {
          ownerId: job.ownerId,
          jobId: job.jobId,
          ...(job.providerRequestId
            ? { providerRequestId: job.providerRequestId }
            : {}),
          endpointId: args.billing.endpointId,
          billingUnit: String(args.billing.billingUnit),
          quantity: args.billing.quantity,
          costMicroCents: args.billing.costMicroCents,
        },
      );
    }
    return null;
  },
});

export const applyFalWebhook = internalMutation({
  args: {
    jobId: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    providerGatewayRequestId: v.optional(v.string()),
    upstreamStatus: v.string(),
    output: optionalJsonValueValidator,
    billing: v.optional(mediaJobBillingValidator),
    error: v.optional(mediaJobErrorValidator),
    logs: v.optional(v.array(jsonValueValidator)),
    receivedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const job =
      (args.jobId ? await getJobByJobId(ctx, args.jobId) : null) ??
      (args.providerRequestId
        ? await getJobByProviderRequestId(ctx, args.providerRequestId)
        : null);

    if (!job) {
      return { updated: false };
    }

    // Cancellation is terminal. A late provider webhook must not resurrect a
    // canceled generation or surface an artifact after the tool was aborted.
    if (job.status === "canceled") {
      return { updated: false, jobId: job.jobId };
    }

    // Append log entries to the child `media_job_logs` table instead of
    // mutating an inline array on the job document. This keeps the job doc
    // small (and within the 1MB limit) regardless of how many webhook
    // deliveries arrive over the lifetime of a long-running generation.
    if (args.logs && args.logs.length > 0) {
      const existingLogCount = await ctx.db
        .query("media_job_logs")
        .withIndex("by_jobId_and_ordinal", (q) => q.eq("jobId", job.jobId))
        .order("desc")
        .take(1);
      let nextOrdinal = (existingLogCount[0]?.ordinal ?? -1) + 1;
      for (const entry of args.logs) {
        await ctx.db.insert("media_job_logs", {
          ownerId: job.ownerId,
          jobId: job.jobId,
          ordinal: nextOrdinal,
          receivedAt: args.receivedAt,
          entry: sanitizeJsonValue(entry),
        });
        nextOrdinal += 1;
      }
    }

    const status = toWebhookMediaJobStatus(args.upstreamStatus);
    const output =
      args.output !== undefined ? sanitizeJsonValue(args.output) : undefined;
    const shouldDeliverConnectorMedia =
      status === "succeeded" &&
      job.connectorRequestId &&
      !job.connectorMediaDeliveredAt &&
      !job.connectorMediaDeliveryScheduledAt &&
      output !== undefined &&
      extractDeliveryMediaFromOutput(output).length > 0;
    await ctx.db.patch(job._id, {
      status,
      upstreamStatus: args.upstreamStatus,
      queuePosition: null,
      ...(args.providerRequestId
        ? { providerRequestId: args.providerRequestId }
        : {}),
      ...(args.providerGatewayRequestId
        ? { providerGatewayRequestId: args.providerGatewayRequestId }
        : {}),
      ...(output !== undefined ? { output } : {}),
      ...(args.billing ? { billing: args.billing } : {}),
      ...(args.error
        ? {
            error: {
              message: args.error.message,
              ...(args.error.code ? { code: args.error.code } : {}),
              ...(args.error.details
                ? {
                    details: sanitizeJsonValue(args.error.details),
                  }
                : {}),
            },
          }
        : {}),
      updatedAt: args.receivedAt,
      completedAt: args.receivedAt,
      lastWebhookAt: args.receivedAt,
      ...(shouldDeliverConnectorMedia
        ? { connectorMediaDeliveryScheduledAt: args.receivedAt }
        : {}),
    });

    if (shouldDeliverConnectorMedia) {
      await ctx.scheduler.runAfter(
        0,
        internal.channels.connector_delivery.deliverMediaJobToConnector,
        {
          requestId: job.connectorRequestId!,
          jobId: job.jobId,
          output: output!,
        },
      );
    }

    return { updated: true, jobId: job.jobId };
  },
});

/**
 * Patch a media job to record a successful connector media delivery.
 * Called from `deliverMediaJobToConnector` after the connector POST
 * succeeded, separately from the `markGenerated` / `applyFalWebhook`
 * mutations so a transient delivery failure doesn't leave the row
 * marked "delivered" forever.
 */
export const markConnectorMediaDelivered = internalMutation({
  args: { jobId: v.string(), deliveredAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) return null;
    if (job.connectorMediaDeliveredAt) return null;
    await ctx.db.patch(job._id, {
      connectorMediaDeliveredAt: args.deliveredAt,
      ...(job.connectorMediaDeliveryError
        ? { connectorMediaDeliveryError: undefined }
        : {}),
    });
    return null;
  },
});

/**
 * Record the most recent connector media delivery failure on the job.
 * Leaves `connectorMediaDeliveryScheduledAt` set so the dedup gate keeps
 * holding — recovery is via manual re-trigger or a future watchdog rather
 * than spontaneous re-fire on the next mutation.
 */
export const markConnectorMediaDeliveryFailed = internalMutation({
  args: { jobId: v.string(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) return null;
    if (job.connectorMediaDeliveredAt) return null;
    await ctx.db.patch(job._id, {
      connectorMediaDeliveryError: args.error.slice(0, 1000),
    });
    return null;
  },
});
