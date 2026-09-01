import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  errorResponse,
  handleCorsRequest,
  jsonResponse,
  registerCorsOptions,
  withCors,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";
import {
  listMediaCapabilities,
  resolveMediaCapability,
  type MediaCapability,
} from "../media_catalog";
import {
  createMediaGenerateAcceptedResponse,
  createMediaJobError,
  type MediaJobStatus,
  parseMediaGenerateRequest,
} from "../media_contract";
import {
  MAX_PRIVATE_MEDIA_PAYLOAD_CHARS,
  PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
  falSubmissionDispatchId,
  summarizeMediaRequestForStorage,
} from "../media_jobs";
import {
  buildFalResponseUrl,
  fetchFalResultPayload,
  getFalApiKey,
  isDefinitiveFalSubmissionRejection,
  submitFalRequest,
  verifyFalWebhookSignature,
} from "../media_fal_webhooks";
import { hashSha256Hex } from "../lib/crypto_utils";
import { getUserProviderKey } from "../lib/provider_keys";
import { isRecord } from "../shared_validators";
import {
  getMediaBillingAdmissionIssue,
  meterCompletedMediaJob,
} from "../media_billing";
import {
  generateMusic,
  LYRIA_MUSIC_ENDPOINT_ID,
  parseMusicStreamRequest,
} from "../media_lyria";
import { checkManagedUsageLimit } from "../lib/managed_billing";
import {
  getManagedGatewayConfig,
  resolveManagedGatewayApiKey,
} from "../lib/managed_gateway";
import { transcribeOpenRouterSpeechToText } from "../media_openrouter_stt";
import { capabilityForMediaCapabilityId } from "../capability_contract";
import { dollarsToMicroCents } from "../lib/billing_money";
import { requireSignedInAccountAction } from "../http_shared/auth";
import { requireCapabilityAction } from "../http_shared/capability";
import { encryptSecret } from "../data/secrets_crypto";
import {
  MAX_MANAGED_IMAGE_REQUEST_BYTES,
  validateManagedImageReferenceEnvelope,
} from "../media_image_limits";
import {
  readRequestTextBounded,
  RequestBodyLimitError,
} from "../http_shared/bounded_request_body";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
import { createMediaProviderDispatch } from "../lib/media_provider_dispatch";

const MEDIA_API_BASE_PATH = "/api/media/v1";
const MEDIA_CAPABILITIES_PATH = `${MEDIA_API_BASE_PATH}/capabilities`;
const MEDIA_GENERATE_PATH = `${MEDIA_API_BASE_PATH}/generate`;
const MEDIA_JOB_PATH = `${MEDIA_API_BASE_PATH}/job`;
const MEDIA_FAL_WEBHOOK_PATH = `${MEDIA_API_BASE_PATH}/webhooks/fal`;
const MEDIA_SUBSCRIPTION_QUERY = "api.media_jobs.getByJobId";

/**
 * Public agent-facing docs are served from the marketing site, not from the
 * backend. The backend just points callers at the right URL.
 *
 * Pages live at /docs/media (overview) and /docs/media/{images,video,audio,music,3d}.
 * See `packages/website/src/lib/media-docs.ts` for the source content.
 */
const MEDIA_DOCS_URL = "https://stella.sh/docs/media";

const MEDIA_RATE_LIMIT = 20;
const MEDIA_RATE_WINDOW_MS = 5 * 60_000;
const MEDIA_DENY_BUFFER_MICRO_CENTS = dollarsToMicroCents(0.8);
const MEDIA_IDEMPOTENCY_MAX_LENGTH = 200;

const MEDIA_AUTH_REQUIRED_MESSAGE =
  "Sign in to Stella to use media generation.";
const MEDIA_AUTH_REQUIRED_ACTION =
  "Ask the user to open the Stella desktop app and finish signing in (Settings → Account, or the welcome screen on first launch). Once they're signed in, retry the same request — no payload changes needed.";

const ownerFenceErrorCode = (error: unknown): string | null =>
  error instanceof ConvexError &&
  typeof error.data === "object" &&
  error.data !== null &&
  typeof (error.data as { code?: unknown }).code === "string"
    ? (error.data as { code: string }).code
    : null;

const isOwnerFenceError = (error: unknown): boolean => {
  const code = ownerFenceErrorCode(error);
  return (
    code === "OWNER_DATA_PURGE_ACTIVE" ||
    code === "OWNER_DATA_GENERATION_STALE" ||
    code === "OWNERSHIP_MIGRATED"
  );
};

const assertMediaProviderDispatchAllowed = async (
  ctx: Pick<ActionCtx, "runMutation">,
  ownerId: string,
  ownerGeneration: string,
) => {
  await ctx.runMutation(
    internal.media_jobs.assertMediaProviderDispatchAllowed,
    { ownerId, ownerGeneration },
  );
};

