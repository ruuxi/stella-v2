import { File, Paths } from "expo-file-system";
import { env } from "../config/env";
import { getConvexToken } from "./auth-token";
import { getJson, postJson } from "./http";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      const error = new Error("Image generation was canceled.");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });

const imageEntries = (output) => {
  if (!output || typeof output !== "object" || !Array.isArray(output.images)) {
    return [];
  }
  return output.images.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim())
      return [{ url: entry.trim() }];
    if (!entry || typeof entry !== "object" || typeof entry.url !== "string") {
      return [];
    }
    return [
      {
        url: entry.url,
        mimeType:
          typeof entry.mimeType === "string"
            ? entry.mimeType
            : typeof entry.content_type === "string"
              ? entry.content_type
              : undefined,
      },
    ];
  });
};

const extensionFor = (mimeType, url) => {
  const mime = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  const fromUrl = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)?.[1];
  return /^(png|jpe?g|webp|gif)$/i.test(fromUrl ?? "")
    ? fromUrl.toLowerCase().replace("jpeg", "jpg")
    : "png";
};

const materialize = async (jobId, entries) => {
  const paths = [];
  for (const [index, entry] of entries.entries()) {
    const response = await fetch(entry.url);
    if (!response.ok)
      throw new Error(`Generated image download failed (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("Generated image was empty.");
    const mimeType = response.headers.get("content-type") ?? entry.mimeType;
    const file = new File(
      Paths.document,
      `stella-generated-${jobId}-${index}.${extensionFor(mimeType, entry.url)}`,
    );
    file.create({ overwrite: true, intermediates: true });
    file.write(bytes);
    paths.push(file.uri);
  }
  return paths;
};

const cancelJob = async (idempotencyKey) => {
  if (!env.convexSiteUrl) return;
  const token = await getConvexToken().catch(() => "");
  await fetch(`${env.convexSiteUrl}/api/media/v1/job`, {
    method: "DELETE",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Idempotency-Key": idempotencyKey,
    },
  }).catch(() => undefined);
};

export async function generateChatImage(input, options = {}) {
  const idempotencyKey = `mobile-chat-image-${options.toolCallId}`.slice(
    0,
    200,
  );
  let accepted;
  try {
    accepted = await postJson(
      "/api/media/v1/generate",
      {
        capability: "text_to_image",
        prompt: input.prompt,
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        input: {
          quality: "low",
          ...(input.numImages > 1 ? { num_images: input.numImages } : {}),
        },
      },
      { headers: { "Idempotency-Key": idempotencyKey }, timeoutMs: 30_000 },
    );
    const jobId = typeof accepted?.jobId === "string" ? accepted.jobId : "";
    if (!jobId) throw new Error("Image generation returned no job identity.");
    options.onUpdate?.({ jobId, status: accepted.status ?? "queued" });
    for (;;) {
      if (options.signal?.aborted) {
        await cancelJob(idempotencyKey);
        const error = new Error("Image generation was canceled.");
        error.name = "AbortError";
        throw error;
      }
      const job = await getJson(
        `/api/media/v1/job?jobId=${encodeURIComponent(jobId)}`,
        { timeoutMs: 30_000 },
      );
      options.onUpdate?.({ jobId, status: job.status });
      if (job.status === "succeeded") {
        const entries = imageEntries(job.output);
        if (entries.length === 0)
          throw new Error("Image generation returned no image.");
        return { jobId, filePaths: await materialize(jobId, entries) };
      }
      if (
        job.status === "failed" ||
        job.status === "canceled" ||
        job.status === "unknown"
      ) {
        const message =
          typeof job.error?.message === "string"
            ? job.error.message
            : `Image generation ${job.status}.`;
        const error = new Error(message);
        error.status = job.status;
        throw error;
      }
      await sleep(1_500, options.signal);
    }
  } catch (error) {
    if (options.signal?.aborted && accepted?.jobId)
      await cancelJob(idempotencyKey);
    throw error;
  }
}
