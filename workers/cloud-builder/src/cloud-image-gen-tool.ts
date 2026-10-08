/**
 * `image_gen` for the cloud orchestrator.
 *
 * Desktop's tool (`packages/runtime/kernel/tools/media.ts`) drives the managed
 * media API and materializes the result under ~/.stella/media/outputs. There
 * is no local disk here, so this one starts the job in the owner's object
 * (`media.generateForTurn`, keyed by turn and tool call), polls `media.lookup`
 * under the same key, and lands the finished image in the owner's drive. The
 * drive file is what both chat clients render and what the user keeps; the
 * tool result also carries the media job id so the desktop can materialize
 * its own copy the way it does for every media job.
 *
 * BYOK does not exist here: provider keys live on the user's device, so every
 * cloud generation is Stella managed and metered like any other managed job.
 */

import type { TSchema } from "@sinclair/typebox";
import { sleepWithAbort } from "@stella/runtime/kernel/tools/effect-runtime.js";
import type { AgentTool } from "@stella/runtime/kernel/agent-core/types.js";
import type { MediaGenerateAccepted, MediaJob } from "@stella/contracts/backend/media";
import { stellaImageRequest } from "@stella/contracts/media-models";
import { readBoundedResponseBytes } from "./bounded-body.js";
import { sha256Hex } from "./hash.js";
import { RpcError } from "./owner-store/errors.js";
import type { ReplayableAgentTool } from "./tool-replay.js";
import type { OwnerInternalCall } from "./owner-store/registry.js";
import type { DriveTurnFilesResult } from "./owner-store/domains/drive.js";

export const CLOUD_IMAGE_GEN_TOOL_NAME = "image_gen";

/** Mirrors `MAX_MANAGED_IMAGE_REFERENCE_ITEMS` on the desktop tool. */
const MAX_REFERENCE_ITEMS = 4;
/** The drive's inline upload cap; a generated still is well under it. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Fal image endpoints settle in seconds; a turn has a 15-minute wall clock. */
const JOB_TIMEOUT_MS = 10 * 60_000;
const ARTIFACT_GRACE_MS = 60_000;
const INITIAL_POLL_MS = 750;
const MAX_POLL_MS = 5_000;
const SUBMIT_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Drive folder generated images land in, bucketed by day like uploads. */
const DRIVE_OUTPUT_PREFIX = "images";
/** Drive reference URLs are signed as of the start of this window. */
const REFERENCE_SIGNING_BUCKET_MS = 60 * 60_000;

const HTTP_URL_RE = /^https?:\/\//i;

export type CloudImageGenDriveFile = {
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
};

export type CloudImageGenToolContext = {
  ownerGeneration: string;
  conversationId: string;
  turnId: string;
  /** A server-internal operation on the owner's object, under the turn's generation. */
  ownerInternal: OwnerInternalCall;
  /** Append a `files` card to this turn so the chat and drive UIs list the image. */
  publishFiles: (writerKey: string, files: CloudImageGenDriveFile[]) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
};

type CloudImageGenArgs = {
  prompt?: unknown;
  aspectRatio?: unknown;
  aspect_ratio?: unknown;
  size?: unknown;
  quality?: unknown;
  referenceImageUrls?: unknown;
  referenceDrivePaths?: unknown;
};

type MediaJobStatus = MediaJob["status"];

type RemoteImage = { url: string; mimeType?: string };

export type CloudImageGenArtifact = {
  kind: "image";
  index: number;
  path: string;
  mimeType: string;
  sizeBytes: number;
};

export type CloudImageGenDetails =
  | {
      status: "succeeded";
      jobId: string;
      model: string;
      prompt: string;
      aspectRatio?: string;
      requestedSize?: { width: number; height: number };
      /** Drive paths, newest generation first. Never local paths. */
      drivePaths: string[];
      artifacts: CloudImageGenArtifact[];
      reattached: boolean;
      completedAt?: number;
    }
  | {
      status: "failed" | "canceled" | "unknown";
      jobId?: string;
      prompt: string;
      error: { code: string; message: string; reason?: unknown };
      reattached: boolean;
    };

