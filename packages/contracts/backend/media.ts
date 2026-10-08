/**
 * Managed media generation on Stella's fal account, billed to the owner's
 * plan. The models are the list in `@stella/contracts/media-models`; a
 * request names one and sends that model's own input, untouched.
 *
 * A job is one row in the owner's object. Provider outputs are copied into
 * Stella's media bucket, and a job's `output` keeps the model's own shape
 * with every file `url` replaced by a presigned GET (`r2Key` names the
 * stored object). Jobs settle through fal's webhook, so clients watch
 * `media.job`.
 *
 * The same calls are served over HTTP for the CLI and API clients:
 * `/api/media/v1/{models,generate,job}` on the backend origin.
 */

import type { MediaModelKind } from "../media-models.js";

export type MediaJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type MediaJobError = {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
};

export type MediaGenerateRequest = {
  /** A model id from `media.models`, e.g. `google/lyria-3.5`. */
  model: string;
  /**
   * The model's own input, as its docs page describes it. A file may be an
   * http(s) URL or a `data:` URI anywhere in it; data URIs are stored and
   * passed on as URLs.
   */
  input: Record<string, unknown>;
  /**
   * Idempotency key: a retry with the same key and request reattaches to
   * the first job; the same key with a different request is a conflict.
   */
  clientRequestKey?: string;
  /** Hash of the request as sent, for the conflict check; computed when absent. */
  requestHash?: string;
};

export type MediaGenerateAccepted = {
  jobId: string;
  model: string;
  status: MediaJobStatus;
  /** True when this answer reattached to an existing idempotent request. */
  reattached?: boolean;
  /** Present when the job had already finished. */
  output?: unknown;
};

export type MediaJob = {
  jobId: string;
  model: string;
  kind: MediaModelKind;
  status: MediaJobStatus;
  /** The input as submitted; inline sources appear as signed URLs. */
  input: Record<string, unknown>;
  output?: unknown;
  error?: MediaJobError;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

/** A model as `media.models` lists it. */
export type MediaModelListing = {
  id: string;
  name: string;
  kind: MediaModelKind;
  does: string;
  docsUrl: string;
};

export type MediaCalls = {
  "media.models": {
    args: Record<string, never>;
    result: { data: MediaModelListing[]; docsUrl: string };
  };
  /**
   * Start a job. Refused with `FORBIDDEN` (reason `capability_required`)
   * when the plan lacks the surface, `RATE_LIMITED` when usage or the
   * request rate is spent.
   */
  "media.generate": {
    args: MediaGenerateRequest;
    result: MediaGenerateAccepted;
  };
  /** Cancel by job id or idempotency key. Repeating it is safe. */
  "media.cancel": {
    args: { jobId?: string; clientRequestKey?: string };
    result: { state: "canceled" | "terminal" | "not_found"; jobId?: string };
  };
};

export type MediaViews = {
  "media.job": {
    args: { jobId: string };
    result: MediaJob | null;
  };
  /** Jobs updated at or after `since`, newest first. */
  "media.jobs": {
    args: { since: number; status?: MediaJobStatus; limit?: number };
    result: MediaJob[];
  };
};
