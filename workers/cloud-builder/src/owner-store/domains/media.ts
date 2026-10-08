/**
 * Managed media jobs: one `media_jobs` row per generation, run on Stella's
 * fal account and billed through this object's billing ledger.
 *
 * - **Models:** a request names a model from `@stella/contracts/media-models`
 *   and sends that model's own input, which goes to fal untouched apart from
 *   inline sources. Adding or swapping a model is an edit to that list.
 * - **Bytes:** inline sources and outputs live in `MEDIA` under
 *   `media/<sha256(owner)>/<job>/`; fal and clients read them through
 *   presigned GETs. A job's `output` keeps the model's shape with each file
 *   `url` swapped for a presigned URL and its `r2Key`.
 * - **Settling:** jobs are queued on fal with a webhook that carries a signed
 *   routing token. The webhook schedules `media.poll` with the result, and
 *   the poll (also armed 2 minutes after submission, with backoff) copies
 *   outputs, bills and settles the row. `media.expire` fails anything still
 *   open after 30 minutes.
 * - **Billing:** the model's `price` is checked against what the owner has
 *   left before the job starts and charged once it succeeds.
 * - **Crash rule:** a row left in `submitting` with no provider request id
 *   (the object restarted mid-submit) is failed, never resubmitted.
 */

import type {
  MediaCalls,
  MediaGenerateAccepted,
  MediaGenerateRequest,
  MediaJob,
  MediaJobError,
  MediaJobStatus,
  MediaModelListing,
} from "@stella/contracts/backend/media";
import { buildCapabilityDenial, hasCapability, toCapabilityAudience } from "@stella/contracts/capabilities";
import { MEDIA_MODELS, mediaModel, type MediaModel } from "@stella/contracts/media-models";
import { sha256Hex } from "../../hash.js";
import { cancelFal, FalError, falWebhookUrl, pollFal, submitFal } from "../../media/fal.js";
import { presignR2Url, r2Signer, type R2Signer } from "../../r2-presign.js";
import { mediaSigningSecret } from "../../voice/ticket.js";
import { empty, json, literal, number, object, optional, string, type Parser } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDbReader, OwnerDomain } from "../registry.js";
import { billingAccess, recordBillingIdentity, recordUsage } from "./billing.js";

export const MEDIA_DOCS_URL = "https://stella.sh/docs/media";
export const MEDIA_POLL_JOB = "media.poll";
export const MEDIA_EXPIRE_JOB = "media.expire";
const pollJobId = (jobId: string) => `media.poll:${jobId}`;
const expireJobId = (jobId: string) => `media.expire:${jobId}`;

const FIRST_POLL_MS = 2 * 60_000;
const MAX_POLL_MS = 10 * 60_000;
const EXPIRE_MS = 30 * 60_000;
const RATE_LIMIT = { count: 20, windowMs: 5 * 60_000 };
/** Before admitting a job whose price is not known yet, the owner must have this much left. */
const ADMISSION_BUFFER_USD = 0.8;
const MICRO_CENTS_PER_USD = 100_000_000;
/** Inline sources and outputs above this are refused. */
const MAX_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_OUTPUT_FILES = 16;
/** R2 multipart parts other than the last must all be this size. */
const MULTIPART_PART_BYTES = 10 * 1024 * 1024;
/** fal fetches staged sources well within this. */
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

export const MEDIA_CHARGE_MIGRATION = {
  id: "media.2-charge-pending",
  statements: ["ALTER TABLE media_jobs ADD COLUMN charge_pending INTEGER NOT NULL DEFAULT 0"],
};

/** Jobs name a model and every job runs on fal. */
export const MEDIA_MODEL_MIGRATION = {
  id: "media.3-model",
  statements: [
    "ALTER TABLE media_jobs RENAME COLUMN capability TO model",
    "ALTER TABLE media_jobs DROP COLUMN provider",
    "ALTER TABLE media_jobs DROP COLUMN charge_pending",
  ],
};

