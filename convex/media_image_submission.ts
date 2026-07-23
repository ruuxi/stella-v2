import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { decryptSecretPayload } from "./data/secrets_crypto";
import {
  cancelFalRequest,
  getFalApiKey,
  isDefinitiveFalSubmissionRejection,
  submitFalRequest,
} from "./media_fal_webhooks";
import { isRecord } from "./shared_validators";
import {
  assertDurableImageSubmissionShape,
  MAX_DURABLE_IMAGE_SUBMISSION_PLAINTEXT_BYTES,
  MAX_PRIVATE_MEDIA_PAYLOAD_CHARS,
} from "./media_image_limits";

type DurableImageSubmission = {
  input: Record<string, unknown>;
  webhookUrl: string;
};

class ImageSubmissionEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageSubmissionEnvelopeError";
  }
}

const parseSubmission = (value: unknown): DurableImageSubmission => {
  assertDurableImageSubmissionShape(value);
  if (!isRecord(value) || !isRecord(value.input)) {
    throw new Error("Durable image submission payload is invalid.");
  }
  const webhookUrl =
    typeof value.webhookUrl === "string" ? value.webhookUrl.trim() : "";
  if (!webhookUrl) {
    throw new Error("Durable image submission webhook URL is missing.");
  }
  return { input: value.input, webhookUrl };
};

