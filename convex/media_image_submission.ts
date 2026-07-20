import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { decryptSecret } from "./data/secrets_crypto";
import {
  cancelFalRequest,
  getFalApiKey,
  isDefinitiveFalSubmissionRejection,
  submitFalRequest,
} from "./media_fal_webhooks";
import { isRecord } from "./shared_validators";

type DurableImageSubmission = {
  input: Record<string, unknown>;
  webhookUrl: string;
};

const parseSubmission = (value: unknown): DurableImageSubmission => {
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
    if (!encrypted && preview) {
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
      encrypted = await payloadResponse.text();
    }
    if (!encrypted) return null;
    const submission = parseSubmission(
      JSON.parse(await decryptSecret(encrypted)),
    );
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
      const released = await ctx.runMutation(
        internal.media_jobs.releaseImageSubmissionPayload,
        { jobId: args.jobId, storageId: claim.storageId },
      );
      if (released) {
        await ctx.storage.delete(claim.storageId).catch(() => undefined);
      }
    }
    return null;
  },
});

export const deleteSubmissionPayload = internalAction({
  args: { storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.storage.delete(args.storageId).catch(() => undefined);
    return null;
  },
});
