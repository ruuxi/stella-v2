import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Value } from "convex/values";
import { encryptSecret } from "../data/secrets_crypto";
import {
  MAX_PRIVATE_MEDIA_PAYLOAD_CHARS,
  PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
} from "../media_jobs";
import { isRecord } from "../shared_validators";

const MEDIA_FAL_WEBHOOK_PATH = "/api/media/v1/webhooks/fal";
const MAX_REQUEST_INPUT_DEPTH = 8;
const MAX_REQUEST_INPUT_NODES = 10_000;
const MAX_REQUEST_INPUT_CHARS = 512 * 1024;

export type DurableFalImageJobSpec = {
  ownerId: string;
  ownerGeneration: string;
  jobId: string;
  clientRequestKey: string;
  clientRequestHash: string;
  capability: string;
  profile: string;
  endpointId: string;
  prompt: string;
  input: Record<string, unknown>;
  /** Redacted/small input retained on the durable job for billing/audit. */
  requestInput?: Record<string, unknown>;
};

export const validateDurableFalRequestInput = (
  input: Record<string, unknown>,
): Record<string, Value> => {
  const budget = { nodes: 0, chars: 0 };
  const visit = (value: unknown, depth: number): Value => {
    budget.nodes += 1;
    if (budget.nodes > MAX_REQUEST_INPUT_NODES) {
      throw new Error("Durable Fal request metadata has too many values.");
    }
    if (depth > MAX_REQUEST_INPUT_DEPTH) {
      throw new Error("Durable Fal request metadata is nested too deeply.");
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error("Durable Fal request metadata has a non-finite number.");
      }
      return value;
    }
    if (typeof value === "string") {
      budget.chars += value.length;
      if (budget.chars > MAX_REQUEST_INPUT_CHARS) {
        throw new Error("Durable Fal request metadata is too large.");
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => visit(entry, depth + 1));
    }
    if (typeof value === "object" && value !== null) {
      const result: Record<string, Value> = {};
      for (const [key, entry] of Object.entries(value)) {
        budget.chars += key.length;
        if (budget.chars > MAX_REQUEST_INPUT_CHARS) {
          throw new Error("Durable Fal request metadata is too large.");
        }
        result[key] = visit(entry, depth + 1);
      }
      return result;
    }
    throw new Error("Durable Fal request metadata is not Convex-safe JSON.");
  };
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, visit(value, 1)]),
  );
};

const webhookUrlForJob = (args: {
  jobId: string;
  ownerGeneration: string;
}): string | null => {
  const siteUrl = process.env.CONVEX_SITE_URL?.trim();
  if (!siteUrl) return null;
  try {
    const webhook = new URL(MEDIA_FAL_WEBHOOK_PATH, siteUrl);
    webhook.searchParams.set("jobId", args.jobId);
    webhook.searchParams.set("ownerGeneration", args.ownerGeneration);
    return webhook.toString();
  } catch {
    return null;
  }
};

/**
 * Shared encrypted outbox reservation for non-HTTP Fal image producers.
 * Provider locator, response-loss reconciliation, cancellation, watchdog,
 * purge, webhook, and media billing all remain on the canonical media job.
 */