export const CLOUD_IMAGE_GEN_TOOL_DESCRIPTION =
  "Generate a still image with Stella's managed image provider. The call stays pending until the job settles: on success the image is saved into the user's drive and shown in the chat, and the result lists its drive path(s). Never retry or parallel-submit a pending call; Stella reattaches to the same job on a lost response. Do not poll, download, or open the result yourself. Required: prompt.";

export const CLOUD_IMAGE_GEN_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description:
        "Description of the image to generate. Be specific about subject, style, framing, color, lighting, and any text overlays.",
    },
    aspectRatio: {
      type: "string",
      description:
        "Optional aspect ratio (e.g. '1:1', '16:9', '9:16', '4:3'). Defaults to the model's choice.",
    },
    size: {
      type: "object",
      description:
        "Optional explicit pixel dimensions. Only set this when the default aspectRatio presets won't do. Subject to the model envelope: max edge ≤ 3840, 655,360 ≤ width × height ≤ 8,294,400, longest edge ≤ 3× shortest edge.",
      properties: {
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
      },
      required: ["width", "height"],
    },
    quality: {
      type: "string",
      enum: ["low", "medium", "high", "xhigh", "max"],
      description:
        "Optional quality. Defaults to 'low'; use a higher one only when the user explicitly asks for more fidelity.",
    },
    referenceImageUrls: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_REFERENCE_ITEMS,
      description:
        "Optional public http(s) image URLs to use as reference inputs. At most four references in total across URLs and drive paths. When any reference is provided the image is an edit of them.",
    },
    referenceDrivePaths: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_REFERENCE_ITEMS,
      description:
        "Optional paths of image files in the user's drive to use as reference inputs — the paths listed under 'Attached in my drive' in the user's message, or files a previous turn produced. Only use images the user asked you to work from.",
    },
  },
  required: ["prompt"],
} as const;

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const collectStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const trimmed = asNonEmptyString(entry);
    if (trimmed) out.push(trimmed);
  }
  return out;
};



/** Same envelope the desktop tool checks locally, for the same clear errors. */
const validateSize = (
  value: unknown,
): { width: number; height: number } | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as { width?: unknown; height?: unknown };
  const width =
    typeof record.width === "number" ? Math.floor(record.width) : NaN;
  const height =
    typeof record.height === "number" ? Math.floor(record.height) : NaN;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error(
      "image_gen size requires positive integer width and height.",
    );
  }
  const maxEdge = Math.max(width, height);
  const minEdge = Math.min(width, height);
  const pixelArea = width * height;
  if (maxEdge > 3840) {
    throw new Error(
      `image_gen size max edge ${maxEdge} exceeds 3840.`,
    );
  }
  if (pixelArea < 655_360 || pixelArea > 8_294_400) {
    throw new Error(
      `image_gen size pixel area ${pixelArea} is outside 655,360–8,294,400.`,
    );
  }
  if (maxEdge > minEdge * 3) {
    throw new Error(
      `image_gen size aspect ratio ${maxEdge}:${minEdge} is steeper than 3:1.`,
    );
  }
  return { width, height };
};

const abortError = (signal: AbortSignal): Error => {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === "string" && signal.reason.trim()
      ? signal.reason
      : "Image generation was canceled.",
  );
  error.name = "AbortError";
  return error;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError(signal);
};

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  sleepWithAbort(ms, signal, abortError);

const withTimeout = (
  timeoutMs: number,
  signal?: AbortSignal,
): AbortSignal =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

const extractRemoteImages = (output: unknown): RemoteImage[] => {
  if (!output || typeof output !== "object") return [];
  const images = (output as Record<string, unknown>).images;
  if (!Array.isArray(images)) return [];
  return images
    .map((entry): RemoteImage | null => {
      if (typeof entry === "string") return { url: entry };
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const url = asNonEmptyString(record.url);
      if (!url) return null;
      const mimeType =
        asNonEmptyString(record.mimeType) ??
        asNonEmptyString(record.content_type) ??
        undefined;
      return { url, ...(mimeType ? { mimeType } : {}) };
    })
    .filter((entry): entry is RemoteImage => entry !== null);
};

