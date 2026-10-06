/**
 * Managed media jobs: one `media_jobs` row per generation, run on Stella's
 * provider accounts and billed through this object's billing ledger.
 *
 * - **Bytes:** inline sources and provider outputs live in `MEDIA` under
 *   `media/<sha256(owner)>/<job>/`; providers and clients read them through
 *   presigned GETs. A job's `output` keeps the provider's shape with each
 *   file `url` swapped for a presigned URL and its `r2Key`.
 * - **Provider:** each job runs on fal or OpenRouter (`resolveMediaCapability`),
 *   recorded in the row's `provider`.
 * - **fal jobs** are queued with a webhook that carries a signed routing
 *   token. The webhook schedules `media.poll` with the result, and the poll
 *   (also armed 2 minutes after submission, with backoff) copies outputs,
 *   bills and settles the row. `media.expire` fails anything still open
 *   after 30 minutes.
 * - **OpenRouter video** is submitted in the call and polled every 30 s;
 *   **OpenRouter images and audio** run in a `media.run` job.
 * - **Music and speech to text** finish inside the call (fal music is polled
 *   in the call, its webhook settling it if the call gives up first).
 * - **Crash rule:** a row left in `submitting` with no provider request id
 *   (the object restarted mid-submit) is failed, never resubmitted.
 *
 * The object is single-threaded, so the old dispatch leases, payload
 * chunking and cleanup queues are not needed.
 */

import type {
  MediaCalls,
  MediaGenerateAccepted,
  MediaGenerateRequest,
  MediaJob,
  MediaJobError,
  MediaJobStatus,
  MediaSourceReference,
} from "@stella/contracts/backend/media";
import { buildCapabilityDenial, hasCapability, toCapabilityAudience } from "@stella/contracts/capabilities";
import { sha256Hex } from "../../hash.js";
import {
  getMediaCapability,
  isDataUri,
  MEDIA_ADMISSION_BUFFER_MICRO_CENTS,
  MEDIA_DOCS_URL,
  mediaCapabilities,
  mediaCostMicroCents,
  planCapabilityFor,
  providerInput,
  resolveMediaCapability,
  validateProviderInput,
} from "../../media/catalog.js";
import { cancelFal, FalError, falWebhookUrl, pollFal, submitFal } from "../../media/fal.js";
import { musicPrompt, parseMusicRequest } from "../../media/lyria.js";
import {
  downloadOpenRouterFile,
  generateOpenRouterImages,
  generateOpenRouterMusic,
  generateOpenRouterSpeech,
  OpenRouterMediaError,
  pollOpenRouterVideo,
  submitOpenRouterVideo,
} from "../../media/openrouter.js";
import { transcribe } from "../../media/openrouter-stt.js";
import { mediaProviderKey } from "../../media/providers.js";
import { mp3DurationSeconds } from "../../voice/hls.js";
import { presignR2Url, r2Signer, type R2Signer } from "../../r2-presign.js";
import { empty, json, literal, number, object, optional, string, type Parser } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDbReader, OwnerDomain } from "../registry.js";
import { billingAccess, recordBillingIdentity, recordUsage } from "./billing.js";

export const MEDIA_POLL_JOB = "media.poll";
export const MEDIA_EXPIRE_JOB = "media.expire";
export const MEDIA_RUN_JOB = "media.run";
const pollJobId = (jobId: string) => `media.poll:${jobId}`;
const expireJobId = (jobId: string) => `media.expire:${jobId}`;
const runJobId = (jobId: string) => `media.run:${jobId}`;

const FIRST_POLL_MS = 2 * 60_000;
const MAX_POLL_MS = 10 * 60_000;
/** OpenRouter has no webhook here, so its videos are polled steadily. */
const OPENROUTER_POLL_MS = 30_000;
/** How long `media.generate` waits for fal music before leaving it to the webhook. */
const MUSIC_WAIT_MS = 4 * 60_000;
const MUSIC_POLL_INTERVAL_MS = 3_000;
const EXPIRE_MS = 30 * 60_000;
const RATE_LIMIT = { count: 20, windowMs: 5 * 60_000 };
/** Inline sources and outputs above this are refused. */
const MAX_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_OUTPUT_FILES = 16;
/** R2 multipart parts other than the last must all be this size. */
const MULTIPART_PART_BYTES = 10 * 1024 * 1024;
/** Providers fetch staged sources well within this. */
const SOURCE_URL_SECONDS = 2 * 60 * 60;
/** The longest a presigned URL may live; view values are signed at completion. */
const OUTPUT_URL_SECONDS = 7 * 24 * 60 * 60;
const LOOKUP_URL_SECONDS = 60 * 60;
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const MAX_WEBHOOK_RESULT_CHARS = 256 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

export const MEDIA_MIGRATION = {
  id: "media.1-init",
  statements: [
    `CREATE TABLE media_jobs (
       job_id TEXT PRIMARY KEY,
       client_request_key TEXT UNIQUE,
       capability TEXT NOT NULL,
       provider TEXT NOT NULL,
       provider_request_id TEXT,
       status TEXT NOT NULL,
       request_json TEXT NOT NULL,
       outputs_json TEXT,
       error_json TEXT,
       cost_micro_cents INTEGER,
       billed INTEGER NOT NULL DEFAULT 0,
       conversation_id TEXT,
       turn_id TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE INDEX media_jobs_updated_at ON media_jobs (updated_at)`,
  ],
};

type JobRow = {
  job_id: string;
  client_request_key: string | null;
  capability: string;
  provider: string;
  provider_request_id: string | null;
  status: string;
  request_json: string;
  outputs_json: string | null;
  error_json: string | null;
  cost_micro_cents: number | null;
  billed: number;
  conversation_id: string | null;
  turn_id: string | null;
  created_at: number;
  updated_at: number;
};

/** What `request_json` holds: the request as submitted plus its idempotency hash. */
type StoredRequest = {
  prompt?: string;
  aspectRatio?: string;
  input: Record<string, unknown>;
  hash: string;
};