type FalWebhookPayload = {
  request_id?: unknown;
  gateway_request_id?: unknown;
  status?: unknown;
  payload?: unknown;
  payload_error?: unknown;
  error?: unknown;
  error_type?: unknown;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const asTrimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const hasAspectRatioSupport = (capability: MediaCapability): boolean =>
  capability.supportsAspectRatio === true;

/**
 * Maps a Stella-style aspect ratio (e.g. "16:9") to a {width, height} pair
 * sized to satisfy the GPT Image 2 input constraints:
 *   - width and height are multiples of 16
 *   - max edge ≤ 3840
 *   - 655,360 ≤ width × height ≤ 8,294,400
 *   - longest edge ≤ 3× shortest edge
 *
 * Anything we don't recognize maps to undefined so the upstream default
 * (`landscape_4_3`) kicks in instead of us hard-failing the request.
 */
const GPT_IMAGE_2_ASPECT_PRESETS: Record<
  string,
  { width: number; height: number }
> = {
  "1:1": { width: 1024, height: 1024 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
  "3:2": { width: 1152, height: 768 },
  "2:3": { width: 768, height: 1152 },
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "21:9": { width: 1344, height: 576 },
};

const isGptImage2Endpoint = (endpointId: string): boolean =>
  endpointId === "openai/gpt-image-2" ||
  endpointId === "openai/gpt-image-2/edit";

const applyCapabilityDefaults = (args: {
  capability: MediaCapability;
  input: Record<string, unknown>;
}): Record<string, unknown> => {
  const normalized = { ...args.input };
  if (
    (args.capability.id === "text_to_image" ||
      args.capability.id === "image_edit") &&
    normalized.quality === undefined
  ) {
    normalized.quality = "low";
  }
  if (args.capability.category === "video") {
    normalized.duration ??= 5;
    normalized.resolution ??= "768P";
    normalized.prompt_expansion_mode ??= "balanced";
  }
  return normalized;
};

/**
 * Endpoint-specific final pass after all the convenience-field merging is
 * done. This is where we translate from the gateway's neutral schema (e.g.
 * `aspect_ratio`) into whatever shape a particular upstream model expects
 * (e.g. GPT Image 2's `image_size`). Keeping this separate from
 * `applyCapabilityDefaults` means it sees the *final* merged input.
 */
const applyEndpointTransforms = (args: {
  capability: MediaCapability;
  input: Record<string, unknown>;
}): Record<string, unknown> => {
  const normalized = { ...args.input };
  const targetsGptImage2 = isGptImage2Endpoint(args.capability.endpointId);
  if (targetsGptImage2 && typeof normalized.aspect_ratio === "string") {
    if (normalized.image_size === undefined) {
      const mapped = GPT_IMAGE_2_ASPECT_PRESETS[normalized.aspect_ratio.trim()];
      if (mapped) {
        normalized.image_size = mapped;
      }
    }
    delete normalized.aspect_ratio;
  }
  if (
    targetsGptImage2 &&
    args.capability.id === "text_to_image" &&
    normalized.image_size === undefined
  ) {
    normalized.image_size = "auto";
  }
  return normalized;
};

const isHttpUrl = (value: unknown): value is string => {
  if (!isNonEmptyString(value)) {
    return false;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const isDataUri = (value: unknown): value is string =>
  isNonEmptyString(value) && /^data:[^;,\s]+;base64,/i.test(value);

const isMediaSourceReference = (value: unknown): value is string =>
  isHttpUrl(value) || isDataUri(value);

const isMimeType = (value: unknown): value is string =>
  isNonEmptyString(value) &&
  /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value.trim());

const normalizeBase64Payload = (value: string): string =>
  value.replace(/^data:[^;,\s]+;base64,/i, "").replace(/\s+/g, "");

const isValidBase64Payload = (value: unknown): value is string => {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const normalized = normalizeBase64Payload(value);
  // Only validate a small prefix — decoding multi-MB payloads crashes the runtime.
  const sample = normalized.slice(0, 256);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sample)) {
    return false;
  }
  try {
    atob(sample);
    return true;
  } catch {
    return false;
  }
};

const toMediaSourceDataUri = (args: {
  mimeType: string;
  base64: string;
}): string =>
  `data:${args.mimeType};base64,${normalizeBase64Payload(args.base64)}`;

const SOURCE_SLOT_ALIASES: Record<string, string> = {
  image: "image_url",
  video: "video_url",
  audio: "audio_url",
  reference_image: "reference_image_urls",
  reference_video: "reference_video_urls",
  reference_audio: "reference_audio_urls",
  mask_image: "mask_image_url",
};

const REFERENCE_VIDEO_SOURCE_SLOT_ALIASES: Record<string, string> = {
  image: "reference_image_urls",
  video: "reference_video_urls",
  audio: "reference_audio_urls",
};

const normalizeSourceReference = (
  value:
    | string
    | {
        base64: string;
        mimeType: string;
        fileName?: string;
      },
): string =>
  typeof value === "string"
    ? value.trim()
    : toMediaSourceDataUri({ mimeType: value.mimeType, base64: value.base64 });

const toMediaJobStatus = (upstreamStatus: string): MediaJobStatus => {
  switch (upstreamStatus.trim().toUpperCase()) {
    case "IN_QUEUE":
    case "PENDING":
    case "QUEUED":
      return "queued";
    case "COMPLETED":
    case "OK":
      return "succeeded";
    case "FAILED":
    case "ERROR":
    case "PAYLOAD_ERROR":
      return "failed";
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    default:
      return "running";
  }
};

export const applyConvenienceInput = (args: {
  capability: MediaCapability;
  input: Record<string, unknown>;
  prompt?: string;
  aspectRatio?: string;
  sourceUrl?: string;
  source?:
    | string
    | {
        base64: string;
        mimeType: string;
        fileName?: string;
      };
  sources?: Record<
    string,
    | string
    | {
        base64: string;
        mimeType: string;
        fileName?: string;
      }
  >;
}): Record<string, unknown> => {
  let normalized = applyCapabilityDefaults(args);
  if (
    args.prompt &&
    args.capability.promptKey &&
    normalized[args.capability.promptKey] === undefined
  ) {
    normalized[args.capability.promptKey] = args.prompt;
  }
  if (args.capability.id === "text_to_music") {
    normalized = createLyriaInput({ prompt: args.prompt, input: normalized });
  }
  if (
    args.aspectRatio &&
    hasAspectRatioSupport(args.capability) &&
    normalized.aspect_ratio === undefined
  ) {
    normalized.aspect_ratio = args.aspectRatio;
  }
  const rawSourceValue =
    args.sourceUrl ??
    (args.source ? normalizeSourceReference(args.source) : undefined);
  if (
    rawSourceValue &&
    args.capability.sourceUrlKey &&
    normalized[args.capability.sourceUrlKey] === undefined
  ) {
    normalized[args.capability.sourceUrlKey] =
      args.capability.sourceUrlKey.endsWith("_urls")
        ? [rawSourceValue]
        : rawSourceValue;
  }
  if (args.sources) {
    for (const [key, value] of Object.entries(args.sources)) {
      const slot =
        (args.capability.id === "reference_to_video"
          ? REFERENCE_VIDEO_SOURCE_SLOT_ALIASES[key]
          : undefined) ??
        SOURCE_SLOT_ALIASES[key] ??
        key;
      if (normalized[slot] === undefined) {
        const source = normalizeSourceReference(value);
        normalized[slot] = slot.endsWith("_urls") ? [source] : source;
      }
    }
  }
  return applyEndpointTransforms({
    capability: args.capability,
    input: normalized,
  });
};

const requireCapabilityInputs = (args: {
  capability: MediaCapability;
  prompt?: string;
  aspectRatio?: string;
  sourceUrl?: string;
  source?:
    | {
        base64: string;
        mimeType: string;
        fileName?: string;
      }
    | string;
  sources?: Record<
    string,
    | string
    | {
        base64: string;
        mimeType: string;
        fileName?: string;
      }
  >;
  input: Record<string, unknown>;
  managedImageEnvelope?: boolean;
}): string | null => {
  const normalized = applyConvenienceInput(args);
  const validateSource = (
    label: string,
    value:
      | string
      | {
          base64: string;
          mimeType: string;
          fileName?: string;
        },
  ): string | null => {
    if (typeof value === "string") {
      return isMediaSourceReference(value)
        ? null
        : `${label} must be a valid http(s) URL or data URI`;
    }
    if (!isMimeType(value.mimeType))
      return `${label}.mimeType must be a valid MIME type`;
    if (!isValidBase64Payload(value.base64))
      return `${label}.base64 must be valid base64`;
    return null;
  };
  if (args.source) {
    const error = validateSource("source", args.source);
    if (error) return error;
  }
  if (args.sources) {
    for (const [key, value] of Object.entries(args.sources)) {
      const error = validateSource(`sources.${key}`, value);
      if (error) return error;
    }
  }
  if (args.aspectRatio !== undefined && !isNonEmptyString(args.aspectRatio)) {
    return "aspectRatio must be a non-empty string";
  }
  if (
    args.capability.promptKey &&
    !isNonEmptyString(normalized[args.capability.promptKey])
  ) {
    return "prompt is required for this capability";
  }
  if (args.managedImageEnvelope) {
    const managedReferenceError = validateManagedImageReferenceEnvelope(
      args.capability.id,
      normalized,
    );
    if (managedReferenceError) return managedReferenceError;
  }
  const sourceSlotValue = args.capability.sourceUrlKey
    ? normalized[args.capability.sourceUrlKey]
    : undefined;
  const sourceSlotRef = Array.isArray(sourceSlotValue)
    ? sourceSlotValue[0]
    : sourceSlotValue;
  if (args.capability.id === "reference_to_video") {
    const referenceImages = Array.isArray(normalized.reference_image_urls)
      ? normalized.reference_image_urls
      : [];
    const referenceVideos = Array.isArray(normalized.reference_video_urls)
      ? normalized.reference_video_urls
      : [];
    const referenceAudio = Array.isArray(normalized.reference_audio_urls)
      ? normalized.reference_audio_urls
      : [];
    const references = [
      ...referenceImages,
      ...referenceVideos,
      ...referenceAudio,
    ];
    if (referenceImages.length === 0 && referenceVideos.length === 0) {
      return "reference_to_video requires at least one reference image or video";
    }
    if (references.length > 12) {
      return "reference_to_video accepts at most 12 reference files";
    }
    if (!references.every(isMediaSourceReference)) {
      return "reference_to_video references must be valid http(s) URLs or data URIs";
    }
  }
  if (
    args.capability.requiresSourceUrl &&
    (!args.capability.sourceUrlKey || !isMediaSourceReference(sourceSlotRef))
  ) {
    return "A valid http(s) sourceUrl or source.base64 input is required for this capability";
  }
  if (
    args.capability.sourceUrlKey &&
    sourceSlotRef !== undefined &&
    !isMediaSourceReference(sourceSlotRef)
  ) {
    return "sourceUrl must be a valid http(s) URL or data URI";
  }
  if (args.capability.id === "text_to_music") {
    const parsedMusic = parseMusicStreamRequest(normalized);
    if (!parsedMusic) {
      return "weightedPrompts and musicGenerationConfig are required for this capability";
    }
  }
  return null;
};

const createLyriaInput = (args: {
  prompt?: string;
  input: Record<string, unknown>;
}): Record<string, unknown> => {
  const input = { ...args.input };
  if (!Array.isArray(input.weightedPrompts) && args.prompt) {
    input.weightedPrompts = [{ text: args.prompt, weight: 1 }];
  }
  if (!isRecord(input.musicGenerationConfig)) {
    input.musicGenerationConfig = {
      bpm: 95,
      density: 0.5,
      brightness: 0.5,
      guidance: 4,
      temperature: 1,
    };
  }
  return input;
};

export const registerMediaRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, [
    MEDIA_CAPABILITIES_PATH,
    MEDIA_GENERATE_PATH,
    MEDIA_JOB_PATH,
    MEDIA_FAL_WEBHOOK_PATH,
  ]);

  http.route({
    path: MEDIA_CAPABILITIES_PATH,
    method: "GET",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) =>
        jsonResponse(
          { data: listMediaCapabilities(), docsUrl: MEDIA_DOCS_URL },
          200,
          origin,
        ),
      ),
    ),
  });

  http.route({
    path: MEDIA_JOB_PATH,
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: MEDIA_AUTH_REQUIRED_MESSAGE,
          action: MEDIA_AUTH_REQUIRED_ACTION,
          docsUrl: MEDIA_DOCS_URL,
          realm: "stella-media",
        });
        if (!auth.ok) return auth.response;
        const { generation: ownerGeneration } =
          await assertOwnerDataAccessActive(ctx, auth.ownerId);

        const url = new URL(request.url);
        let jobId = asTrimmedString(url.searchParams.get("jobId"));
        const clientRequestKey = asTrimmedString(
          url.searchParams.get("clientRequestKey"),
        );
        const requestHash = asTrimmedString(
          url.searchParams.get("requestHash"),
        );
        if (!jobId && clientRequestKey && requestHash) {
          const existing = await ctx.runQuery(
            internal.media_jobs.getByOwnerClientRequestKey,
            { ownerId: auth.ownerId, ownerGeneration, clientRequestKey },
          );
          if (!existing) {
            return errorResponse(404, "Media request not found.", origin);
          }
          if (existing.clientRequestHash !== requestHash) {
            return errorResponse(
              409,
              "Idempotency-Key was used with a different media request hash.",
              origin,
            );
          }
          jobId = existing.jobId;
        }
        if (!jobId) {
          return errorResponse(
            400,
            "Missing jobId or clientRequestKey/requestHash.",
            origin,
          );
        }

        const job = await ctx.runQuery(internal.media_jobs.getByOwnerJobId, {
          ownerId: auth.ownerId,
          ownerGeneration,
          jobId,
        });
        if (!job) {
          return errorResponse(404, "Media job not found.", origin);
        }

        return jsonResponse(job, 200, origin);
      }),
    ),
  });

  http.route({
    path: MEDIA_JOB_PATH,
    method: "DELETE",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: MEDIA_AUTH_REQUIRED_MESSAGE,
          action: MEDIA_AUTH_REQUIRED_ACTION,
          docsUrl: MEDIA_DOCS_URL,
          realm: "stella-media",
        });
        if (!auth.ok) return auth.response;
        const { generation: ownerGeneration } =
          await assertOwnerDataAccessActive(ctx, auth.ownerId);

        const clientRequestKey = request.headers.get("idempotency-key")?.trim();
        if (!clientRequestKey) {
          return errorResponse(
            400,
            "Idempotency-Key is required to cancel a media request.",
            origin,
          );
        }
        if (clientRequestKey.length > MEDIA_IDEMPOTENCY_MAX_LENGTH) {
          return errorResponse(
            400,
            `Idempotency-Key must be at most ${MEDIA_IDEMPOTENCY_MAX_LENGTH} characters.`,
            origin,
          );
        }

        const canceled = await ctx.runMutation(
          internal.media_jobs.cancelIdempotentRequest,
          {
            ownerId: auth.ownerId,
            ownerGeneration,
            clientRequestKey,
            canceledAt: Date.now(),
          },
        );
        if (
          "submissionPayloadStorageId" in canceled &&
          canceled.submissionPayloadStorageId
        ) {
          await ctx.runMutation(
            internal.media_jobs.makePrivateSubmissionBlobDeletable,
            {
              ownerId: auth.ownerId,
              storageId: canceled.submissionPayloadStorageId,
              ...(canceled.jobId ? { jobId: canceled.jobId } : {}),
            },
          );
        }
        const canceledJobId = "jobId" in canceled ? canceled.jobId : undefined;
        if (canceled.state === "canceled" && canceledJobId) {
          await ctx
            .runAction(
              internal.media_image_submission.cancelPurgedProviderRequest,
              { jobId: canceledJobId },
            )
            .catch((error) => {
              // The durable cancellation outbox remains authoritative and its
              // retry worker will continue after this best-effort fast path.
              console.error(
                `[media/cancel] Fal cancellation deferred for ${canceledJobId}:`,
                error,
              );
            });
        }
        return jsonResponse(canceled, 200, origin);
      }),
    ),
  });

  http.route({
    path: MEDIA_GENERATE_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: MEDIA_AUTH_REQUIRED_MESSAGE,
          action: MEDIA_AUTH_REQUIRED_ACTION,
          docsUrl: MEDIA_DOCS_URL,
          realm: "stella-media",
        });
        if (!auth.ok) return auth.response;
        const ownerId = auth.ownerId;
        const { generation: ownerGeneration } =
          await assertOwnerDataAccessActive(ctx, ownerId);
        const clientRequestKey = request.headers.get("idempotency-key")?.trim();
        if (
          clientRequestKey &&
          clientRequestKey.length > MEDIA_IDEMPOTENCY_MAX_LENGTH
        ) {
          return errorResponse(
            400,
            `Idempotency-Key must be at most ${MEDIA_IDEMPOTENCY_MAX_LENGTH} characters.`,
            origin,
          );
        }

        let rawRequestBody = "";
        let requestBody: unknown = null;
        try {
          // Durable image_gen requests are identifiable before body access by
          // their required idempotency key, so their strict ingress cap does
          // not silently alter legacy video/audio/3D request semantics on this
          // shared endpoint.
          rawRequestBody = clientRequestKey
            ? await readRequestTextBounded(
                request,
                MAX_MANAGED_IMAGE_REQUEST_BYTES,
              )
            : await request.text();
          requestBody = rawRequestBody ? JSON.parse(rawRequestBody) : null;
        } catch (error) {
          if (error instanceof RequestBodyLimitError) {
            return errorResponse(error.status, error.message, origin);
          }
          requestBody = null;
        }
        try {
          const body = parseMediaGenerateRequest(requestBody);
          if (!body)
            return errorResponse(
              400,
              "Invalid media generation JSON body",
              origin,
            );
          const resolved = resolveMediaCapability(body.capability);
          if (!resolved)
            return errorResponse(
              400,
              `Unknown capability. See ${MEDIA_DOCS_URL}.`,
              origin,
            );
          const validationError = requireCapabilityInputs({
            capability: resolved.capability,
            prompt: body.prompt,
            aspectRatio: body.aspectRatio,
            sourceUrl: body.sourceUrl,
            source: body.source,
            sources: body.sources,
            input: body.input,
            managedImageEnvelope: Boolean(clientRequestKey),
          });
          if (validationError)
            return errorResponse(400, validationError, origin);
          const submissionInput = applyConvenienceInput({
            capability: resolved.capability,
            input: body.input,
            prompt: body.prompt,
            aspectRatio: body.aspectRatio,
            sourceUrl: body.sourceUrl,
            source: body.source,
            sources: body.sources,
          });
          const storedRequest = summarizeMediaRequestForStorage({
            ...body,
            input: submissionInput,
          });
          const clientRequestHash = clientRequestKey
            ? await hashSha256Hex(rawRequestBody)
            : undefined;

          if (clientRequestKey && clientRequestHash) {
            const existing = await ctx.runQuery(
              internal.media_jobs.getByOwnerClientRequestKey,
              { ownerId, ownerGeneration, clientRequestKey },
            );
            if (existing) {
              if (existing.clientRequestHash !== clientRequestHash) {
                return errorResponse(
                  409,
                  "Idempotency-Key was already used with a different media request.",
                  origin,
                );
              }
              return jsonResponse(
                createMediaGenerateAcceptedResponse({
                  jobId: existing.jobId,
                  capability: existing.capability,
                  status: existing.status,
                  upstreamStatus: existing.upstreamStatus,
                  reattached: true,
                  subscription: {
                    query: MEDIA_SUBSCRIPTION_QUERY,
                    args: { jobId: existing.jobId },
                  },
                }),
                202,
                origin,
              );
            }
          }

          // Reattachments above bypass admission and rate limiting: they do
          // not allocate new provider work or usage. Only a fresh reservation
          // consumes the media-generation rate budget.
          //
          // Entitlement first, then budget: a Go user asking for video should
          // be told video is a Pro surface, not that they are out of credit.
          // `capabilityForMediaCapabilityId` returns null for the non-
          // generative entries (speech-to-text, stem separation), which stay
          // open to every plan.
          const requiredCapability = capabilityForMediaCapabilityId(
            resolved.capability.id,
          );
          if (requiredCapability) {
            const capabilityCheck = await requireCapabilityAction(
              ctx,
              ownerId,
              requiredCapability,
              origin,
              { docsUrl: MEDIA_DOCS_URL },
            );
            if (!capabilityCheck.ok) return capabilityCheck.response;
          }
          const subscriptionCheck = await checkManagedUsageLimit(ctx, ownerId, {
            minimumRemainingMicroCents: MEDIA_DENY_BUFFER_MICRO_CENTS,
          });
          if (!subscriptionCheck.allowed)
            return errorResponse(429, subscriptionCheck.message, origin);
          const rateLimit = await ctx.runMutation(
            internal.rate_limits.consumeWebhookRateLimit,
            {
              scope: "media_generate",
              key: ownerId,
              limit: MEDIA_RATE_LIMIT,
              windowMs: MEDIA_RATE_WINDOW_MS,
              blockMs: MEDIA_RATE_WINDOW_MS,
            },
          );
          if (!rateLimit.allowed)
            return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);

          const billingAdmissionIssue = getMediaBillingAdmissionIssue({
            endpointId: resolved.endpoint.endpointId,
            request: storedRequest,
          });
          if (billingAdmissionIssue) {
            return errorResponse(
              503,
              `Media billing is not configured for ${resolved.endpoint.endpointId}: ${billingAdmissionIssue}`,
              origin,
            );
          }
          const provider = resolved.endpoint.provider;
          const falApiKey = provider === "fal" ? getFalApiKey() : null;
          const openRouterApiKey =
            provider === "openrouter"
              ? (resolveManagedGatewayApiKey(
                  getManagedGatewayConfig("openrouter"),
                ) ?? null)
              : null;
          if (provider === "fal" && !falApiKey)
            return errorResponse(
              503,
              "Media generation is not configured yet.",
              origin,
            );
          if (provider === "openrouter" && !openRouterApiKey)
            return errorResponse(
              503,
              "Speech-to-text is not configured yet.",
              origin,
            );

          const jobId = clientRequestKey
            ? `img_${(
                await hashSha256Hex(
                  `media-job:v2:${ownerId}:${ownerGeneration}:${clientRequestKey}`,
                )
              ).slice(0, 40)}`
            : crypto.randomUUID();
          if (clientRequestKey && clientRequestHash) {
            const isDurableFalImage =
              resolved.endpoint.provider === "fal" &&
              ["text_to_image", "image_edit"].includes(resolved.capability.id);
            let submissionPayloadManifestId: string | undefined;
            if (isDurableFalImage) {
              const encrypted = await encryptSecret(
                JSON.stringify({
                  input: submissionInput,
                  webhookUrl: `${new URL(MEDIA_FAL_WEBHOOK_PATH, request.url).toString()}?jobId=${encodeURIComponent(jobId)}&ownerGeneration=${encodeURIComponent(ownerGeneration)}`,
                }),
              );
              const encryptedSubmissionPayload = JSON.stringify(encrypted);
              if (
                encryptedSubmissionPayload.length < 1 ||
                encryptedSubmissionPayload.length >
                  MAX_PRIVATE_MEDIA_PAYLOAD_CHARS
              ) {
                return errorResponse(
                  413,
                  "Encrypted image submission exceeds the managed payload limit.",
                  origin,
                );
              }
              submissionPayloadManifestId = `payload_${(
                await hashSha256Hex(
                  `media-payload:v2:${ownerId}:${ownerGeneration}:${clientRequestKey}:${clientRequestHash}`,
                )
              ).slice(0, 48)}`;
              const chunks = Array.from(
                {
                  length: Math.ceil(
                    encryptedSubmissionPayload.length /
                      PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
                  ),
                },
                (_, index) =>
                  encryptedSubmissionPayload.slice(
                    index * PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
                    (index + 1) * PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
                  ),
              );
              let manifestState = await ctx.runMutation(
                internal.media_jobs.createPrivatePayloadManifest,
                {
                  ownerId,
                  ownerGeneration,
                  manifestId: submissionPayloadManifestId,
                  jobId,
                  clientRequestKey,
                  expectedChunks: chunks.length,
                  totalChars: encryptedSubmissionPayload.length,
                  createdAt: Date.now(),
                },
              );
              if (manifestState === "uploading") {
                // The deterministic manifest id is also the upload lease. A
                // concurrent retry encrypts with a different nonce, so it
                // must never append its ciphertext into the first request's
                // manifest. Wait briefly for that request to finalize or
                // reserve the shared job, then reattach instead.
                const waitUntil = Date.now() + 2_000;
                while (
                  manifestState === "uploading" &&
                  Date.now() < waitUntil
                ) {
                  const existingJob = await ctx.runQuery(
                    internal.media_jobs.getByOwnerClientRequestKey,
                    {
                      ownerId,
                      ownerGeneration,
                      clientRequestKey,
                    },
                  );
                  if (existingJob) {
                    return jsonResponse(
                      createMediaGenerateAcceptedResponse({
                        jobId: existingJob.jobId,
                        capability: existingJob.capability,
                        status: existingJob.status,
                        upstreamStatus: existingJob.upstreamStatus,
                        reattached: true,
                        subscription: {
                          query: MEDIA_SUBSCRIPTION_QUERY,
                          args: { jobId: existingJob.jobId },
                        },
                      }),
                      202,
                      origin,
                    );
                  }
                  await new Promise((resolve) => setTimeout(resolve, 25));
                  manifestState =
                    (
                      await ctx.runQuery(
                        internal.media_jobs.getPrivatePayloadManifest,
                        { manifestId: submissionPayloadManifestId },
                      )
                    )?.state ?? "pending";
                }
                if (manifestState === "uploading") {
                  return errorResponse(
                    503,
                    "An identical encrypted media upload is still being prepared; retry this request.",
                    origin,
                  );
                }
              }
              if (manifestState === "owner_purged") {
                await ctx.runMutation(
                  internal.media_jobs.makePrivatePayloadManifestDeletable,
                  { manifestId: submissionPayloadManifestId },
                );
                return errorResponse(
                  409,
                  "Media generation is unavailable while account deletion is in progress.",
                  origin,
                );
              }
              if (manifestState === "pending") {
                // Submission cleanup can flip held -> pending immediately
                // after the winning request reserves its job. Close the
                // query/manifest observation race with one final job lookup
                // before treating pending as an orphaned upload.
                const existingJob = await ctx.runQuery(
                  internal.media_jobs.getByOwnerClientRequestKey,
                  { ownerId, ownerGeneration, clientRequestKey },
                );
                if (existingJob) {
                  return jsonResponse(
                    createMediaGenerateAcceptedResponse({
                      jobId: existingJob.jobId,
                      capability: existingJob.capability,
                      status: existingJob.status,
                      upstreamStatus: existingJob.upstreamStatus,
                      reattached: true,
                      subscription: {
                        query: MEDIA_SUBSCRIPTION_QUERY,
                        args: { jobId: existingJob.jobId },
                      },
                    }),
                    202,
                    origin,
                  );
                }
                await ctx.runMutation(
                  internal.media_jobs.makePrivatePayloadManifestDeletable,
                  { manifestId: submissionPayloadManifestId },
                );
                return errorResponse(
                  503,
                  "A prior encrypted media upload is being cleaned up; retry this request.",
                  origin,
                );
              }
              if (manifestState === "created") {
                for (let index = 0; index < chunks.length; index += 1) {
                  const appendState = await ctx.runMutation(
                    internal.media_jobs.appendPrivatePayloadChunk,
                    {
                      ownerId,
                      ownerGeneration,
                      manifestId: submissionPayloadManifestId,
                      index,
                      data: chunks[index]!,
                      writtenAt: Date.now(),
                    },
                  );
                  if (appendState === "owner_purged") {
                    await ctx.runMutation(
                      internal.media_jobs.makePrivatePayloadManifestDeletable,
                      { manifestId: submissionPayloadManifestId },
                    );
                    return errorResponse(
                      409,
                      "Media generation is unavailable while account deletion is in progress.",
                      origin,
                    );
                  }
                }
                const finalized = await ctx.runMutation(
                  internal.media_jobs.finalizePrivatePayloadManifest,
                  {
                    ownerId,
                    ownerGeneration,
                    manifestId: submissionPayloadManifestId,
                    finalizedAt: Date.now(),
                  },
                );
                if (finalized === "owner_purged") {
                  await ctx.runMutation(
                    internal.media_jobs.makePrivatePayloadManifestDeletable,
                    { manifestId: submissionPayloadManifestId },
                  );
                  return errorResponse(
                    409,
                    "Media generation is unavailable while account deletion is in progress.",
                    origin,
                  );
                }
              }
            }
            const reservation = await ctx
              .runMutation(internal.media_jobs.reserveIdempotentJob, {
                ownerId,
                ownerGeneration,
                jobId,
                clientRequestKey,
                clientRequestHash,
                capability: resolved.capability.id,
                profile: resolved.endpoint.id,
                provider: resolved.endpoint.provider,
                endpointId: resolved.endpoint.endpointId,
                request: storedRequest,
                ...(body.connectorRequestId
                  ? { connectorRequestId: body.connectorRequestId }
                  : {}),
                ...(submissionPayloadManifestId
                  ? { submissionPayloadManifestId }
                  : {}),
              })
              .catch(async (error) => {
                if (submissionPayloadManifestId) {
                  await ctx.runMutation(
                    internal.media_jobs.makePrivatePayloadManifestDeletable,
                    { manifestId: submissionPayloadManifestId },
                  );
                }
                throw error;
              });
            if (reservation.state === "owner_purged") {
              return errorResponse(
                409,
                "Media generation is unavailable while account deletion is in progress.",
                origin,
              );
            }
            if (reservation.state === "canceled") {
              return errorResponse(
                409,
                "This media request was canceled before submission.",
                origin,
              );
            }
            if (reservation.state === "conflict") {
              return errorResponse(
                409,
                "Idempotency-Key was already used with a different media request.",
                origin,
              );
            }
            if (reservation.state === "existing") {
              return jsonResponse(
                createMediaGenerateAcceptedResponse({
                  jobId: reservation.jobId,
                  capability: reservation.capability,
                  status: reservation.status,
                  upstreamStatus: reservation.upstreamStatus,
                  reattached: true,
                  subscription: {
                    query: MEDIA_SUBSCRIPTION_QUERY,
                    args: { jobId: reservation.jobId },
                  },
                }),
                202,
                origin,
              );
            }
            if (isDurableFalImage) {
              return jsonResponse(
                createMediaGenerateAcceptedResponse({
                  jobId,
                  capability: resolved.capability.id,
                  status: "queued",
                  upstreamStatus: "IN_QUEUE",
                  subscription: {
                    query: MEDIA_SUBSCRIPTION_QUERY,
                    args: { jobId },
                  },
                }),
                202,
                origin,
              );
            }
          } else {
            await ctx.runMutation(internal.media_jobs.createJob, {
              ownerId,
              ownerGeneration,
              jobId,
              capability: resolved.capability.id,
              profile: resolved.endpoint.id,
              provider: resolved.endpoint.provider,
              endpointId: resolved.endpoint.endpointId,
              request: storedRequest,
              ...(body.connectorRequestId
                ? { connectorRequestId: body.connectorRequestId }
                : {}),
            });
          }

          const maySubmit = await ctx.runMutation(
            internal.media_jobs.beginSubmission,
            { ownerId, ownerGeneration, jobId },
          );
          if (!maySubmit) {
            return errorResponse(
              409,
              "This media request was canceled before submission.",
              origin,
            );
          }

          if (provider === "google_lyria") {
            const parsedMusic = parseMusicStreamRequest(submissionInput);
            if (!parsedMusic) {
              await ctx.runMutation(internal.media_jobs.markSubmissionFailed, {
                jobId,
                ownerGeneration,
                upstreamStatus: "ERROR",
                error: {
                  message:
                    "weightedPrompts and musicGenerationConfig are required for this capability.",
                },
              });
              return errorResponse(
                400,
                "weightedPrompts and musicGenerationConfig are required for this capability.",
                origin,
              );
            }
            const userProvidedApiKey = await getUserProviderKey(
              ctx,
              ownerId,
              "llm:google",
            );
            const apiKey =
              userProvidedApiKey ?? process.env.GOOGLE_AI_API_KEY ?? null;
            if (!apiKey) {
              await ctx.runMutation(internal.media_jobs.markSubmissionFailed, {
                jobId,
                ownerGeneration,
                upstreamStatus: "ERROR",
                error: {
                  message:
                    "No Google AI API key configured. Add one in Settings or contact your administrator.",
                },
              });
              return errorResponse(
                503,
                "No Google AI API key configured. Add one in Settings or contact your administrator.",
                origin,
              );
            }
            if (userProvidedApiKey) {
              await ctx.runMutation(
                internal.media_jobs.markJobUserProvidedKeyNotChargeableInternal,
                {
                  jobId,
                  ownerGeneration,
                  markedAt: Date.now(),
                },
              );
            }
            const physicalDispatch = createMediaProviderDispatch(ctx, {
              ownerId,
              ownerGeneration,
              jobId,
              dispatchId: `media:google_lyria:${jobId}`,
              kind: "google_lyria",
            });
            let providerResponseConsumed = false;
            try {
              const result = await physicalDispatch.run(
                async (signal) =>
                  await generateMusic({
                    apiKey,
                    parsedBody: parsedMusic,
                    signal,
                  }),
              );
              providerResponseConsumed = true;
              const audioBytes = Uint8Array.from(
                atob(result.audio.data),
                (char) => char.charCodeAt(0),
              );
              const storageId = await ctx.storage.store(
                new Blob([audioBytes], { type: result.audio.mimeType }),
              );
              const audioUrl = await ctx.storage.getUrl(storageId);
              if (!audioUrl) {
                throw new Error(
                  "Failed to create a downloadable URL for the music clip.",
                );
              }
              const output = {
                audio: {
                  url: audioUrl,
                  mimeType: result.audio.mimeType,
                },
                promptLabel: result.promptLabel,
                textParts: result.textParts,
              };
              const billing = userProvidedApiKey
                ? null
                : meterCompletedMediaJob({
                    endpointId: LYRIA_MUSIC_ENDPOINT_ID,
                    request: storedRequest,
                    output,
                  });
              const meteredBilling =
                billing && !("supported" in billing) ? billing : undefined;
              if (billing && "supported" in billing) {
                console.error(
                  `[media/generate] Failed to meter Lyria: ${billing.reason}`,
                );
              }
              const completion = await ctx.runMutation(
                internal.media_jobs.markGenerated,
                {
                  jobId,
                  ownerGeneration,
                  upstreamStatus: "OK",
                  output: output as never,
                  ...(meteredBilling
                    ? { billing: meteredBilling as never }
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
              const accepted = createMediaGenerateAcceptedResponse({
                jobId,
                capability: resolved.capability.id,
                status: "succeeded",
                upstreamStatus: "OK",
                subscription: {
                  query: MEDIA_SUBSCRIPTION_QUERY,
                  args: { jobId },
                },
              });
              return jsonResponse({ ...accepted, output }, 202, origin);
            } catch (error) {
              if (
                providerResponseConsumed ||
                !physicalDispatch.providerMayHaveStarted()
              ) {
                await physicalDispatch.settle().catch(() => false);
              } else {
                await physicalDispatch.abandon().catch(() => false);
              }
              if (isOwnerFenceError(error)) {
                return errorResponse(
                  409,
                  "Media generation was canceled because the account data generation changed.",
                  origin,
                );
              }
              await ctx.runMutation(internal.media_jobs.markSubmissionFailed, {
                jobId,
                ownerGeneration,
                upstreamStatus: "ERROR",
                error: (createMediaJobError({
                  value: (error as Error).message,
                  fallbackMessage: "Music generation failed upstream.",
                }) ?? {
                  message: "Music generation failed upstream.",
                }) as never,
              });
              return errorResponse(
                502,
                `Music generation failed: ${(error as Error).message || "Unknown error"}`,
                origin,
              );
            }
          }

          if (provider === "openrouter") {
            const physicalDispatch = createMediaProviderDispatch(ctx, {
              ownerId,
              ownerGeneration,
              jobId,
              dispatchId: `media:openrouter:${jobId}`,
              kind: "openrouter",
            });
            let providerResponseConsumed = false;
            try {
              const result = await physicalDispatch.run(
                async (signal) =>
                  await transcribeOpenRouterSpeechToText({
                    apiKey: openRouterApiKey!,
                    endpointId: resolved.endpoint.endpointId,
                    input: submissionInput,
                    signal,
                  }),
              );
              providerResponseConsumed = true;
              const output = {
                text: result.text,
                ...(result.usage ? { usage: result.usage } : {}),
              };
              const billing = meterCompletedMediaJob({
                endpointId: resolved.endpoint.endpointId,
                request: storedRequest,
                output,
              });
              const meteredBilling =
                billing && !("supported" in billing) ? billing : undefined;
              if (billing && "supported" in billing) {
                console.error(
                  `[media/generate] Failed to meter ${resolved.endpoint.endpointId}: ${billing.reason}`,
                );
              }
              const completion = await ctx.runMutation(
                internal.media_jobs.markGenerated,
                {
                  jobId,
                  ownerGeneration,
                  upstreamStatus: "OK",
                  output: output as never,
                  ...(meteredBilling
                    ? { billing: meteredBilling as never }
                    : {}),
                },
              );
              await physicalDispatch.settle();
              if (completion.billingDisposition === "unknown") {
                return errorResponse(
                  502,
                  "Transcription completed, but its billing metadata could not be reconciled. The output was retained without being published.",
                  origin,
                );
              }
              const accepted = createMediaGenerateAcceptedResponse({
                jobId,
                capability: resolved.capability.id,
                status: "succeeded",
                upstreamStatus: "OK",
                subscription: {
                  query: MEDIA_SUBSCRIPTION_QUERY,
                  args: { jobId },
                },
              });
              return jsonResponse({ ...accepted, output }, 202, origin);
            } catch (error) {
              if (
                providerResponseConsumed ||
                !physicalDispatch.providerMayHaveStarted()
              ) {
                await physicalDispatch.settle().catch(() => false);
              } else {
                await physicalDispatch.abandon().catch(() => false);
              }
              if (isOwnerFenceError(error)) {
                return errorResponse(
                  409,
                  "Media generation was canceled because the account data generation changed.",
                  origin,
                );
              }
              await ctx.runMutation(internal.media_jobs.markSubmissionFailed, {
                jobId,
                ownerGeneration,
                upstreamStatus: "ERROR",
                error: (createMediaJobError({
                  value: (error as Error).message,
                  fallbackMessage: "Speech-to-text failed upstream.",
                }) ?? {
                  message: "Speech-to-text failed upstream.",
                }) as never,
              });
              return errorResponse(
                502,
                `Speech-to-text failed: ${(error as Error).message || "Unknown error"}`,
                origin,
              );
            }
          }

          const physicalDispatch = createMediaProviderDispatch(ctx, {
            ownerId,
            ownerGeneration,
            jobId,
            dispatchId: falSubmissionDispatchId(jobId),
            kind: "fal_submit",
          });
          let providerResponseConsumed = false;
          try {
            const submitted = await physicalDispatch.run(
              async (signal) =>
                await submitFalRequest({
                  apiKey: falApiKey!,
                  endpointId: resolved.endpoint.endpointId,
                  input: submissionInput,
                  webhookUrl: `${new URL(MEDIA_FAL_WEBHOOK_PATH, request.url).toString()}?jobId=${encodeURIComponent(jobId)}&ownerGeneration=${encodeURIComponent(ownerGeneration)}`,
                  signal,
                }),
            );
            providerResponseConsumed = true;
            const submissionState = await ctx.runMutation(
              internal.media_jobs.markSubmitted,
              {
                jobId,
                ownerGeneration,
                submissionAttemptId: physicalDispatch.attemptId,
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
              },
            );
            if (submissionState.cancelRequested) {
              await ctx
                .runAction(
                  internal.media_image_submission.cancelPurgedProviderRequest,
                  { jobId },
                )
                .catch((cancelError) => {
                  console.error(
                    `[media/generate] Fal cancellation failed for ${jobId}:`,
                    cancelError,
                  );
                });
              return errorResponse(
                409,
                "This media request was canceled during submission.",
                origin,
              );
            }
            return jsonResponse(
              createMediaGenerateAcceptedResponse({
                jobId,
                capability: resolved.capability.id,
                status: toMediaJobStatus(submitted.upstreamStatus),
                upstreamStatus: submitted.upstreamStatus,
                subscription: {
                  query: MEDIA_SUBSCRIPTION_QUERY,
                  args: { jobId },
                },
              }),
              202,
              origin,
            );
          } catch (error) {
            const errorCode = (error as Error & { code?: unknown }).code;
            const definitiveRejection =
              isDefinitiveFalSubmissionRejection(error);
            if (
              !physicalDispatch.providerMayHaveStarted() ||
              definitiveRejection
            ) {
              await ctx
                .runMutation(internal.media_jobs.markSubmissionFailed, {
                  jobId,
                  ownerGeneration,
                  submissionAttemptId: physicalDispatch.attemptId,
                  notChargeablePolicy:
                    "provider_definitive_rejection_not_chargeable",
                  upstreamStatus: "ERROR",
                  error: (createMediaJobError({
                    value: {
                      message: (error as Error).message,
                      ...(typeof errorCode === "string" && errorCode.trim()
                        ? { code: errorCode.trim() }
                        : {}),
                    },
                    fallbackMessage: "Media generation failed upstream.",
                  }) ?? {
                    message: "Media generation failed upstream.",
                  }) as never,
                })
                .catch(() => null);
              await physicalDispatch.settle().catch(() => false);
              if (isOwnerFenceError(error)) {
                return errorResponse(
                  409,
                  "Media generation was canceled because the account data generation changed.",
                  origin,
                );
              }
            } else {
              // A timeout/network failure after POST send is ambiguous: Fal
              // may have accepted work and will still call our jobId webhook.
              // Preserve exact provider authority for every request, including
              // callers without an idempotency key. The webhook completes it,
              // cancellation acknowledges it, or the 3h15m provider envelope
              // makes it terminal; Stella never submits this job again.
              await ctx
                .runMutation(internal.media_jobs.markImageSubmissionUnknown, {
                  jobId,
                  ownerGeneration,
                  attemptId: physicalDispatch.attemptId,
                  observedAt: Date.now(),
                  error: {
                    code: "SUBMISSION_OUTCOME_UNKNOWN",
                    message:
                      "Fal may have accepted this media request, but Stella lost the submission response and will not submit it again.",
                    details: {
                      cause:
                        error instanceof Error ? error.message : String(error),
                    },
                  },
                })
                .catch(() => false);
              await physicalDispatch.abandon().catch(() => false);
              console.warn(
                `[media/generate] Ambiguous Fal submission for ${jobId}; awaiting webhook/stale timeout:`,
                error,
              );
              return jsonResponse(
                createMediaGenerateAcceptedResponse({
                  jobId,
                  capability: resolved.capability.id,
                  status: "queued",
                  upstreamStatus: "IN_QUEUE",
                  subscription: {
                    query: MEDIA_SUBSCRIPTION_QUERY,
                    args: { jobId },
                  },
                }),
                202,
                origin,
              );
            }
            if (providerResponseConsumed) {
              await physicalDispatch.abandon().catch(() => false);
            }
            return errorResponse(
              502,
              `Fal request failed: ${(error as Error).message || "Unknown error"}`,
              origin,
            );
          }
        } catch (error) {
          console.error("[media/generate] Unhandled error:", error);
          if (isOwnerFenceError(error)) {
            return errorResponse(
              409,
              "Media generation was canceled because the account data generation changed.",
              origin,
            );
          }
          return errorResponse(500, "Media generation error", origin);
        }
      }),
    ),
  });

  http.route({
    path: MEDIA_FAL_WEBHOOK_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const rawBody = await request.text();
        if (!(await verifyFalWebhookSignature(request, rawBody))) {
          return errorResponse(400, "Invalid Fal webhook signature", origin);
        }
        let parsed: unknown;
        try {
          parsed = rawBody ? JSON.parse(rawBody) : null;
        } catch {
          parsed = null;
        }
        if (!isRecord(parsed))
          return errorResponse(400, "Invalid Fal webhook payload", origin);
        const payload = parsed as FalWebhookPayload;
        const requestId = asTrimmedString(payload.request_id);
        const gatewayRequestId = asTrimmedString(payload.gateway_request_id);
        const upstreamStatus =
          asTrimmedString(payload.status)?.toUpperCase() ?? "ERROR";
        const webhookUrl = new URL(request.url);
        const jobId = webhookUrl.searchParams.get("jobId")?.trim() || undefined;
        const callbackGeneration =
          webhookUrl.searchParams.get("ownerGeneration")?.trim() || undefined;
        const dedupKey = `${requestId ?? jobId ?? "unknown"}:${await hashSha256Hex(rawBody)}`;

        const webhookJob =
          jobId || requestId
            ? await ctx.runQuery(internal.media_jobs.getWebhookJob, {
                ...(jobId ? { jobId } : {}),
                ...(requestId ? { providerRequestId: requestId } : {}),
              })
            : null;
        const ownerGeneration =
          callbackGeneration ?? webhookJob?.ownerGeneration ?? "legacy";
        if (
          webhookJob &&
          callbackGeneration &&
          callbackGeneration !== webhookJob.ownerGeneration
        ) {
          return jsonResponse(
            { received: true, discarded: true, reason: "stale_generation" },
            200,
            origin,
          );
        }

        if (webhookJob) {
          try {
            await assertMediaProviderDispatchAllowed(
              ctx,
              webhookJob.ownerId,
              ownerGeneration,
            );
          } catch (error) {
            if (!isOwnerFenceError(error)) throw error;
            // A canceled deletion job may still need to learn the provider id
            // so its provider-cancellation outbox can drain. The mutation only
            // permits that exact cleanup-only terminal transition.
            await ctx
              .runMutation(internal.media_jobs.applyFalWebhook, {
                ownerGeneration,
                dedupKey,
                ...(jobId ? { jobId } : {}),
                ...(requestId ? { providerRequestId: requestId } : {}),
                ...(gatewayRequestId
                  ? { providerGatewayRequestId: gatewayRequestId }
                  : {}),
                upstreamStatus,
                receivedAt: Date.now(),
              })
              .catch((applyError) => {
                if (!isOwnerFenceError(applyError)) throw applyError;
              });
            return jsonResponse(
              { received: true, discarded: true, reason: "owner_fenced" },
              200,
              origin,
            );
          }
        }
        let output =
          upstreamStatus === "OK" && payload.payload !== undefined
            ? payload.payload
            : undefined;
        const payloadError = createMediaJobError({
          value: payload.payload_error,
          fallbackMessage:
            upstreamStatus === "OK"
              ? "Fal completed the job but returned a non-JSON payload."
              : undefined,
        });

        if (upstreamStatus === "OK" && output === undefined && payloadError) {
          const apiKey = getFalApiKey();
          const resultUrl =
            webhookJob?.providerResponseUrl ??
            (requestId && webhookJob?.endpointId
              ? buildFalResponseUrl(webhookJob.endpointId, requestId)
              : undefined);
          if (apiKey && resultUrl) {
            const resultDispatch = webhookJob
              ? createMediaProviderDispatch(ctx, {
                  ownerId: webhookJob.ownerId,
                  ownerGeneration,
                  jobId: webhookJob.jobId,
                  dispatchId: `media:fal_poll:${webhookJob.jobId}:${dedupKey}`,
                  kind: "fal_poll",
                })
              : null;
            try {
              if (resultDispatch) {
                output = await resultDispatch.run(
                  async (signal) =>
                    await fetchFalResultPayload({
                      apiKey,
                      url: resultUrl,
                      signal,
                    }),
                );
                await resultDispatch.settle();
              }
            } catch (error) {
              if (resultDispatch) {
                if (!resultDispatch.providerMayHaveStarted()) {
                  await resultDispatch.settle().catch(() => false);
                } else {
                  await resultDispatch.abandon().catch(() => false);
                }
              }
              console.error(
                "[media/webhook] Failed to fetch Fal result payload",
                error,
              );
            }
          }
        }

        const finalPayloadError =
          output === undefined ? payloadError : undefined;
        const error =
          finalPayloadError ??
          createMediaJobError({
            value: {
              message: payload.error,
              code: payload.error_type,
              ...(isRecord(payload.payload)
                ? { details: payload.payload }
                : {}),
            },
            fallbackMessage:
              upstreamStatus === "ERROR"
                ? "Media generation failed upstream."
                : undefined,
          });
        const normalizedUpstreamStatus = finalPayloadError
          ? "PAYLOAD_ERROR"
          : upstreamStatus;
        const billing =
          normalizedUpstreamStatus === "OK" &&
          output !== undefined &&
          webhookJob
            ? meterCompletedMediaJob({
                endpointId: webhookJob.endpointId,
                request: webhookJob.request,
                output,
              })
            : null;
        const meteredBilling =
          billing && !("supported" in billing) ? billing : null;
        if (billing && "supported" in billing) {
          console.error(
            `[media/webhook] Failed to meter ${webhookJob?.endpointId ?? "unknown"}: ${billing.reason}`,
          );
        }

        let applied: { notFound?: boolean; duplicate?: boolean };
        try {
          applied = await ctx.runMutation(internal.media_jobs.applyFalWebhook, {
            ownerGeneration,
            dedupKey,
            ...(jobId ? { jobId } : {}),
            ...(requestId ? { providerRequestId: requestId } : {}),
            ...(gatewayRequestId
              ? { providerGatewayRequestId: gatewayRequestId }
              : {}),
            upstreamStatus: normalizedUpstreamStatus,
            ...(upstreamStatus === "OK" && output !== undefined
              ? { output: output as never }
              : {}),
            ...(meteredBilling ? { billing: meteredBilling as never } : {}),
            ...(error ? { error: error as never } : {}),
            receivedAt: Date.now(),
          });
        } catch (applyError) {
          if (!isOwnerFenceError(applyError)) throw applyError;
          return jsonResponse(
            { received: true, discarded: true, reason: "owner_fenced" },
            200,
            origin,
          );
        }
        if (applied.notFound) {
          // Do not consume the webhook identity before its durable job is
          // visible. Fal will retry this non-2xx response.
          return errorResponse(
            503,
            "Media job is not ready for webhook reconciliation.",
            origin,
          );
        }
        return jsonResponse(
          { received: true, ...(applied.duplicate ? { duplicate: true } : {}) },
          200,
          origin,
        );
      }),
    ),
  });
};