/** The bytes decide the type; a declared content-type is only a hint. */
const sniffImageMimeType = (bytes: Uint8Array): string | null => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  return null;
};

const extensionForMime = (mimeType: string): string => {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
};

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
};

const statusText = (status: MediaJobStatus): string =>
  status === "queued"
    ? "Image generation is queued…"
    : status === "running"
      ? "Generating image…"
      : status === "succeeded"
        ? "Saving generated image…"
        : "Image generation finished.";

const drivePathFor = (jobId: string, index: number, mimeType: string, now: number): string => {
  const day = new Date(now).toISOString().slice(0, 10);
  return `${DRIVE_OUTPUT_PREFIX}/${day}/${jobId}_${index}.${extensionForMime(mimeType)}`;
};

export const createCloudImageGenTool = (
  context: CloudImageGenToolContext,
): ReplayableAgentTool => ({
  name: CLOUD_IMAGE_GEN_TOOL_NAME,
  // One gateway job per (owner generation, conversation, turn, tool call):
  // a rerun reattaches to the job it already submitted, never regenerates.
  replay: "keyed",
  label: "Generate image",
  workingText: "Generating image",
  description: CLOUD_IMAGE_GEN_TOOL_DESCRIPTION,
  parameters: CLOUD_IMAGE_GEN_TOOL_PARAMETERS as unknown as TSchema,
  // Direct-only on purpose: a generation is metered work with a durable
  // side effect (a drive file), never something `code` should loop over.
  execute: async (toolCallId, params, signal, onUpdate) => {
    const args = params as CloudImageGenArgs;
    const prompt = asNonEmptyString(args.prompt);
    if (!prompt) throw new Error("prompt is required.");

    const requestedSize = validateSize(args.size);
    const aspectRatio =
      asNonEmptyString(args.aspectRatio) ?? asNonEmptyString(args.aspect_ratio);
    const quality = asNonEmptyString(args.quality);
    const referenceUrls = collectStringList(args.referenceImageUrls);
    const referenceDrivePaths = collectStringList(args.referenceDrivePaths);
    if (referenceUrls.length + referenceDrivePaths.length > MAX_REFERENCE_ITEMS) {
      throw new Error(
        `image_gen accepts at most ${MAX_REFERENCE_ITEMS} reference images.`,
      );
    }
    for (const url of referenceUrls) {
      if (!HTTP_URL_RE.test(url)) {
        throw new Error(
          `referenceImageUrls entry is not an http(s) URL: ${url}. Use referenceDrivePaths for the user's own files.`,
        );
      }
    }

    const now = context.now ?? Date.now;
    // The provider cannot read the drive, so drive references become signed
    // GETs. They are signed as of the current hour, so a retried call signs
    // the same URLs and its request hash still finds the same job.
    const driveReferenceUrls =
      referenceDrivePaths.length > 0
        ? (
            (await context.ownerInternal("drive.signImages", {
              paths: referenceDrivePaths,
              signedAt: Math.floor(now() / REFERENCE_SIGNING_BUCKET_MS) * REFERENCE_SIGNING_BUCKET_MS,
            })) as { urls: string[] }
          ).urls
        : [];
    const imageUrls = [...referenceUrls, ...driveReferenceUrls];

    const requestBody = stellaImageRequest({ prompt, aspectRatio, size: requestedSize, quality, imageUrls });
    const sleep = context.sleep ?? defaultSleep;
    const fetchImpl = context.fetchImpl ?? fetch;
    const timeoutMs = context.timeoutMs ?? JOB_TIMEOUT_MS;
    // Stable across a retried tool call after a lost response: the same turn
    // and tool call reach the same media job instead of a second one.
    const clientRequestKey = `stella-image-gen-v1-${await sha256Hex(
      [
        "stella-cloud-image-gen-v1",
        context.ownerGeneration,
        context.conversationId,
        context.turnId,
        toolCallId,
      ].join("\0"),
    )}`;
    const deadline = now() + timeoutMs;
    let reattached = false;
    let lastSubmitError = "";

    const failure = (
      status: "failed" | "canceled" | "unknown",
      code: string,
      message: string,
      extra: { jobId?: string; reason?: unknown } = {},
    ) => {
      const details: CloudImageGenDetails = {
        status,
        ...(extra.jobId ? { jobId: extra.jobId } : {}),
        prompt,
        error: {
          code,
          message,
          ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
        },
        reattached,
      };
      return {
        content: [{ type: "text" as const, text: message }],
        details,
        isError: true,
      };
    };

    const lookup = async (args: { jobId?: string; clientRequestKey?: string }) =>
      (await context.ownerInternal("media.lookup", args)) as MediaJob | null;

    let jobId: string | null = null;
    try {
      for (let attempt = 0; !jobId && attempt < SUBMIT_ATTEMPTS; attempt += 1) {
        throwIfAborted(signal);
        try {
          const accepted = (await context.ownerInternal("media.generateForTurn", {
            request: { ...requestBody, clientRequestKey },
            conversationId: context.conversationId,
            turnId: context.turnId,
          })) as MediaGenerateAccepted;
          jobId = accepted.jobId;
          if (accepted.reattached === true) reattached = true;
          break;
        } catch (error) {
          throwIfAborted(signal);
          lastSubmitError = (error as Error).message;
          if (error instanceof RpcError && !error.retryable) {
            return failure("failed", `submission_${error.code.toLowerCase()}`, error.message);
          }
        }
        try {
          const existing = await lookup({ clientRequestKey });
          if (existing) {
            jobId = existing.jobId;
            reattached = true;
            break;
          }
        } catch {
          // Reconciliation is best effort; the next attempt tries again.
        }
        await sleep(Math.min(250 * 2 ** attempt, 1_000), signal);
      }
      if (!jobId) {
        return failure(
          "unknown",
          "submission_outcome_unknown",
          "Stella could not confirm whether the image request was accepted. It will not submit a duplicate.",
          lastSubmitError ? { reason: { cause: lastSubmitError } } : {},
        );
      }

      let pollMs = INITIAL_POLL_MS;
      let artifactDeadline: number | null = null;
      let lastJob: MediaJob | null = null;
      while (now() < deadline) {
        throwIfAborted(signal);
        try {
          const value = await lookup({ jobId });
          if (!value) {
            return failure("failed", "job_lookup_not_found", "The image job no longer exists.", { jobId });
          }
          lastJob = value;
          onUpdate?.({
            content: [{ type: "text", text: statusText(value.status) }],
            details: {
              jobId,
              status: value.status,
              statusText: statusText(value.status),
            },
          });
          if (value.status === "failed" || value.status === "canceled") {
            return failure(
              value.status,
              asNonEmptyString(value.error?.code)?.toLowerCase() ?? value.status,
              asNonEmptyString(value.error?.message) ?? `Image generation ${value.status}.`,
              {
                jobId,
                ...(value.error?.details !== undefined ? { reason: value.error.details } : {}),
              },
            );
          }
          if (value.status === "succeeded") {
            artifactDeadline ??= Math.min(deadline, now() + ARTIFACT_GRACE_MS);
            const images = extractRemoteImages(value.output);
            if (images.length > 0) {
              try {
                const saved = await saveImagesToDrive({
                  context,
                  fetchImpl,
                  jobId,
                  toolCallId,
                  images,
                  signal,
                  now: now(),
                });
                const details: CloudImageGenDetails = {
                  status: "succeeded",
                  jobId,
                  model: value.model,
                  prompt,
                  ...(aspectRatio ? { aspectRatio } : {}),
                  ...(requestedSize ? { requestedSize } : {}),
                  drivePaths: saved.map((artifact) => artifact.path),
                  artifacts: saved,
                  reattached,
                  ...(typeof value.completedAt === "number" ? { completedAt: value.completedAt } : {}),
                };
                const listed = saved.map((artifact) => artifact.path).join(", ");
                return {
                  content: [
                    {
                      type: "text",
                      text: `Generated ${saved.length} image${saved.length === 1 ? "" : "s"} and saved ${saved.length === 1 ? "it" : "them"} to the user's drive: ${listed}. The image is already shown in the chat; do not link or describe the file path unless asked.`,
                    },
                  ],
                  details,
                };
              } catch (error) {
                throwIfAborted(signal);
                if (now() >= artifactDeadline) {
                  return failure(
                    "failed",
                    "artifact_materialization_failed",
                    `Image completed but its artifact could not be saved: ${(error as Error).message}`,
                    { jobId },
                  );
                }
              }
            } else if (now() >= artifactDeadline) {
              return failure(
                "failed",
                "artifact_missing",
                "Image generation completed without a downloadable artifact.",
                { jobId },
              );
            }
          }
        } catch (error) {
          throwIfAborted(signal);
          // Transient lookup failures reattach on the next poll.
        }
        await sleep(Math.min(pollMs, Math.max(1, deadline - now())), signal);
        pollMs = Math.min(MAX_POLL_MS, Math.max(INITIAL_POLL_MS, pollMs * 1.5));
      }
      const timeoutMinutes = Math.max(1, Math.ceil(timeoutMs / 60_000));
      return failure(
        "unknown",
        "terminal_outcome_unknown",
        `Image generation still had no durable terminal outcome after ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}. Stella did not cancel or resubmit it.`,
        { jobId, ...(lastJob?.error ? { reason: lastJob.error } : {}) },
      );
    } catch (error) {
      if (signal?.aborted) {
        // Cancelling is idempotent and keyed like the submission.
        await context
          .ownerInternal("media.cancelForTurn", { clientRequestKey })
          .catch(() => undefined);
        throw abortError(signal);
      }
      throw error;
    }
  },
});