/**
 * Jobs this isolate is submitting right now. A `submitting` row not in here
 * belongs to an object that restarted mid-submit (the crash rule).
 */
const inFlight = new Set<string>();

const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ event, ...fields }));

const secret = (env: Cloudflare.Env, name: string): string | null => {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const unavailable = (message = "Media generation is not configured yet.") =>
  new RpcError("UNAVAILABLE", message, { retryable: false });

const bucketOf = (ctx: Pick<OwnerContext, "env">): R2Bucket => {
  const bucket = ctx.env.MEDIA;
  if (!bucket) throw unavailable("Media storage is unavailable right now.");
  return bucket;
};

const signerOf = (ctx: Pick<OwnerContext, "env">): R2Signer => {
  const signer = r2Signer(ctx.env, ctx.env.R2_MEDIA_BUCKET);
  if (!signer) throw unavailable("Media storage is unavailable right now.");
  return signer;
};

/** `media/<sha256(owner)>/`: everything this owner's media stores. */
export const mediaOwnerPrefix = async (ownerId: string): Promise<string> =>
  `media/${await sha256Hex(ownerId)}/`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stableStringify = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stableStringify).join(",")}]`
    : isRecord(value)
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value ?? null);

const parseJson = <T>(text: string | null): T | undefined => {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

const getRow = (db: OwnerDbReader, jobId: string): JobRow | null =>
  db.one<JobRow>("SELECT * FROM media_jobs WHERE job_id = ?", jobId);

const publicStatus = (status: string): MediaJobStatus =>
  status === "submitting" ? "queued" : (status as MediaJobStatus);

const toJob = (row: JobRow, output?: unknown): MediaJob => {
  const request = parseJson<StoredRequest>(row.request_json);
  const error = parseJson<MediaJobError>(row.error_json);
  const stored = output ?? parseJson<unknown>(row.outputs_json);
  return {
    jobId: row.job_id,
    capability: row.capability,
    status: publicStatus(row.status),
    request: {
      ...(request?.prompt ? { prompt: request.prompt } : {}),
      ...(request?.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      ...(request?.input ? { input: request.input } : {}),
    },
    ...(stored !== undefined ? { output: stored } : {}),
    ...(error ? { error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(TERMINAL.has(row.status) ? { completedAt: row.updated_at } : {}),
  };
};

const accepted = (row: JobRow, reattached: boolean): MediaGenerateAccepted => ({
  jobId: row.job_id,
  capability: row.capability,
  status: publicStatus(row.status),
  ...(reattached ? { reattached: true } : {}),
  ...(row.status === "succeeded" && row.outputs_json ? { output: parseJson<unknown>(row.outputs_json) } : {}),
});

// ── Storage ──────────────────────────────────────────────────────────────

const concat = (chunks: Uint8Array[], size: number): Uint8Array => {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/**
 * Stream `body` into `key`: one PUT through a `FixedLengthStream` when the
 * length is known, a multipart upload of fixed-size parts otherwise.
 */
const putStream = async (
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  length: number | null,
  contentType: string,
): Promise<void> => {
  const httpMetadata = { contentType };
  if (length !== null && length > 0) {
    if (length > MAX_OBJECT_BYTES) throw new Error("Media output is too large to store.");
    const fixed = new FixedLengthStream(length);
    await Promise.all([body.pipeTo(fixed.writable), bucket.put(key, fixed.readable, { httpMetadata })]);
    return;
  }
  const upload = await bucket.createMultipartUpload(key, { httpMetadata });
  const parts: R2UploadedPart[] = [];
  const reader = body.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OBJECT_BYTES) throw new Error("Media output is too large to store.");
      pending.push(value);
      pendingBytes += value.byteLength;
      while (pendingBytes >= MULTIPART_PART_BYTES) {
        const joined = concat(pending, pendingBytes);
        parts.push(await upload.uploadPart(parts.length + 1, joined.subarray(0, MULTIPART_PART_BYTES)));
        const rest = joined.subarray(MULTIPART_PART_BYTES);
        pending = rest.byteLength > 0 ? [rest] : [];
        pendingBytes = rest.byteLength;
      }
    }
    if (pendingBytes > 0 || parts.length === 0) {
      parts.push(await upload.uploadPart(parts.length + 1, concat(pending, pendingBytes)));
    }
    await upload.complete(parts);
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }
};

const signGet = (signer: R2Signer, key: string, seconds: number, now: number) =>
  presignR2Url(signer, { method: "GET", key, expiresInSeconds: seconds, now });

const dataUriParts = (value: string): { mimeType: string; bytes: Uint8Array } => {
  const comma = value.indexOf(",");
  const mimeType = value.slice(5, value.indexOf(";")) || "application/octet-stream";
  const binary = atob(value.slice(comma + 1).replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { mimeType, bytes };
};

/**
 * Providers cannot take megabytes of inline JSON and rows must stay small,
 * so every `data:` URI in the input becomes a staged object and a signed GET.
 */
const stageSources = async (
  ctx: OwnerContext,
  jobPrefix: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  let index = 0;
  const stage = async (value: unknown): Promise<unknown> => {
    if (!isDataUri(value)) return value;
    const { mimeType, bytes } = dataUriParts(value);
    const key = `${jobPrefix}src-${index++}`;
    await bucketOf(ctx).put(key, bytes, { httpMetadata: { contentType: mimeType } });
    return await signGet(signerOf(ctx), key, SOURCE_URL_SECONDS, Date.now());
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = Array.isArray(value) ? await Promise.all(value.map(stage)) : await stage(value);
  }
  return out;
};

/**
 * Copy every file a provider payload names into the bucket, returning the
 * payload with each `url` replaced by a presigned GET and its `r2Key`.
 */
const storeOutputs = async (ctx: OwnerContext, jobPrefix: string, payload: unknown): Promise<unknown> => {
  let index = 0;
  const now = Date.now();
  const visit = async (value: unknown, depth: number): Promise<unknown> => {
    if (depth > 8) return value;
    if (Array.isArray(value)) return await Promise.all(value.map((entry) => visit(entry, depth + 1)));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = await visit(entry, depth + 1);
    const url = value.url;
    // An entry with an `r2Key` is already ours (music writes its clip directly).
    if (typeof url === "string" && typeof value.r2Key !== "string" && /^https?:\/\//i.test(url) && index < MAX_OUTPUT_FILES) {
      const key = `${jobPrefix}${index++}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Media output download failed (${response.status}).`);
      const declared = Number(response.headers.get("content-length"));
      const contentType =
        response.headers.get("content-type")?.split(";")[0]?.trim() ||
        (typeof value.content_type === "string" ? value.content_type : "application/octet-stream");
      await putStream(
        bucketOf(ctx),
        key,
        response.body,
        Number.isSafeInteger(declared) && declared > 0 ? declared : null,
        contentType,
      );
      out.url = await signGet(signerOf(ctx), key, OUTPUT_URL_SECONDS, now);
      out.r2Key = key;
    }
    return out;
  };
  return await visit(payload, 0);
};

/** Fresh signatures for a stored output, for callers that read it once. */
const resignOutputs = async (ctx: OwnerContext, output: unknown): Promise<unknown> => {
  const signer = signerOf(ctx);
  const now = Date.now();
  const visit = async (value: unknown, depth: number): Promise<unknown> => {
    if (depth > 8) return value;
    if (Array.isArray(value)) return await Promise.all(value.map((entry) => visit(entry, depth + 1)));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = await visit(entry, depth + 1);
    if (typeof value.r2Key === "string") out.url = await signGet(signer, value.r2Key, LOOKUP_URL_SECONDS, now);
    return out;
  };
  return await visit(output, 0);
};

// ── Settling ─────────────────────────────────────────────────────────────

const clearJobs = (ctx: OwnerContext, jobId: string): void => {
  ctx.jobs.cancel(pollJobId(jobId));
  ctx.jobs.cancel(expireJobId(jobId));
  ctx.jobs.cancel(runJobId(jobId));
};

const failJob = (ctx: OwnerContext, jobId: string, error: MediaJobError): void => {
  ctx.db.run(
    `UPDATE media_jobs SET status = 'failed', error_json = ?, updated_at = ?
     WHERE job_id = ? AND status NOT IN ('succeeded', 'failed', 'canceled')`,
    JSON.stringify(error),
    Date.now(),
    jobId,
  );
  clearJobs(ctx, jobId);
};

const errorOf = (error: unknown, fallback: string): MediaJobError => ({
  message: error instanceof Error && error.message ? error.message : fallback,
  ...(error instanceof FalError && error.code ? { code: error.code } : {}),
});

/** fal's Lyria payload in the shape music clients read (`audio.mimeType`, `textParts`). */
const musicPayload = (row: JobRow, payload: unknown): unknown => {
  if (row.capability !== "text_to_music" || row.provider !== "fal" || !isRecord(payload)) return payload;
  const audio = isRecord(payload.audio) ? payload.audio : {};
  const lyrics = typeof payload.lyrics === "string" ? payload.lyrics.trim() : "";
  const label = parseJson<StoredRequest>(row.request_json)?.input.promptLabel;
  return {
    ...payload,
    audio: { ...audio, mimeType: typeof audio.content_type === "string" ? audio.content_type : "audio/mpeg" },
    promptLabel: typeof label === "string" && label.trim() ? label.trim() : null,
    textParts: lyrics ? [lyrics.slice(0, 2_048)] : [],
  };
};

/** Store the outputs, charge the job once and mark it succeeded. */
const completeJob = async (ctx: OwnerContext, row: JobRow, payload: unknown): Promise<unknown> => {
  const prefix = `${await mediaOwnerPrefix(ctx.ownerId)}${row.job_id}/`;
  const output = await storeOutputs(ctx, prefix, musicPayload(row, payload));
  const current = getRow(ctx.db, row.job_id);
  if (!current || TERMINAL.has(current.status)) return output;
  const capability = getMediaCapability(row.capability, row.provider);
  const request = parseJson<StoredRequest>(row.request_json);
  const cost = capability ? mediaCostMicroCents(capability.endpointId, request?.input ?? {}, payload) : null;
  if (cost === null) log("media_job_unpriced", { jobId: row.job_id, capability: row.capability });
  if (cost !== null && cost > 0) recordUsage(ctx, [{ id: `media:${row.job_id}`, costMicroCents: cost }]);
  ctx.db.run(
    `UPDATE media_jobs SET status = 'succeeded', outputs_json = ?, cost_micro_cents = ?, billed = ?, error_json = NULL,
       updated_at = ? WHERE job_id = ?`,
    JSON.stringify(output),
    cost,
    cost !== null && cost > 0 ? 1 : 0,
    Date.now(),
    row.job_id,
  );
  clearJobs(ctx, row.job_id);
  log("media_job_succeeded", { jobId: row.job_id, capability: row.capability, costMicroCents: cost });
  return output;
};

// ── Generating ───────────────────────────────────────────────────────────

const admit = (ctx: OwnerContext, capabilityId: string): void => {
  const capability = getMediaCapability(capabilityId)!;
  // A signed-in caller's identity is fresher than the ledger's last note of it.
  if (ctx.caller) recordBillingIdentity(ctx, { isAnonymous: ctx.caller.isAnonymous });
  const access = billingAccess(ctx);
  if (access.isAnonymous) {
    throw new RpcError("FORBIDDEN", "Sign in to Stella to use media generation.", { reason: "account_required" });
  }
  const required = planCapabilityFor(capability);
  if (required) {
    const audience = toCapabilityAudience(access.audience) ?? "free";
    if (!hasCapability(audience, required)) {
      throw new RpcError("FORBIDDEN", buildCapabilityDenial(required, audience).message, {
        reason: "capability_required",
      });
    }
  }
  if (
    !access.allowed ||
    (access.remainingMicroCents !== null && access.remainingMicroCents < MEDIA_ADMISSION_BUFFER_MICRO_CENTS)
  ) {
    throw new RpcError("RATE_LIMITED", access.message || "Your Stella usage limit is reached.", {
      retryAfterMs: access.retryAfterMs,
      reason: "usage_limit",
    });
  }
  enforceOwnerRateLimit(ctx.db, ctx.now, "media.generate", RATE_LIMIT, "Too many media requests. Try again in a few minutes.");
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Bytes a provider returned inline, stored as the job's `index`th output. */
const storeBytes = async (
  ctx: OwnerContext,
  prefix: string,
  index: number,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ url: string; r2Key: string; content_type: string; file_size: number }> => {
  const key = `${prefix}${index}`;
  await bucketOf(ctx).put(key, bytes, { httpMetadata: { contentType } });
  return {
    url: await signGet(signerOf(ctx), key, OUTPUT_URL_SECONDS, Date.now()),
    r2Key: key,
    content_type: contentType,
    file_size: bytes.byteLength,
  };
};

const withUsage = (cost: number | null): { usage?: { cost: number } } => (cost !== null ? { usage: { cost } } : {});

/** OpenRouter image, audio and music generations: one synchronous call, outputs stored. */
const runOpenRouter = async (
  ctx: OwnerContext,
  jobId: string,
  capabilityId: string,
  endpointId: string,
  apiKey: string,
  input: Record<string, unknown>,
): Promise<unknown> => {
  const prefix = `${await mediaOwnerPrefix(ctx.ownerId)}${jobId}/`;
  if (capabilityId === "text_to_image" || capabilityId === "image_edit") {
    const result = await generateOpenRouterImages(apiKey, endpointId, input);
    const images = await Promise.all(
      result.images.map((image, index) => storeBytes(ctx, prefix, index, image.bytes, image.contentType)),
    );
    return { images, ...withUsage(result.cost) };
  }
  if (capabilityId === "audio_generation") {
    const result = await generateOpenRouterSpeech(apiKey, endpointId, input);
    const duration = mp3DurationSeconds(result.bytes);
    const audio = await storeBytes(ctx, prefix, 0, result.bytes, result.contentType);
    return { audio: { ...audio, ...(duration !== null ? { duration } : {}) }, ...(duration !== null ? { duration } : {}) };
  }
  if (capabilityId === "text_to_music") {
    const request = parseMusicRequest(input)!;
    const result = await generateOpenRouterMusic(apiKey, endpointId, musicPrompt(request));
    const audio = await storeBytes(ctx, prefix, 0, result.bytes, result.mimeType);
    return {
      audio: { ...audio, mimeType: result.mimeType },
      promptLabel: request.promptLabel,
      textParts: result.textParts,
      ...withUsage(result.cost),
    };
  }
  if (capabilityId === "speech_to_text") return await transcribe(apiKey, endpointId, input);
  throw new Error(`${capabilityId} does not run synchronously on OpenRouter.`);
};

/** The input fal takes: music folds its weighted prompts into one text prompt. */
const falInput = (capabilityId: string, staged: Record<string, unknown>): Record<string, unknown> => {
  if (capabilityId !== "text_to_music") return staged;
  const request = parseMusicRequest(staged)!;
  return { prompt: musicPrompt(request), ...(typeof staged.image_url === "string" ? { image_url: staged.image_url } : {}) };
};

/** Wait in the call for fal music, settling it here when it finishes in time. */
const awaitFalMusic = async (
  ctx: OwnerContext,
  jobId: string,
  endpointId: string,
  apiKey: string,
): Promise<MediaGenerateAccepted> => {
  const deadline = Date.now() + MUSIC_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(MUSIC_POLL_INTERVAL_MS);
    const row = getRow(ctx.db, jobId);
    if (!row) throw new RpcError("CONFLICT", "This media request was canceled.");
    if (row.status === "canceled") throw new RpcError("CONFLICT", "This media request was canceled.");
    if (row.status === "failed") {
      throw new RpcError("UNAVAILABLE", `Media generation failed: ${parseJson<MediaJobError>(row.error_json)?.message ?? "unknown error"}`, {
        retryable: false,
      });
    }
    if (row.status === "succeeded") return accepted(row, false);
    if (!row.provider_request_id) continue;
    const outcome = await pollFal(apiKey, endpointId, row.provider_request_id).catch(() => null);
    if (outcome?.state === "succeeded") {
      const output = await completeJob(ctx, row, outcome.payload);
      return { ...accepted(getRow(ctx.db, jobId) ?? row, false), output };
    }
    if (outcome?.state === "failed") {
      failJob(ctx, jobId, { message: outcome.message, ...(outcome.code ? { code: outcome.code } : {}) });
      throw new RpcError("UNAVAILABLE", `Media generation failed: ${outcome.message}`, { retryable: false });
    }
  }
  return accepted(getRow(ctx.db, jobId)!, false);
};

const startJob = async (
  ctx: OwnerContext,
  request: MediaGenerateRequest,
  origin: { conversationId?: string; turnId?: string } = {},
): Promise<MediaGenerateAccepted> => {
  const resolved = resolveMediaCapability(ctx.env, request.capability);
  const capability = resolved.capability;
  if (!capability) throw new RpcError("BAD_REQUEST", `Unknown capability. See ${MEDIA_DOCS_URL}.`);
  const input = providerInput(capability, request);
  const invalid = validateProviderInput(capability, request, input);
  if (invalid) throw new RpcError("BAD_REQUEST", invalid);
  const clientRequestKey = request.clientRequestKey?.trim() || null;
  const { clientRequestKey: _key, requestHash, ...rest } = request;
  const hash = requestHash?.trim() || (await sha256Hex(stableStringify(rest)));
  if (clientRequestKey) {
    const existing = ctx.db.one<JobRow>("SELECT * FROM media_jobs WHERE client_request_key = ?", clientRequestKey);
    if (existing) {
      if (parseJson<StoredRequest>(existing.request_json)?.hash !== hash) {
        throw new RpcError("CONFLICT", "This idempotency key was already used with a different media request.");
      }
      return accepted(existing, true);
    }
  }
  admit(ctx, capability.id);
  if (!resolved.provider) {
    throw unavailable(
      capability.id === "text_to_3d"
        ? "3D generation is not set up on this Stella deployment (it needs fal)."
        : "Media generation is not configured yet.",
    );
  }
  const { provider, apiKey } = resolved;
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const summary = (staged: Record<string, unknown>): string =>
    JSON.stringify({
      ...(request.prompt ? { prompt: request.prompt } : {}),
      ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      input: staged,
      hash,
    } satisfies StoredRequest);
  // No await between the key check above and this insert, so a concurrent
  // retry under the same key reattaches instead of starting a second job.
  ctx.db.run(
    `INSERT INTO media_jobs (job_id, client_request_key, capability, provider, status, request_json, billed,
       conversation_id, turn_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'submitting', ?, 0, ?, ?, ?, ?)`,
    jobId,
    clientRequestKey,
    capability.id,
    provider,
    // Inline sources are swapped for their staged URLs below; rows stay small.
    summary(
      Object.fromEntries(
        Object.entries(input).map(([key, value]) => [
          key,
          Array.isArray(value)
            ? value.map((entry) => (isDataUri(entry) ? "data:" : entry))
            : isDataUri(value)
              ? "data:"
              : value,
        ]),
      ),
    ),
    origin.conversationId ?? null,
    origin.turnId ?? null,
    now,
    now,
  );
  ctx.jobs.schedule(MEDIA_POLL_JOB, now + FIRST_POLL_MS, { jobId, attempt: 0 }, { id: pollJobId(jobId) });
  ctx.jobs.schedule(MEDIA_EXPIRE_JOB, now + EXPIRE_MS, { jobId }, { id: expireJobId(jobId) });
  log("media_job_started", { jobId, capability: capability.id, provider });

  inFlight.add(jobId);
  try {
    const prefix = `${await mediaOwnerPrefix(ctx.ownerId)}${jobId}/`;
    let staged: Record<string, unknown>;
    try {
      staged = await stageSources(ctx, prefix, input);
    } catch (error) {
      failJob(ctx, jobId, errorOf(error, "Media sources could not be stored."));
      throw error instanceof RpcError ? error : unavailable("Media sources could not be stored. Try again.");
    }
    ctx.db.run("UPDATE media_jobs SET request_json = ? WHERE job_id = ?", summary(staged), jobId);

    if (provider === "fal") {
      const baseUrl = ctx.env.CLOUD_BUILDER_PUBLIC_URL;
      const signingSecret = secret(ctx.env, "MEDIA_SIGNING_SECRET");
      if (!baseUrl || !signingSecret) {
        failJob(ctx, jobId, { message: "Media generation is not configured yet." });
        throw unavailable();
      }
      try {
        const submitted = await submitFal({
          apiKey,
          endpointId: capability.endpointId,
          input: falInput(capability.id, staged),
          webhookUrl: await falWebhookUrl({ baseUrl, secret: signingSecret, ownerId: ctx.ownerId, jobId, now }),
        });
        const status = submitted.status === "IN_PROGRESS" ? "running" : "queued";
        ctx.db.run(
          `UPDATE media_jobs SET provider_request_id = ?,
             status = CASE WHEN status = 'submitting' THEN ? ELSE status END, updated_at = ?
           WHERE job_id = ?`,
          submitted.requestId,
          status,
          Date.now(),
          jobId,
        );
        if (getRow(ctx.db, jobId)?.status === "canceled") {
          await cancelFal(apiKey, capability.endpointId, submitted.requestId).catch(() => undefined);
        }
      } catch (error) {
        if (error instanceof FalError && error.definitive) {
          failJob(ctx, jobId, errorOf(error, "Media generation failed upstream."));
          throw new RpcError("BAD_REQUEST", `Media generation failed: ${error.message}`);
        }
        // fal may have accepted it: wait for the webhook (its URL names this
        // job), and let `media.expire` close it if none comes. Never resubmit.
        ctx.db.run(
          "UPDATE media_jobs SET status = 'running', updated_at = ? WHERE job_id = ? AND status = 'submitting'",
          Date.now(),
          jobId,
        );
        log("media_submit_ambiguous", { jobId, message: error instanceof Error ? error.message : String(error) });
      }
      if (capability.id === "text_to_music") return await awaitFalMusic(ctx, jobId, capability.endpointId, apiKey);
      return accepted(getRow(ctx.db, jobId)!, false);
    }

    if (capability.category === "video") {
      try {
        const submitted = await submitOpenRouterVideo(apiKey, capability.endpointId, staged);
        ctx.db.run(
          `UPDATE media_jobs SET provider_request_id = ?,
             status = CASE WHEN status = 'submitting' THEN 'queued' ELSE status END, updated_at = ?
           WHERE job_id = ?`,
          submitted.id,
          Date.now(),
          jobId,
        );
        ctx.jobs.schedule(MEDIA_POLL_JOB, Date.now() + OPENROUTER_POLL_MS, { jobId, attempt: 0 }, { id: pollJobId(jobId) });
      } catch (error) {
        failJob(ctx, jobId, errorOf(error, "Media generation failed upstream."));
        if (error instanceof OpenRouterMediaError && error.definitive) {
          throw new RpcError("BAD_REQUEST", `Media generation failed: ${error.message}`);
        }
        throw new RpcError("UNAVAILABLE", `Media generation failed: ${errorOf(error, "unknown error").message}`, {
          retryable: false,
        });
      }
      return accepted(getRow(ctx.db, jobId)!, false);
    }

    if (capability.id !== "text_to_music" && capability.id !== "speech_to_text") {
      ctx.jobs.schedule(MEDIA_RUN_JOB, Date.now(), { jobId }, { id: runJobId(jobId) });
      return accepted(getRow(ctx.db, jobId)!, false);
    }

    try {
      const payload = await runOpenRouter(ctx, jobId, capability.id, capability.endpointId, apiKey, staged);
      const row = getRow(ctx.db, jobId);
      if (!row || row.status === "canceled") throw new RpcError("CONFLICT", "This media request was canceled.");
      const output = await completeJob(ctx, row, payload);
      return { ...accepted(getRow(ctx.db, jobId) ?? row, false), output };
    } catch (error) {
      if (error instanceof RpcError) throw error;
      failJob(ctx, jobId, errorOf(error, "Media generation failed upstream."));
      throw new RpcError("UNAVAILABLE", `Media generation failed: ${errorOf(error, "unknown error").message}`, {
        retryable: false,
      });
    }
  } finally {
    inFlight.delete(jobId);
  }
};

/** An OpenRouter image or audio job, run outside the call that started it. */
const runJob = async (ctx: OwnerContext, raw: unknown): Promise<void> => {
  const { jobId } = object({ jobId: string({ max: 100 }) })(raw);
  const row = getRow(ctx.db, jobId);
  if (!row || TERMINAL.has(row.status) || row.provider !== "openrouter") return;
  const capability = getMediaCapability(row.capability, row.provider);
  const apiKey = mediaProviderKey(ctx.env, "openrouter");
  if (!capability || !apiKey) {
    failJob(ctx, jobId, { message: "Media generation is not configured yet." });
    return;
  }
  inFlight.add(jobId);
  try {
    ctx.db.run("UPDATE media_jobs SET status = 'running', updated_at = ? WHERE job_id = ? AND status = 'submitting'", Date.now(), jobId);
    const input = parseJson<StoredRequest>(row.request_json)?.input ?? {};
    const payload = await runOpenRouter(ctx, jobId, capability.id, capability.endpointId, apiKey, input);
    const current = getRow(ctx.db, jobId);
    if (!current || TERMINAL.has(current.status)) return;
    await completeJob(ctx, current, payload);
  } catch (error) {
    failJob(ctx, jobId, errorOf(error, "Media generation failed upstream."));
    log("media_job_failed", { jobId, provider: "openrouter", message: errorOf(error, "unknown error").message });
  } finally {
    inFlight.delete(jobId);
  }
};

/** Copy a finished OpenRouter video into the bucket. */
const storeOpenRouterVideo = async (
  ctx: OwnerContext,
  jobId: string,
  apiKey: string,
  url: string,
  cost: number | null,
): Promise<unknown> => {
  const key = `${await mediaOwnerPrefix(ctx.ownerId)}${jobId}/0`;
  const response = await downloadOpenRouterFile(apiKey, url);
  const declared = Number(response.headers.get("content-length"));
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4";
  await putStream(bucketOf(ctx), key, response.body!, Number.isSafeInteger(declared) && declared > 0 ? declared : null, contentType);
  return {
    video: { url: await signGet(signerOf(ctx), key, OUTPUT_URL_SECONDS, Date.now()), r2Key: key, content_type: contentType },
    ...withUsage(cost),
  };
};

const findRow = (ctx: OwnerContext, args: { jobId?: string; clientRequestKey?: string }): JobRow | null =>
  args.jobId
    ? getRow(ctx.db, args.jobId)
    : args.clientRequestKey
      ? ctx.db.one<JobRow>("SELECT * FROM media_jobs WHERE client_request_key = ?", args.clientRequestKey)
      : null;

const cancelJob = async (
  ctx: OwnerContext,
  args: { jobId?: string; clientRequestKey?: string },
): Promise<MediaCalls["media.cancel"]["result"]> => {
  const row = findRow(ctx, args);
  if (!row) return { state: "not_found" };
  if (TERMINAL.has(row.status)) return { state: "terminal", jobId: row.job_id };
  ctx.db.run("UPDATE media_jobs SET status = 'canceled', updated_at = ? WHERE job_id = ?", Date.now(), row.job_id);
  clearJobs(ctx, row.job_id);
  const apiKey = mediaProviderKey(ctx.env, "fal");
  const capability = getMediaCapability(row.capability, row.provider);
  if (row.provider === "fal" && row.provider_request_id && apiKey && capability) {
    await cancelFal(apiKey, capability.endpointId, row.provider_request_id).catch((error) =>
      log("media_cancel_failed", { jobId: row.job_id, message: String(error) }),
    );
  }
  return { state: "canceled", jobId: row.job_id };
};

// ── Jobs ─────────────────────────────────────────────────────────────────

const pollPayload = object({
  jobId: string({ max: 100 }),
  attempt: optional(number({ int: true, min: 0 })),
  result: optional(json({ maxBytes: MAX_WEBHOOK_RESULT_CHARS })),
});

/**
 * Settle a job from a webhook result, or ask fal where it stands. Also the
 * crash rule's enforcer: an orphaned `submitting` row fails here.
 */
const runPoll = async (ctx: OwnerContext, raw: unknown): Promise<void> => {
  const payload = pollPayload(raw);
  const row = getRow(ctx.db, payload.jobId);
  if (!row || TERMINAL.has(row.status)) return;
  if (payload.result !== undefined) {
    await completeJob(ctx, row, payload.result);
    return;
  }
  const attempt = payload.attempt ?? 0;
  const later = () =>
    ctx.jobs.schedule(
      MEDIA_POLL_JOB,
      Date.now() +
        (row.provider === "openrouter" && row.provider_request_id
          ? OPENROUTER_POLL_MS
          : Math.min(MAX_POLL_MS, FIRST_POLL_MS * 2 ** (attempt + 1))),
      { jobId: row.job_id, attempt: attempt + 1 },
      { id: pollJobId(row.job_id) },
    );
  if (!row.provider_request_id) {
    if (inFlight.has(row.job_id)) {
      later();
    } else if (row.status === "submitting") {
      failJob(ctx, row.job_id, {
        code: "submission_lost",
        message: "Stella lost this request while submitting it and did not resubmit it.",
      });
    }
    // An ambiguous fal submission waits for its webhook or `media.expire`.
    return;
  }
  const capability = getMediaCapability(row.capability, row.provider);
  if (row.provider === "openrouter") {
    const apiKey = mediaProviderKey(ctx.env, "openrouter");
    if (!capability || !apiKey) return;
    const outcome = await pollOpenRouterVideo(apiKey, row.provider_request_id);
    if (outcome.state === "succeeded") {
      await completeJob(ctx, row, await storeOpenRouterVideo(ctx, row.job_id, apiKey, outcome.urls[0]!, outcome.cost));
    } else if (outcome.state === "failed") {
      failJob(ctx, row.job_id, { message: outcome.message });
    } else {
      if (outcome.running && row.status === "queued") {
        ctx.db.run("UPDATE media_jobs SET status = 'running', updated_at = ? WHERE job_id = ?", Date.now(), row.job_id);
      }
      later();
    }
    return;
  }
  const apiKey = mediaProviderKey(ctx.env, "fal");
  if (!capability || !apiKey) return;
  const outcome = await pollFal(apiKey, capability.endpointId, row.provider_request_id);
  if (outcome.state === "succeeded") {
    await completeJob(ctx, row, outcome.payload);
  } else if (outcome.state === "failed") {
    failJob(ctx, row.job_id, { message: outcome.message, ...(outcome.code ? { code: outcome.code } : {}) });
  } else {
    if (outcome.running && row.status === "queued") {
      ctx.db.run("UPDATE media_jobs SET status = 'running', updated_at = ? WHERE job_id = ?", Date.now(), row.job_id);
    }
    later();
  }
};

const runExpire = async (ctx: OwnerContext, raw: unknown): Promise<void> => {
  const { jobId } = object({ jobId: string({ max: 100 }) })(raw);
  const row = getRow(ctx.db, jobId);
  if (!row || TERMINAL.has(row.status)) return;
  failJob(ctx, jobId, { code: "timeout", message: "Media generation took too long." });
  const capability = getMediaCapability(row.capability, row.provider);
  const apiKey = mediaProviderKey(ctx.env, "fal");
  if (row.provider === "fal" && row.provider_request_id && capability && apiKey) {
    await cancelFal(apiKey, capability.endpointId, row.provider_request_id).catch(() => undefined);
  }
};

// ── Server-internal input ────────────────────────────────────────────────

const sourceRef: Parser<MediaSourceReference> = (value, path = "") => {
  if (typeof value === "string") return value;
  return object({ base64: string({ max: MAX_REQUEST_BYTES }), mimeType: string({ max: 200 }), fileName: optional(string({ max: 500 })) })(
    value,
    path,
  );
};

const generateArgs: Parser<MediaGenerateRequest> = (value, path = "") => {
  const parsed = object({
    capability: string({ min: 1, max: 100 }),
    prompt: optional(string({ max: 32_000 })),
    aspectRatio: optional(string({ max: 20 })),
    sourceUrl: optional(string({ max: 8_192 })),
    source: optional(json({ maxBytes: MAX_REQUEST_BYTES })),
    sources: optional(json({ maxBytes: MAX_REQUEST_BYTES })),
    input: optional(json({ maxBytes: MAX_REQUEST_BYTES })),
    clientRequestKey: optional(string({ min: 1, max: 200 })),
    requestHash: optional(string({ max: 128 })),
  })(value, path);
  const prefix = path ? `${path}.` : "";
  if (parsed.input !== undefined && !isRecord(parsed.input)) {
    throw new RpcError("BAD_REQUEST", `${prefix}input must be an object.`);
  }
  if (parsed.sources !== undefined && !isRecord(parsed.sources)) {
    throw new RpcError("BAD_REQUEST", `${prefix}sources must be an object.`);
  }
  return {
    ...parsed,
    ...(parsed.source !== undefined ? { source: sourceRef(parsed.source, `${prefix}source`) } : {}),
    ...(parsed.sources !== undefined
      ? {
          sources: Object.fromEntries(
            Object.entries(parsed.sources as Record<string, unknown>).map(([key, entry]) => [
              key,
              sourceRef(entry, `${prefix}sources.${key}`),
            ]),
          ),
        }
      : {}),
    ...(parsed.input !== undefined ? { input: parsed.input as Record<string, unknown> } : {}),
  } as MediaGenerateRequest;
};

const lookupArgs = object({
  jobId: optional(string({ max: 100 })),
  clientRequestKey: optional(string({ max: 200 })),
});

const webhookArgs = object({
  jobId: string({ max: 100 }),
  body: json({ maxBytes: 4 * 1024 * 1024 }),
});

/**
 * fal settled a request. A result is handed to `media.poll` (run now), which
 * copies the outputs; the webhook answers at once so fal is not kept waiting.
 */
const falWebhook = (ctx: OwnerContext, raw: unknown): { received: true; discarded?: string } => {
  const { jobId, body } = webhookArgs(raw);
  const row = getRow(ctx.db, jobId);
  if (!row) return { received: true, discarded: "not_found" };
  if (TERMINAL.has(row.status)) return { received: true, discarded: "terminal" };
  const event = isRecord(body) ? body : {};
  const requestId = typeof event.request_id === "string" ? event.request_id : null;
  if (requestId && row.provider_request_id && requestId !== row.provider_request_id) {
    return { received: true, discarded: "request_mismatch" };
  }
  if (requestId && !row.provider_request_id) {
    ctx.db.run("UPDATE media_jobs SET provider_request_id = ?, updated_at = ? WHERE job_id = ?", requestId, Date.now(), jobId);
  }
  const status = typeof event.status === "string" ? event.status.toUpperCase() : "ERROR";
  if (status === "OK") {
    const result = event.payload;
    const usable = isRecord(result) && JSON.stringify(result).length <= MAX_WEBHOOK_RESULT_CHARS;
    ctx.jobs.schedule(MEDIA_POLL_JOB, Date.now(), usable ? { jobId, result } : { jobId, attempt: 0 }, {
      id: pollJobId(jobId),
    });
    return { received: true };
  }
  const detail = isRecord(event.payload) ? event.payload.detail : undefined;
  failJob(ctx, jobId, {
    message:
      (typeof event.error === "string" && event.error) ||
      (typeof detail === "string" && detail) ||
      (Array.isArray(detail) && typeof (detail[0] as { msg?: unknown })?.msg === "string"
        ? String((detail[0] as { msg: string }).msg)
        : "Media generation failed upstream."),
    ...(typeof event.error_type === "string" ? { code: event.error_type } : {}),
  });
  return { received: true };
};

const generateForTurn = async (ctx: OwnerContext, raw: unknown): Promise<MediaGenerateAccepted> => {
  const args = object({
    request: json({ maxBytes: MAX_REQUEST_BYTES }),
    conversationId: optional(string({ max: 200 })),
    turnId: optional(string({ max: 200 })),
  })(raw);
  return await startJob(ctx, generateArgs(args.request, "request"), {
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    ...(args.turnId ? { turnId: args.turnId } : {}),
  });
};

/** One job with freshly signed outputs, for HTTP clients and agent tools. */
const lookup = async (ctx: OwnerContext, raw: unknown): Promise<MediaJob | null> => {
  const row = findRow(ctx, lookupArgs(raw));
  if (!row) return null;
  const stored = parseJson<unknown>(row.outputs_json);
  return toJob(row, stored === undefined ? undefined : await resignOutputs(ctx, stored));
};

/** Admin delete: cancel an open job, then drop its row and its objects. */
const deleteJob = async (
  ctx: OwnerContext,
  raw: unknown,
): Promise<{ deleted: boolean; kind: "media_job"; id: string }> => {
  const { jobId } = object({ jobId: string({ min: 1, max: 100 }) })(raw);
  const row = getRow(ctx.db, jobId);
  if (!row) return { deleted: false, kind: "media_job", id: jobId };
  await cancelJob(ctx, { jobId });
  ctx.db.run("DELETE FROM media_jobs WHERE job_id = ?", jobId);
  const bucket = bucketOf(ctx);
  const prefix = `${await mediaOwnerPrefix(ctx.ownerId)}${jobId}/`;
  const listed = await bucket.list({ prefix, limit: 1_000 });
  if (listed.objects.length > 0) await bucket.delete(listed.objects.map((object) => object.key));
  return { deleted: true, kind: "media_job", id: jobId };
};

// ── Purge ────────────────────────────────────────────────────────────────

/** Reset or deletion: cancel open fal requests, drop every row and every object. */
const purgeMedia = async (ctx: OwnerContext): Promise<{ pending: boolean }> => {
  const rows = ctx.db.all<Pick<JobRow, "job_id" | "capability" | "provider" | "provider_request_id" | "status">>(
    "SELECT job_id, capability, provider, provider_request_id, status FROM media_jobs",
  );
  const apiKey = mediaProviderKey(ctx.env, "fal");
  for (const row of rows) {
    clearJobs(ctx, row.job_id);
    const capability = getMediaCapability(row.capability, row.provider);
    if (!TERMINAL.has(row.status) && row.provider === "fal" && row.provider_request_id && apiKey && capability) {
      await cancelFal(apiKey, capability.endpointId, row.provider_request_id).catch(() => undefined);
    }
  }
  ctx.db.run("DELETE FROM media_jobs");
  const bucket = bucketOf(ctx);
  const listed = await bucket.list({ prefix: await mediaOwnerPrefix(ctx.ownerId), limit: 1_000 });
  if (listed.objects.length > 0) await bucket.delete(listed.objects.map((object) => object.key));
  return { pending: listed.truncated };
};

// ── Registration ─────────────────────────────────────────────────────────

const statusArg = literal("queued", "running", "succeeded", "failed", "canceled");

export const mediaDomain = {
  name: "media",
  migrations: [MEDIA_MIGRATION],
  calls: {
    "media.capabilities": {
      scope: "global",
      parse: empty(),
      handler: (ctx) => ({ data: mediaCapabilities(ctx.env), docsUrl: MEDIA_DOCS_URL }),
    },
    "media.generate": {
      scope: "owner",
      requireAccount: true,
      parse: generateArgs,
      handler: (ctx: OwnerContext, args: MediaGenerateRequest) => startJob(ctx, args),
    },
    "media.cancel": {
      scope: "owner",
      requireAccount: true,
      parse: lookupArgs,
      handler: cancelJob,
    },
  },
  views: {
    "media.job": {
      parse: object({ jobId: string({ min: 1, max: 100 }) }),
      read: (ctx, args) => {
        const row = getRow(ctx.db, args.jobId);
        return row ? toJob(row) : null;
      },
    },
    "media.jobs": {
      parse: object({
        since: number({ min: 0 }),
        status: optional(statusArg),
        limit: optional(number({ int: true, min: 1, max: MAX_LIST_LIMIT })),
      }),
      read: (ctx, args) => {
        const limit = args.limit ?? DEFAULT_LIST_LIMIT;
        const rows = args.status
          ? ctx.db.all<JobRow>(
              `SELECT * FROM media_jobs WHERE updated_at >= ? AND status IN (?, ?)
               ORDER BY updated_at DESC LIMIT ?`,
              args.since,
              args.status,
              args.status === "queued" ? "submitting" : args.status,
              limit,
            )
          : ctx.db.all<JobRow>(
              "SELECT * FROM media_jobs WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?",
              args.since,
              limit,
            );
        return rows.map((row) => toJob(row));
      },
    },
  },
  internal: {
    "media.generateForTurn": generateForTurn,
    "media.falWebhook": falWebhook,
    "media.lookup": lookup,
    "media.cancelForTurn": (ctx: OwnerContext, raw: unknown) => cancelJob(ctx, lookupArgs(raw)),
    "media.deleteJob": deleteJob,
  },
  jobs: {
    [MEDIA_POLL_JOB]: { run: runPoll },
    [MEDIA_EXPIRE_JOB]: { run: runExpire },
    [MEDIA_RUN_JOB]: { run: runJob, maxAttempts: 1 },
  },
  purge: (ctx: OwnerContext) => purgeMedia(ctx),
} satisfies OwnerDomain;
