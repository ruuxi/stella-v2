/**
 * Managed media generation: images, video, audio, music, 3D and speech to
 * text, run on Stella's provider accounts and billed to the owner's plan.
 *
 * A job is one row in the owner's object. Provider outputs are copied into
 * Stella's media bucket, and a job's `output` keeps the provider's shape
 * with every file `url` replaced by a presigned GET (`r2Key` names the
 * stored object). Music and speech to text finish inside `media.generate`;
 * everything else settles later through the provider's webhook, so clients
 * watch `media.job`.
 *
 * The same calls are served over HTTP for the CLI and API clients:
 * `/api/media/v1/{capabilities,generate,job}` on the backend origin.
 */

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

/** A source file inline: base64 bytes and their type. */
export type MediaBase64Source = {
  base64: string;
  mimeType: string;
  fileName?: string;
};

/** An http(s) URL, a `data:` URI, or inline base64. */
export type MediaSourceReference = string | MediaBase64Source;

export type MediaGenerateRequest = {
  /** A capability id from `media.capabilities`, e.g. `text_to_image`. */
  capability: string;
  prompt?: string;
  aspectRatio?: string;
  sourceUrl?: string;
  source?: MediaSourceReference;
  /** Named sources, e.g. `{ image, video, audio, reference_image }`. */
  sources?: Record<string, MediaSourceReference>;
  /** Provider input, merged under the convenience fields above. */
  input?: Record<string, unknown>;
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
  capability: string;
  status: MediaJobStatus;
  /** True when this answer reattached to an existing idempotent request. */
  reattached?: boolean;
  /** Present when the job finished inside the call (music, speech to text). */
  output?: unknown;
};

export type MediaRequestSummary = {
  prompt?: string;
  aspectRatio?: string;
  /** The provider input as submitted; inline sources appear as signed URLs. */
  input?: Record<string, unknown>;
};

export type MediaJob = {
  jobId: string;
  capability: string;
  status: MediaJobStatus;
  request: MediaRequestSummary;
  output?: unknown;
  error?: MediaJobError;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type MediaCapability = {
  id: string;
  name: string;
  description: string;
  category: "audio" | "image" | "video" | "3d" | "analysis";
  provider: "fal" | "google_lyria" | "openrouter";
  endpointId: string;
  docsUrl: string;
  promptKey?: string;
  sourceUrlKey?: string;
  requiresSourceUrl?: boolean;
  supportsAspectRatio?: boolean;
  inputHints: string[];
  outputHints: string[];
};

export type MediaCalls = {
  "media.capabilities": {
    args: Record<string, never>;
    result: { data: MediaCapability[]; docsUrl: string };
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