const saveImagesToDrive = async (args: {
  context: CloudImageGenToolContext;
  fetchImpl: typeof fetch;
  jobId: string;
  toolCallId: string;
  images: RemoteImage[];
  signal?: AbortSignal;
  now: number;
}): Promise<CloudImageGenArtifact[]> => {
  const files: Array<{
    path: string;
    name: string;
    sizeBytes: number;
    contentType: string;
    contentBase64: string;
  }> = [];
  for (const [index, image] of args.images.entries()) {
    throwIfAborted(args.signal);
    const response = await args.fetchImpl(image.url, {
      signal: withTimeout(DOWNLOAD_TIMEOUT_MS, args.signal),
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`Image artifact download failed (${response.status}).`);
    }
    const bytes = await readBoundedResponseBytes(response, MAX_IMAGE_BYTES);
    const mimeType = sniffImageMimeType(bytes);
    if (!mimeType) {
      throw new Error(
        "Image artifact was partial or had an unsupported MIME type.",
      );
    }
    const path = drivePathFor(args.jobId, index, mimeType, args.now);
    files.push({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      sizeBytes: bytes.byteLength,
      contentType: mimeType,
      contentBase64: encodeBase64(bytes),
    });
  }

  throwIfAborted(args.signal);
  const payload = (await args.context.ownerInternal("drive.turnFiles", {
    turnId: args.context.turnId,
    hydratesDrive: false,
    source: "image_gen",
    batchKey: args.toolCallId,
    files,
  })) as DriveTurnFilesResult;
  const stored = new Set(
    payload.files.filter((file) => file.stored).map((file) => file.path),
  );
  const artifacts: CloudImageGenArtifact[] = [];
  const cardFiles: CloudImageGenDriveFile[] = [];
  for (const [index, file] of files.entries()) {
    if (!stored.has(file.path)) continue;
    artifacts.push({
      kind: "image",
      index,
      path: file.path,
      mimeType: file.contentType,
      sizeBytes: file.sizeBytes,
    });
    cardFiles.push({
      path: file.path,
      name: file.name,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
    });
  }
  if (artifacts.length === 0) {
    const reason = asNonEmptyString(payload?.skipped?.[0]?.reason);
    throw new Error(reason ?? "The drive did not accept the generated image.");
  }
  args.context.publishFiles(`image_gen:${args.toolCallId}`, cardFiles);
  return artifacts;
};