export const reserveDurableFalImageJob = async (
  ctx: ActionCtx,
  args: DurableFalImageJobSpec,
): Promise<{ jobId: string } | null> => {
  const existing = await ctx.runQuery(
    internal.media_jobs.getByOwnerClientRequestKey,
    {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      clientRequestKey: args.clientRequestKey,
    },
  );
  if (existing) {
    if (
      existing.clientRequestHash &&
      existing.clientRequestHash !== args.clientRequestHash
    ) {
      throw new Error("Durable Fal media identity was reused with other input.");
    }
    return { jobId: existing.jobId };
  }

  const webhookUrl = webhookUrlForJob({
    jobId: args.jobId,
    ownerGeneration: args.ownerGeneration,
  });
  if (!webhookUrl) return null;
  const requestInput = validateDurableFalRequestInput(
    args.requestInput ?? args.input,
  );
  const encrypted = JSON.stringify(
    await encryptSecret(JSON.stringify({ input: args.input, webhookUrl })),
  );
  if (
    encrypted.length < 1 ||
    encrypted.length > MAX_PRIVATE_MEDIA_PAYLOAD_CHARS
  ) {
    throw new Error("Encrypted Fal submission exceeds safe media limits.");
  }
  const chunks = Array.from(
    {
      length: Math.ceil(encrypted.length / PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS),
    },
    (_, index) =>
      encrypted.slice(
        index * PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
        (index + 1) * PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
      ),
  );
  const manifestId = `durable_fal_payload_${crypto.randomUUID()}`;
  let reservationFinished = false;
  try {
    const manifest = await ctx.runMutation(
      internal.media_jobs.createPrivatePayloadManifest,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        manifestId,
        jobId: args.jobId,
        clientRequestKey: args.clientRequestKey,
        expectedChunks: chunks.length,
        totalChars: encrypted.length,
        createdAt: Date.now(),
      },
    );
    if (manifest === "owner_purged") {
      await ctx.runMutation(
        internal.media_jobs.makePrivatePayloadManifestDeletable,
        { manifestId },
      );
      return null;
    }
    if (manifest !== "created") {
      throw new Error("Durable Fal payload identity was not unique.");
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const appended = await ctx.runMutation(
        internal.media_jobs.appendPrivatePayloadChunk,
        {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          manifestId,
          index,
          data: chunks[index]!,
          writtenAt: Date.now(),
        },
      );
      if (appended === "owner_purged") {
        await ctx.runMutation(
          internal.media_jobs.makePrivatePayloadManifestDeletable,
          { manifestId },
        );
        return null;
      }
    }
    const finalized = await ctx.runMutation(
      internal.media_jobs.finalizePrivatePayloadManifest,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        manifestId,
        finalizedAt: Date.now(),
      },
    );
    if (finalized === "owner_purged") {
      await ctx.runMutation(
        internal.media_jobs.makePrivatePayloadManifestDeletable,
        { manifestId },
      );
      return null;
    }

    const reservation = await ctx.runMutation(
      internal.media_jobs.reserveIdempotentJob,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        jobId: args.jobId,
        clientRequestKey: args.clientRequestKey,
        clientRequestHash: args.clientRequestHash,
        capability: args.capability,
        profile: args.profile,
        provider: "fal",
        endpointId: args.endpointId,
        request: {
          prompt: args.prompt,
          input: requestInput,
        },
        submissionPayloadManifestId: manifestId,
      },
    );
    reservationFinished = true;
    switch (reservation.state) {
      case "created":
      case "existing":
        return { jobId: reservation.jobId };
      case "owner_purged":
      case "canceled":
        return null;
      case "conflict":
        throw new Error("Durable Fal media reservation conflicted.");
    }
  } catch (error) {
    if (!reservationFinished) {
      await ctx
        .runMutation(internal.media_jobs.makePrivatePayloadManifestDeletable, {
          manifestId,
        })
        .catch(() => undefined);
    }
    throw error;
  }
};

export const waitForDurableFalImageUrl = async (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    jobId: string;
    deadlineAt: number;
    pollIntervalMs: number;
  },
): Promise<string> => {
  for (;;) {
    const job = await ctx.runQuery(internal.media_jobs.getByOwnerJobId, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      jobId: args.jobId,
    });
    if (!job) throw new Error("Durable Fal media job no longer exists.");
    if (job.status === "succeeded") {
      const images =
        isRecord(job.output) && Array.isArray(job.output.images)
          ? job.output.images
          : [];
      for (const image of images) {
        if (
          isRecord(image) &&
          typeof image.url === "string" &&
          image.url.trim()
        ) {
          return image.url.trim();
        }
      }
      throw new Error("Fal media job completed without an image URL.");
    }
    if (["failed", "canceled", "unknown"].includes(job.status)) {
      throw new Error(
        job.error?.message || `Fal media job ended with ${job.status}.`,
      );
    }
    const remaining = args.deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new Error("Timed out waiting for durable Fal media generation.");
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(args.pollIntervalMs, remaining)),
    );
  }
};