type JobRow = {
  job_id: string;
  client_request_key: string | null;
  model: string;
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

/** What `request_json` holds: the input as submitted plus its idempotency hash. */
type StoredRequest = {
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

const isDataUri = (value: unknown): value is string =>
  typeof value === "string" && /^data:[^;,\s]+;base64,/i.test(value);

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
    model: row.model,
    kind: mediaModel(row.model)?.kind ?? "image",
    status: publicStatus(row.status),
    input: request?.input ?? {},
    ...(stored !== undefined ? { output: stored } : {}),
    ...(error ? { error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(TERMINAL.has(row.status) ? { completedAt: row.updated_at } : {}),
  };
};

const accepted = (row: JobRow, reattached: boolean): MediaGenerateAccepted => ({
  jobId: row.job_id,
  model: row.model,
  status: publicStatus(row.status),
  ...(reattached ? { reattached: true } : {}),
  ...(row.status === "succeeded" && row.outputs_json ? { output: parseJson<unknown>(row.outputs_json) } : {}),
});

const listing = (model: MediaModel): MediaModelListing => ({
  id: model.id,
  name: model.name,
  kind: model.kind,
  does: model.does,
  docsUrl: model.docsUrl,
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
 * fal cannot take megabytes of inline JSON and rows must stay small, so every
 * `data:` URI anywhere in the input becomes a staged object and a signed GET.
 */
const stageSources = async (
  ctx: OwnerContext,
  jobPrefix: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  let index = 0;
  const stage = async (value: unknown, depth: number): Promise<unknown> => {
    if (isDataUri(value)) {
      const { mimeType, bytes } = dataUriParts(value);
      const key = `${jobPrefix}src-${index++}`;
      await bucketOf(ctx).put(key, bytes, { httpMetadata: { contentType: mimeType } });
      return await signGet(signerOf(ctx), key, SOURCE_URL_SECONDS, Date.now());
    }
    if (depth > 8) return value;
    if (Array.isArray(value)) return await Promise.all(value.map((entry) => stage(entry, depth + 1)));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = await stage(entry, depth + 1);
    return out;
  };
  return (await stage(input, 0)) as Record<string, unknown>;
};

/** The input as a row keeps it before staging: inline sources shortened to `data:`. */
const withoutInlineSources = (value: unknown, depth = 0): unknown => {
  if (isDataUri(value)) return "data:";
  if (depth > 8) return value;
  if (Array.isArray(value)) return value.map((entry) => withoutInlineSources(entry, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withoutInlineSources(entry, depth + 1)]));
};

/**
 * Copy every file a provider payload names into the bucket, returning the
 * payload with each `url` replaced by a presigned GET and its `r2Key`.
 */
const storeOutputs = async (ctx: OwnerContext, jobPrefix: string, payload: unknown): Promise<unknown> => {
  let index = 0;
  const now = Date.now();
  // A model can name one file under several keys (Tripo's `model_mesh` and
  // `model_urls.glb`); each source URL is copied once.
  const copies = new Map<string, Promise<{ url: string; r2Key: string }>>();
  const copy = async (url: string, declaredType: unknown): Promise<{ url: string; r2Key: string }> => {
    const key = `${jobPrefix}${index++}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`Media output download failed (${response.status}).`);
    const declared = Number(response.headers.get("content-length"));
    const contentType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      (typeof declaredType === "string" ? declaredType : "application/octet-stream");
    await putStream(bucketOf(ctx), key, response.body, Number.isSafeInteger(declared) && declared > 0 ? declared : null, contentType);
    return { url: await signGet(signerOf(ctx), key, OUTPUT_URL_SECONDS, now), r2Key: key };
  };
  const visit = async (value: unknown, depth: number): Promise<unknown> => {
    if (depth > 8) return value;
    if (Array.isArray(value)) return await Promise.all(value.map((entry) => visit(entry, depth + 1)));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = await visit(entry, depth + 1);
    const url = value.url;
    if (typeof url === "string" && /^https?:\/\//i.test(url) && (copies.has(url) || copies.size < MAX_OUTPUT_FILES)) {
      if (!copies.has(url)) copies.set(url, copy(url, value.content_type));
      Object.assign(out, await copies.get(url)!);
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

const deleteJobObjects = async (ctx: OwnerContext, jobId: string): Promise<void> => {
  const bucket = bucketOf(ctx);
  const listed = await bucket.list({ prefix: `${await mediaOwnerPrefix(ctx.ownerId)}${jobId}/`, limit: 1_000 });
  if (listed.objects.length > 0) await bucket.delete(listed.objects.map((object) => object.key));
};

const errorOf = (error: unknown, fallback: string): MediaJobError => ({
  message: error instanceof Error && error.message ? error.message : fallback,
  ...(error instanceof FalError && error.code ? { code: error.code } : {}),
});

const microCents = (usd: number): number => Math.max(0, Math.round(usd * MICRO_CENTS_PER_USD));

/** What a finished job costs, in micro-cents, or null when its price could not be worked out. */
const jobCost = (row: JobRow, payload: unknown): number | null => {
  const model = mediaModel(row.model);
  const input = parseJson<StoredRequest>(row.request_json)?.input ?? {};
  const usd = model ? model.price(input, payload) : null;
  return usd === null ? null : microCents(usd);
};

/** Store the outputs, charge the job once and mark it succeeded. */
const completeJob = async (ctx: OwnerContext, row: JobRow, payload: unknown): Promise<unknown> => {
  const prefix = `${await mediaOwnerPrefix(ctx.ownerId)}${row.job_id}/`;
  const output = await storeOutputs(ctx, prefix, payload);
  const current = getRow(ctx.db, row.job_id);
  // Canceled while fal finished it: fal charged nothing Stella passes on.
  if (!current || TERMINAL.has(current.status)) return output;
  const cost = jobCost(row, payload);
  if (cost === null) log("media_job_unpriced", { jobId: row.job_id, model: row.model });
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
  log("media_job_succeeded", { jobId: row.job_id, model: row.model, costMicroCents: cost });
  return output;
};

// ── Generating ───────────────────────────────────────────────────────────

const admit = (ctx: OwnerContext, model: MediaModel, input: Record<string, unknown>): void => {
  // A signed-in caller's identity is fresher than the ledger's last note of it.
  if (ctx.caller) recordBillingIdentity(ctx, { isAnonymous: ctx.caller.isAnonymous });
  const access = billingAccess(ctx);
  if (access.isAnonymous) {
    throw new RpcError("FORBIDDEN", "Sign in to Stella to use media generation.", { reason: "account_required" });
  }
  if (model.plan) {
    const audience = toCapabilityAudience(access.audience) ?? "free";
    if (!hasCapability(audience, model.plan)) {
      throw new RpcError("FORBIDDEN", buildCapabilityDenial(model.plan, audience).message, {
        reason: "capability_required",
      });
    }
  }
  const needed = microCents(Math.max(ADMISSION_BUFFER_USD, model.price(input) ?? 0));
  if (!access.allowed || (access.remainingMicroCents !== null && access.remainingMicroCents < needed)) {
    throw new RpcError("RATE_LIMITED", access.message || "Your Stella usage limit is reached.", {
      retryAfterMs: access.retryAfterMs,
      reason: "usage_limit",
    });
  }
  enforceOwnerRateLimit(ctx.db, ctx.now, "media.generate", RATE_LIMIT, "Too many media requests. Try again in a few minutes.");
};

const startJob = async (
  ctx: OwnerContext,
  request: MediaGenerateRequest,
  origin: { conversationId?: string; turnId?: string } = {},
): Promise<MediaGenerateAccepted> => {
  const model = mediaModel(request.model);
  if (!model) {
    throw new RpcError(
      "BAD_REQUEST",
      `Unknown model ${request.model}. The models are: ${MEDIA_MODELS.map((entry) => entry.id).join(", ")}.`,
    );
  }
  const clientRequestKey = request.clientRequestKey?.trim() || null;
  const hash = request.requestHash?.trim() || (await sha256Hex(stableStringify({ model: request.model, input: request.input })));
  if (clientRequestKey) {
    const existing = ctx.db.one<JobRow>("SELECT * FROM media_jobs WHERE client_request_key = ?", clientRequestKey);
    if (existing) {
      if (parseJson<StoredRequest>(existing.request_json)?.hash !== hash) {
        throw new RpcError("CONFLICT", "This idempotency key was already used with a different media request.");
      }
      return accepted(existing, true);
    }
  }
  admit(ctx, model, request.input);
  const apiKey = secret(ctx.env, "FAL_KEY");
  const baseUrl = ctx.env.CLOUD_BUILDER_PUBLIC_URL;
  const signingSecret = mediaSigningSecret(ctx.env);
  if (!apiKey || !baseUrl || !signingSecret) throw unavailable();
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const summary = (input: unknown): string => JSON.stringify({ input, hash } as StoredRequest);
  // No await between the key check above and this insert, so a concurrent
  // retry under the same key reattaches instead of starting a second job.
  ctx.db.run(
    `INSERT INTO media_jobs (job_id, client_request_key, model, status, request_json, billed,
       conversation_id, turn_id, created_at, updated_at)
     VALUES (?, ?, ?, 'submitting', ?, 0, ?, ?, ?, ?)`,
    jobId,
    clientRequestKey,
    model.id,
    // Inline sources are swapped for their staged URLs below; rows stay small.
    summary(withoutInlineSources(request.input)),
    origin.conversationId ?? null,
    origin.turnId ?? null,
    now,
    now,
  );
  ctx.jobs.schedule(MEDIA_POLL_JOB, now + FIRST_POLL_MS, { jobId, attempt: 0 }, { id: pollJobId(jobId) });
  ctx.jobs.schedule(MEDIA_EXPIRE_JOB, now + EXPIRE_MS, { jobId }, { id: expireJobId(jobId) });
  log("media_job_started", { jobId, model: model.id });

  inFlight.add(jobId);
  try {
    const prefix = `${await mediaOwnerPrefix(ctx.ownerId)}${jobId}/`;
    let staged: Record<string, unknown>;
    try {
      staged = await stageSources(ctx, prefix, request.input);
    } catch (error) {
      failJob(ctx, jobId, errorOf(error, "Media sources could not be stored."));
      throw error instanceof RpcError ? error : unavailable("Media sources could not be stored. Try again.");
    }
    ctx.db.run("UPDATE media_jobs SET request_json = ? WHERE job_id = ?", summary(staged), jobId);
    if (getRow(ctx.db, jobId)?.status === "canceled") throw new RpcError("CONFLICT", "This media request was canceled.");
    try {
      const submitted = await submitFal({
        apiKey,
        endpointId: model.id,
        input: staged,
        webhookUrl: await falWebhookUrl({ baseUrl, secret: signingSecret, ownerId: ctx.ownerId, jobId, now }),
      });
      ctx.db.run(
        `UPDATE media_jobs SET provider_request_id = ?,
           status = CASE WHEN status = 'submitting' THEN ? ELSE status END, updated_at = ?
         WHERE job_id = ?`,
        submitted.requestId,
        submitted.status === "IN_PROGRESS" ? "running" : "queued",
        Date.now(),
        jobId,
      );
      if (getRow(ctx.db, jobId)?.status === "canceled") {
        await cancelFal(apiKey, model.id, submitted.requestId).catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof FalError && error.definitive) {
        failJob(ctx, jobId, errorOf(error, "Media generation failed upstream."));
        throw new RpcError("BAD_REQUEST", `${model.id} refused the request: ${error.message} (see ${model.docsUrl})`);
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
    return accepted(getRow(ctx.db, jobId)!, false);
  } finally {
    inFlight.delete(jobId);
  }
};

const findRow = (ctx: OwnerContext, args: { jobId?: string; clientRequestKey?: string }): JobRow | null =>
  args.jobId
    ? getRow(ctx.db, args.jobId)
    : args.clientRequestKey
      ? ctx.db.one<JobRow>("SELECT * FROM media_jobs WHERE client_request_key = ?", args.clientRequestKey)
      : null;

const cancelOnFal = async (ctx: OwnerContext, row: Pick<JobRow, "job_id" | "model" | "provider_request_id">) => {
  const apiKey = secret(ctx.env, "FAL_KEY");
  if (!row.provider_request_id || !apiKey) return;
  await cancelFal(apiKey, row.model, row.provider_request_id).catch((error) =>
    log("media_cancel_failed", { jobId: row.job_id, message: String(error) }),
  );
};

const cancelJob = async (
  ctx: OwnerContext,
  args: { jobId?: string; clientRequestKey?: string },
): Promise<MediaCalls["media.cancel"]["result"]> => {
  const row = findRow(ctx, args);
  if (!row) return { state: "not_found" };
  if (TERMINAL.has(row.status)) return { state: "terminal", jobId: row.job_id };
  ctx.db.run("UPDATE media_jobs SET status = 'canceled', updated_at = ? WHERE job_id = ?", Date.now(), row.job_id);
  clearJobs(ctx, row.job_id);
  await cancelOnFal(ctx, row);
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
      Date.now() + Math.min(MAX_POLL_MS, FIRST_POLL_MS * 2 ** (attempt + 1)),
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
    // An ambiguous submission waits for its webhook or `media.expire`.
    return;
  }
  const apiKey = secret(ctx.env, "FAL_KEY");
  if (!apiKey) return;
  const outcome = await pollFal(apiKey, row.model, row.provider_request_id);
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
  await cancelOnFal(ctx, row);
};

// ── Server-internal input ────────────────────────────────────────────────

const generateArgs: Parser<MediaGenerateRequest> = (value, path = "") => {
  const parsed = object({
    model: string({ min: 1, max: 200 }),
    input: json({ maxBytes: MAX_REQUEST_BYTES }),
    clientRequestKey: optional(string({ min: 1, max: 200 })),
    requestHash: optional(string({ max: 128 })),
  })(value, path);
  if (!isRecord(parsed.input)) {
    throw new RpcError("BAD_REQUEST", `${path ? `${path}.` : ""}input must be an object: the model's own input.`);
  }
  return parsed as MediaGenerateRequest;
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
  // fal's `error` is generic ("Unexpected status code: 422"); the payload's
  // `detail` is the model's own complaint, which says what to change.
  const detail = isRecord(event.payload) ? event.payload.detail : undefined;
  const detailText =
    typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail
            .map((entry) => {
              if (!isRecord(entry) || typeof entry.msg !== "string") return null;
              const loc = Array.isArray(entry.loc) ? entry.loc.filter((part) => part !== "body").join(".") : "";
              return loc ? `${loc}: ${entry.msg}` : entry.msg;
            })
            .filter((entry): entry is string => entry !== null)
            .join("; ")
        : "";
  const errorText = typeof event.error === "string" ? event.error : "";
  failJob(ctx, jobId, {
    message: detailText || errorText || "Media generation failed upstream.",
    ...(typeof event.error_type === "string" ? { code: event.error_type } : {}),
    ...(detail !== undefined ? { details: { detail } } : {}),
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
  clearJobs(ctx, jobId);
  ctx.db.run("DELETE FROM media_jobs WHERE job_id = ?", jobId);
  await deleteJobObjects(ctx, jobId);
  return { deleted: true, kind: "media_job", id: jobId };
};

// ── Purge ────────────────────────────────────────────────────────────────

/** Reset or deletion: cancel open fal requests, drop every row and every object. */
const purgeMedia = async (ctx: OwnerContext): Promise<{ pending: boolean }> => {
  const rows = ctx.db.all<Pick<JobRow, "job_id" | "model" | "provider_request_id" | "status">>(
    "SELECT job_id, model, provider_request_id, status FROM media_jobs",
  );
  for (const row of rows) {
    clearJobs(ctx, row.job_id);
    if (!TERMINAL.has(row.status)) await cancelOnFal(ctx, row);
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
  migrations: [MEDIA_MIGRATION, MEDIA_CHARGE_MIGRATION, MEDIA_MODEL_MIGRATION],
  calls: {
    "media.models": {
      scope: "global",
      parse: empty(),
      handler: () => ({ data: MEDIA_MODELS.map(listing), docsUrl: MEDIA_DOCS_URL }),
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
  },
  purge: (ctx: OwnerContext) => purgeMedia(ctx),
} satisfies OwnerDomain;
