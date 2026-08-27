import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  errorResponse,
  withCors,
  handleCorsRequest,
  registerCorsOptions,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";
import { getUserProviderKey } from "../lib/provider_keys";
import { generateMusic, parseMusicStreamRequest } from "../media_lyria";
import { checkManagedUsageLimit } from "../lib/managed_billing";
import { dollarsToMicroCents } from "../lib/billing_money";
import { requireSignedInAccountAction } from "../http_shared/auth";
import { requireCapabilityAction } from "../http_shared/capability";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
import { createMediaProviderDispatch } from "../lib/media_provider_dispatch";

const MUSIC_STREAM_PATH = "/api/music/stream";
const MUSIC_KEY_PATH = "/api/music/api-key";
const MUSIC_STREAM_RATE_LIMIT = 10;
const MUSIC_STREAM_RATE_WINDOW_MS = 300_000;

// Lyria 3 Pro Preview pricing as of 2026-05: one song per request.
const LYRIA_USD_PER_SONG = 0.08;
const LYRIA_ENDPOINT_ID = "google/lyria-3-pro-preview";

export const registerMusicRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, [MUSIC_STREAM_PATH, MUSIC_KEY_PATH]);

  http.route({
    path: MUSIC_STREAM_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use music generation.",
          realm: "stella-music",
        });
        if (!auth.ok) return auth.response;
        const ownerId = auth.ownerId;
        const { generation: ownerGeneration } =
          await assertOwnerDataAccessActive(ctx, ownerId);

        // Music is generative audio — a Pro surface. Checked before the
        // usage window so a plan mismatch never reads as "out of credit".
        const capabilityCheck = await requireCapabilityAction(
          ctx,
          ownerId,
          "audio_generation",
          origin,
        );
        if (!capabilityCheck.ok) return capabilityCheck.response;

        const subscriptionCheck = await checkManagedUsageLimit(ctx, ownerId);
        if (!subscriptionCheck.allowed) {
          return errorResponse(429, subscriptionCheck.message, origin);
        }

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "music_stream",
            key: ownerId,
            limit: MUSIC_STREAM_RATE_LIMIT,
            windowMs: MUSIC_STREAM_RATE_WINDOW_MS,
            blockMs: MUSIC_STREAM_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: unknown = null;
        try {
          body = await request.json();
        } catch {
          return errorResponse(400, "Invalid JSON body.", origin);
        }

        const parsedBody = parseMusicStreamRequest(body);
        if (!parsedBody) {
          return errorResponse(
            400,
            "weightedPrompts and musicGenerationConfig are required.",
            origin,
          );
        }

        const userProvidedKey = await getUserProviderKey(
          ctx,
          ownerId,
          "llm:google",
        );
        // Only meter against the user's plan when Stella's key paid for it —
        // BYO-key callers don't cost Stella anything.
        const billable = !userProvidedKey;
        const apiKey = userProvidedKey ?? process.env.GOOGLE_AI_API_KEY ?? null;
        if (!apiKey) {
          return errorResponse(
            503,
            "No Google AI API key configured. Add one in Settings or contact your administrator.",
            origin,
          );
        }

        const jobId = `music_stream_${crypto.randomUUID()}`;
        await ctx.runMutation(internal.media_jobs.createJob, {
          ownerId,
          ownerGeneration,
          jobId,
          capability: "music_generation",
          profile: "lyria-3-pro-preview",
          provider: "google_lyria",
          endpointId: LYRIA_ENDPOINT_ID,
          request: {},
          ...(!billable
            ? {
                notChargeablePolicy:
                  "user_provided_provider_key_not_chargeable" as const,
              }
            : {}),
        });
        const maySubmit = await ctx.runMutation(
          internal.media_jobs.beginSubmission,
          { ownerId, ownerGeneration, jobId },
        );
        if (!maySubmit) {
          return errorResponse(
            409,
            "Music generation was canceled before provider submission.",
            origin,
          );
        }
        const physicalDispatch = createMediaProviderDispatch(ctx, {
          ownerId,
          ownerGeneration,
          jobId,
          dispatchId: `media:google_lyria:stream:${jobId}`,
          kind: "google_lyria",
        });
        let providerResponseConsumed = false;
        try {
          const result = await physicalDispatch.run(
            async (signal) =>
              await generateMusic({ apiKey, parsedBody, signal }),
          );
          providerResponseConsumed = true;
          const completion = await ctx.runMutation(
            internal.media_jobs.markGenerated,
            {
              jobId,
              ownerGeneration,
              upstreamStatus: "OK",
              // The HTTP response carries the audio bytes. Persist only a
              // bounded completion summary so the durable receipt transaction
              // never approaches Convex's document/argument size limit.
              output: {
                audio: {
                  mimeType: result.audio.mimeType,
                  streamedToCaller: true,
                  base64Chars: result.audio.data.length,
                },
                promptLabel: result.promptLabel,
                textParts: result.textParts
                  .slice(0, 16)
                  .map((part) => part.slice(0, 2_048)),
              },
              ...(billable
                ? {
                    billing: {
                      endpointId: LYRIA_ENDPOINT_ID,
                      billingUnit: "request" as const,
                      unitPriceUsd: LYRIA_USD_PER_SONG,
                      quantity: 1,
                      costMicroCents: dollarsToMicroCents(LYRIA_USD_PER_SONG),
                      meteredFrom: "request" as const,
                      note: "Lyria 3 Pro Preview: $0.08 per generated song.",
                    },
                  }
                : {}),
            },
          );
          await physicalDispatch.settle();
          if (completion.billingDisposition === "unknown") {
            return errorResponse(
              502,
              "Music was generated, but its billing metadata could not be reconciled. The output was retained without being published.",
              origin,
            );
          }

          return withCors(
            Response.json(result, {
              status: 200,
            }),
            origin,
          );
        } catch (error) {
          if (
            providerResponseConsumed ||
            !physicalDispatch.providerMayHaveStarted()
          ) {
            await physicalDispatch.settle().catch(() => false);
          } else {
            await physicalDispatch.abandon().catch(() => false);
          }
          await ctx
            .runMutation(internal.media_jobs.markSubmissionFailed, {
              jobId,
              ownerGeneration,
              upstreamStatus: "ERROR",
              error: {
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to generate music.",
              },
            })
            .catch(() => null);
          console.error("[music-generate] Failed to generate music.", {
            message:
              error instanceof Error
                ? error.message
                : "Failed to generate music.",
          });
          return errorResponse(
            502,
            error instanceof Error
              ? error.message
              : "Failed to generate music.",
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: MUSIC_KEY_PATH,
    method: "POST",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) =>
        errorResponse(
          410,
          "Music API keys are no longer exposed to clients. Use /api/music/stream instead.",
          origin,
        ),
      ),
    ),
  });
};