const readLegacyEncryptedPayloadBounded = async (
  response: Response,
): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PRIVATE_MEDIA_PAYLOAD_CHARS) {
    throw new ImageSubmissionEnvelopeError(
      "Durable image submission payload exceeds safe limits.",
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PRIVATE_MEDIA_PAYLOAD_CHARS) {
        await reader.cancel("payload limit exceeded").catch(() => undefined);
        throw new ImageSubmissionEnvelopeError(
          "Durable image submission payload exceeds safe limits.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

export const decryptAndParseImageSubmission = async (
  encryptedSerialized: string,
): Promise<DurableImageSubmission> => {
  if (
    encryptedSerialized.length < 1 ||
    encryptedSerialized.length > MAX_PRIVATE_MEDIA_PAYLOAD_CHARS
  ) {
    throw new ImageSubmissionEnvelopeError(
      "Durable image submission payload exceeds safe limits.",
    );
  }
  const encryptedEnvelope = JSON.parse(encryptedSerialized) as unknown;
  let plaintext = await decryptSecretPayload(encryptedEnvelope);
  if (
    new TextEncoder().encode(plaintext).byteLength >
    MAX_DURABLE_IMAGE_SUBMISSION_PLAINTEXT_BYTES
  ) {
    plaintext = "";
    throw new ImageSubmissionEnvelopeError(
      "Durable image submission plaintext exceeds safe limits.",
    );
  }
  const parsed = JSON.parse(plaintext) as unknown;
  plaintext = "";
  return parseSubmission(parsed);
};

/**
 * At-most-once provider dispatcher for image_gen. The database claim is the
 * last Stella operation before POST. A failure after that claim is ambiguous
 * and is never retried; a Fal webhook may still reconcile it by jobId.
 */
export const submitReservedImageJob = internalAction({
  args: { jobId: v.string(), encryptedPayload: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attemptId = crypto.randomUUID();

    // Read/decrypt before claiming so configuration or storage failures leave
    // the request provably pending and safe for the reconciler to reschedule.
    const preview = args.encryptedPayload
      ? null
      : await ctx.runQuery(internal.media_jobs.getImageSubmissionPayload, {
          jobId: args.jobId,
        });
    if (!args.encryptedPayload && !preview) return null;
    let encrypted = args.encryptedPayload;
    if (!encrypted && preview?.manifestId) {
      const manifest = await ctx.runQuery(
        internal.media_jobs.getPrivatePayloadManifest,
        { manifestId: preview.manifestId },
      );
      if (
        !manifest ||
        manifest.state !== "held" ||
        manifest.jobId !== args.jobId ||
        manifest.writtenChunks !== manifest.expectedChunks ||
        manifest.writtenChars !== manifest.totalChars
      ) {
        throw new Error("Durable image submission payload is incomplete.");
      }
      const parts: string[] = [];
      let afterIndex = -1;
      let count = 0;
      let totalChars = 0;
      while (count < manifest.expectedChunks) {
        const chunks: Array<{ index: number; data: string }> =
          await ctx.runQuery(internal.media_jobs.listPrivatePayloadChunks, {
            manifestId: preview.manifestId,
            afterIndex,
            limit: 32,
          });
        if (chunks.length === 0) break;
        for (const chunk of chunks) {
          if (chunk.index !== count) {
            throw new Error("Durable image submission chunks are unordered.");
          }
          parts.push(chunk.data);
          totalChars += chunk.data.length;
          count += 1;
          afterIndex = chunk.index;
        }
      }
      if (
        count !== manifest.expectedChunks ||
        totalChars !== manifest.totalChars
      ) {
        throw new Error("Durable image submission payload is incomplete.");
      }
      encrypted = parts.join("");
      parts.length = 0;
    }
    if (!encrypted && preview?.storageId) {
      const payloadUrl = await ctx.storage.getUrl(preview.storageId);
      if (!payloadUrl) {
        throw new Error("Durable image submission payload is unavailable.");
      }
      const payloadResponse = await fetch(payloadUrl);
      if (!payloadResponse.ok) {
        throw new Error(
          `Durable image submission payload download failed (${payloadResponse.status}).`,
        );
      }
      try {
        encrypted = await readLegacyEncryptedPayloadBounded(payloadResponse);
      } catch (error) {
        if (!(error instanceof ImageSubmissionEnvelopeError)) throw error;
        await ctx.runMutation(internal.media_jobs.markSubmissionFailed, {
          jobId: args.jobId,
          upstreamStatus: "SUBMISSION_PAYLOAD_REJECTED",
          error: {
            code: "SUBMISSION_PAYLOAD_REJECTED",
            message:
              "A legacy image submission payload exceeded the safe dispatcher envelope and was not sent.",
          },
        });
        return null;
      }
    }
    if (!encrypted) return null;
    let submission: DurableImageSubmission;
    try {
      submission = await decryptAndParseImageSubmission(encrypted);
    } catch (error) {
      if (!(error instanceof ImageSubmissionEnvelopeError)) throw error;
      await ctx.runMutation(internal.media_jobs.markSubmissionFailed, {
        jobId: args.jobId,
        upstreamStatus: "SUBMISSION_PAYLOAD_REJECTED",
        error: {
          code: "SUBMISSION_PAYLOAD_REJECTED",
          message:
            "The image submission payload exceeded the safe dispatcher envelope and was not sent.",
        },
      });
      return null;
    }
    encrypted = undefined;
    const apiKey = getFalApiKey();
    if (!apiKey) throw new Error("Media generation is not configured yet.");

    const claim = await ctx.runMutation(
      internal.media_jobs.claimImageSubmission,
      { jobId: args.jobId, attemptId, claimedAt: Date.now() },
    );
    if (claim.state !== "claimed") return null;

    try {
      const submitted = await submitFalRequest({
        apiKey,
        endpointId: claim.endpointId,
        input: submission.input,
        webhookUrl: submission.webhookUrl,
      });
      const state = await ctx.runMutation(internal.media_jobs.markSubmitted, {
        jobId: args.jobId,
        submissionAttemptId: attemptId,
        providerRequestId: submitted.requestId,
        ...(submitted.gatewayRequestId
          ? { providerGatewayRequestId: submitted.gatewayRequestId }
          : {}),
        ...(submitted.responseUrl
          ? { providerResponseUrl: submitted.responseUrl }
          : {}),
        ...(submitted.statusUrl
          ? { providerStatusUrl: submitted.statusUrl }
          : {}),
        upstreamStatus: submitted.upstreamStatus,
        ...(submitted.queuePosition !== undefined
          ? { queuePosition: submitted.queuePosition }
          : {}),
      });
      if (state.cancelRequested) {
        await cancelFalRequest({
          apiKey,
          endpointId: claim.endpointId,
          requestId: submitted.requestId,
        }).catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as Error & { code?: unknown }).code;
      if (isDefinitiveFalSubmissionRejection(error)) {
        await ctx.runMutation(internal.media_jobs.markSubmissionFailed, {
          jobId: args.jobId,
          upstreamStatus: "ERROR",
          error: {
            message,
            ...(typeof code === "string" && code.trim()
              ? { code: code.trim() }
              : {}),
          },
        });
      } else {
        await ctx.runMutation(internal.media_jobs.markImageSubmissionUnknown, {
          jobId: args.jobId,
          attemptId,
          observedAt: Date.now(),
          error: {
            code: "SUBMISSION_OUTCOME_UNKNOWN",
            message:
              "Fal may have accepted this image, but Stella lost the submission response and will not submit it again.",
            details: { cause: message },
          },
        });
      }
    } finally {
      if (claim.manifestId) {
        await ctx.runMutation(
          internal.media_jobs.releaseImageSubmissionManifest,
          { jobId: args.jobId, manifestId: claim.manifestId },
        );
      } else if (claim.storageId) {
        await ctx.runMutation(
          internal.media_jobs.releaseImageSubmissionPayload,
          { jobId: args.jobId, storageId: claim.storageId },
        );
      }
    }
    return null;
  },
});

export const deleteSubmissionPayload = internalAction({
  args: {
    storageId: v.id("_storage"),
    testFailDelete: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cleanup = await ctx.runQuery(
      internal.media_jobs.getPrivateBlobCleanup,
      { storageId: args.storageId },
    );
    if (!cleanup) return null;
    try {
      if (args.testFailDelete) {
        throw new Error("Injected private blob deletion failure");
      }
      await ctx.runMutation(internal.media_jobs.deletePrivateBlobCleanup, {
        storageId: args.storageId,
      });
    } catch (error) {
      await ctx.runMutation(internal.media_jobs.failPrivateBlobCleanup, {
        storageId: args.storageId,
        failedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return null;
  },
});

export const drainPrivateBlobCleanup = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const due = await ctx.runQuery(
      internal.media_jobs.listDuePrivateBlobCleanup,
      {
        now: Date.now(),
        limit: args.limit ?? 50,
      },
    );
    for (const row of due) {
      await ctx
        .runAction(internal.media_image_submission.deleteSubmissionPayload, {
          storageId: row.storageId,
        })
        .catch(() => undefined);
    }
    return null;
  },
});

export const drainOwnerPrivateBlobCleanup = internalAction({
  args: { ownerId: v.string(), limit: v.optional(v.number()) },
  returns: v.object({ remaining: v.number() }),
  handler: async (ctx, args): Promise<{ remaining: number }> => {
    const rows: Array<{ storageId: Id<"_storage"> }> = await ctx.runQuery(
      internal.media_jobs.listOwnerPrivateBlobCleanup,
      { ownerId: args.ownerId, limit: args.limit ?? 100 },
    );
    for (const row of rows) {
      await ctx
        .runAction(internal.media_image_submission.deleteSubmissionPayload, {
          storageId: row.storageId,
        })
        .catch(() => undefined);
    }
    const remaining: Array<{ storageId: Id<"_storage"> }> = await ctx.runQuery(
      internal.media_jobs.listOwnerPrivateBlobCleanup,
      { ownerId: args.ownerId, limit: 1 },
    );
    return { remaining: remaining.length };
  },
});

export const deletePrivatePayloadManifest = internalAction({
  args: {
    manifestId: v.string(),
    testCrashAfterBatches: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    let batches = 0;
    for (;;) {
      const result = await ctx.runMutation(
        internal.media_jobs.deletePrivatePayloadChunkBatch,
        { manifestId: args.manifestId, limit: 100 },
      );
      if (result.deleted === 0) break;
      batches += 1;
      if (
        args.testCrashAfterBatches !== undefined &&
        batches >= args.testCrashAfterBatches
      ) {
        throw new Error("Injected private payload cleanup crash");
      }
    }
    const deleted = await ctx.runMutation(
      internal.media_jobs.deletePrivatePayloadManifestIfEmpty,
      { manifestId: args.manifestId },
    );
    if (!deleted) throw new Error("Private payload cleanup did not converge.");
    return null;
  },
});

export const drainPrivatePayloadManifests = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows: Array<{ manifestId: string }> = await ctx.runQuery(
      internal.media_jobs.listDuePrivatePayloadManifests,
      { now: Date.now(), limit: args.limit ?? 50 },
    );
    for (const row of rows) {
      await ctx
        .runAction(
          internal.media_image_submission.deletePrivatePayloadManifest,
          { manifestId: row.manifestId },
        )
        .catch(() => undefined);
    }
    return null;
  },
});