export const describeCapabilityValidation = (capabilityId: string) => {
  const resolved = resolveMediaCapability(capabilityId);
  if (!resolved) return null;
  return {
    requiresPrompt: Boolean(resolved.capability.promptKey),
    requiresSourceUrl: Boolean(resolved.capability.requiresSourceUrl),
    acceptsBase64Source: Boolean(resolved.capability.sourceUrlKey),
    supportsAspectRatio: hasAspectRatioSupport(resolved.capability),
  };
};

export const validateCapabilityRequest = (args: {
  capabilityId: string;
  prompt?: string;
  aspectRatio?: string;
  sourceUrl?: string;
  source?: { base64: string; mimeType: string; fileName?: string } | string;
  sources?: Record<
    string,
    string | { base64: string; mimeType: string; fileName?: string }
  >;
  input?: Record<string, unknown>;
}) => {
  const resolved = resolveMediaCapability(args.capabilityId);
  if (!resolved) return `Unknown capability. See ${MEDIA_DOCS_URL}.`;
  return requireCapabilityInputs({
    capability: resolved.capability,
    prompt: args.prompt,
    aspectRatio: args.aspectRatio,
    sourceUrl: args.sourceUrl,
    source: args.source,
    sources: args.sources,
    input: args.input ?? {},
    managedImageEnvelope: true,
  });
};

export {
  MEDIA_API_BASE_PATH,
  MEDIA_CAPABILITIES_PATH,
  MEDIA_DOCS_URL,
  MEDIA_FAL_WEBHOOK_PATH,
  MEDIA_GENERATE_PATH,
  MEDIA_JOB_PATH,
};