export const drainOwnerPrivatePayloadManifests = internalAction({
  args: { ownerId: v.string(), limit: v.optional(v.number()) },
  returns: v.object({ remaining: v.number() }),
  handler: async (ctx, args): Promise<{ remaining: number }> => {
    const rows: Array<{ manifestId: string }> = await ctx.runQuery(
      internal.media_jobs.listOwnerPrivatePayloadManifests,
      { ownerId: args.ownerId, limit: args.limit ?? 100 },
    );
    for (const row of rows) {
      await ctx
        .runAction(
          internal.media_image_submission.deletePrivatePayloadManifest,
          { manifestId: row.manifestId },
        )
        .catch(() => undefined);
    }
    const remaining: Array<{ manifestId: string }> = await ctx.runQuery(
      internal.media_jobs.listOwnerPrivatePayloadManifests,
      { ownerId: args.ownerId, limit: 1 },
    );
    return { remaining: remaining.length };
  },
});

export const cancelPurgedProviderRequest = internalAction({
  args: { jobId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(
      internal.media_jobs.getProviderCancellationByJob,
      { jobId: args.jobId },
    );
    if (!row) return null;
    const apiKey = getFalApiKey();
    if (!apiKey)
      throw new Error("Media provider cancellation is not configured.");
    try {
      await cancelFalRequest({
        apiKey,
        endpointId: row.endpointId,
        requestId: row.providerRequestId,
      });
      await ctx.runMutation(internal.media_jobs.completeProviderCancellation, {
        jobId: row.jobId,
      });
    } catch (error) {
      await ctx.runMutation(internal.media_jobs.failProviderCancellation, {
        jobId: row.jobId,
        failedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return null;
  },
});

export const drainOwnerProviderCancellations = internalAction({
  args: { ownerId: v.string(), limit: v.optional(v.number()) },
  returns: v.object({ remaining: v.number() }),
  handler: async (ctx, args): Promise<{ remaining: number }> => {
    const rows: Array<{ jobId: string }> = await ctx.runQuery(
      internal.media_jobs.listOwnerProviderCancellations,
      { ownerId: args.ownerId, limit: args.limit ?? 100 },
    );
    for (const row of rows) {
      await ctx
        .runAction(
          internal.media_image_submission.cancelPurgedProviderRequest,
          { jobId: row.jobId },
        )
        .catch(() => undefined);
    }
    const remaining: Array<{ jobId: string }> = await ctx.runQuery(
      internal.media_jobs.listOwnerProviderCancellations,
      { ownerId: args.ownerId, limit: 1 },
    );
    return { remaining: remaining.length };
  },
});

export const drainProviderCancellations = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const rows: Array<{ jobId: string }> = await ctx.runQuery(
      internal.media_jobs.listDueProviderCancellations,
      { now: Date.now(), limit: args.limit ?? 50 },
    );
    for (const row of rows) {
      await ctx
        .runAction(
          internal.media_image_submission.cancelPurgedProviderRequest,
          { jobId: row.jobId },
        )
        .catch(() => undefined);
    }
    return null;
  },
});
