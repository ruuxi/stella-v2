#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { resolveStatePath } from "./shared.js";
import { sleepMs } from "./effect-runtime.js";

type MediaJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "unknown";

type MediaJobError = {
  message?: string;
  code?: string;
};

type MediaJob = {
  jobId: string;
  model?: string;
  status: MediaJobStatus;
  output?: unknown;
  error?: MediaJobError;
  completedAt?: number;
  updatedAt?: number;
};

type AcceptedMediaJob = {
  jobId: string;
  model?: string;
  status?: MediaJobStatus;
};

type OutputFile = {
  kind: "image" | "video" | "audio" | "download";
  url: string;
  path: string;
};

type CliOptions = {
  command: string;
  request?: string;
  requestFile?: string;
  jobId?: string;
  wait: boolean;
  save: boolean;
  json: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
};

const usage = `stella-media - run Stella's media models (images, video, music, speech, transcription, 3D)

Usage:
  stella-media models [--json]
  stella-media generate --request '<json>' [--wait] [--timeout 600] [--json]
  stella-media generate --request-file request.json [--wait] [--timeout 600] [--json]
  stella-media status --job-id <jobId> [--save] [--json]

A request is {"model": "<id from models>", "input": {...}}: the model's own
input, exactly as the docs page \`models\` lists for it describes. A local
file goes in as a file:// URL (e.g. "image_url": "file:///home/me/cat.png");
it is uploaded with the request.

Environment:
  STELLA_MEDIA_BASE_URL       Stella backend URL
  STELLA_MEDIA_AUTH_TOKEN     Stella bearer token
`;

const terminalStatuses = new Set<MediaJobStatus>([
  "succeeded",
  "failed",
  "canceled",
  "unknown",
]);

const parseDurationSeconds = (
  value: string | undefined,
  fallbackMs: number,
): number => {
  if (!value) return fallbackMs;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.floor(parsed * 1000);
};

const parseArgs = (argv: string[]): CliOptions => {
  const [command = "help", ...rest] = argv;
  const options: CliOptions = {
    command: command === "-h" || command === "--help" ? "help" : command,
    wait: false,
    save: false,
    json: false,
    timeoutMs: 600_000,
    pollIntervalMs: 2_000,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    switch (arg) {
      case "--request":
        options.request = rest[++i];
        break;
      case "--request-file":
        options.requestFile = rest[++i];
        break;
      case "--job-id":
        options.jobId = rest[++i];
        break;
      case "--wait":
        options.wait = true;
        break;
      case "--save":
        options.save = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--timeout":
        options.timeoutMs = parseDurationSeconds(rest[++i], options.timeoutMs);
        break;
      case "--poll-interval":
        options.pollIntervalMs = parseDurationSeconds(
          rest[++i],
          options.pollIntervalMs,
        );
        break;
      case "-h":
      case "--help":
        options.command = "help";
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
};

const getAuth = (): {
  baseUrl: string;
  authToken: string;
  deviceId?: string;
} => {
  const baseUrl =
    process.env.STELLA_MEDIA_BASE_URL?.trim() ||
    process.env.STELLA_BACKEND_URL?.trim() ||
    "";
  const authToken =
    process.env.STELLA_MEDIA_AUTH_TOKEN?.trim() ||
    process.env.STELLA_AUTH_TOKEN?.trim() ||
    process.env.STELLA_LLM_PROXY_TOKEN?.trim() ||
    "";
  if (!baseUrl || !authToken) {
    throw new Error(
      "stella-media requires Stella sign-in. Open Stella and finish signing in, then retry.",
    );
  }
  const deviceId = process.env.STELLA_DEVICE_ID?.trim() || undefined;
  return { baseUrl, authToken, ...(deviceId ? { deviceId } : {}) };
};

const mediaUrl = (baseUrl: string, pathname: string): string =>
  new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

const requestHeaders = (auth: {
  authToken: string;
  deviceId?: string;
}): Record<string, string> => ({
  Authorization: `Bearer ${auth.authToken}`,
  ...(auth.deviceId ? { "X-Device-ID": auth.deviceId } : {}),
});

const fetchJson = async <T>(url: string, init: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = "";
    try {
      const body = (await response.json()) as {
        error?: string;
        message?: string;
      };
      message = body.error ?? body.message ?? "";
    } catch {
      message = await response.text().catch(() => "");
    }
    throw new Error(
      message || `Stella media request failed with status ${response.status}.`,
    );
  }
  return (await response.json()) as T;
};

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

/** Every `file://` URL in the input, read and sent inline as a data URI. */
const inlineLocalFiles = async (value: unknown): Promise<unknown> => {
  if (typeof value === "string" && value.startsWith("file://")) {
    const filePath = new URL(value).pathname;
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const mimeType = MIME_TYPES[extension] ?? "application/octet-stream";
    return `data:${mimeType};base64,${(await readFile(filePath)).toString("base64")}`;
  }
  if (Array.isArray(value)) return await Promise.all(value.map(inlineLocalFiles));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = await inlineLocalFiles(entry);
    }
    return out;
  }
  return value;
};

const readRequestBody = async (options: CliOptions): Promise<unknown> => {
  const raw = options.request
    ? options.request
    : options.requestFile
      ? await readFile(path.resolve(options.requestFile), "utf-8")
      : null;
  if (raw === null) {
    throw new Error("generate requires --request or --request-file.");
  }
  return await inlineLocalFiles(JSON.parse(raw) as unknown);
};

const submitJob = async (body: unknown): Promise<AcceptedMediaJob> => {
  const auth = getAuth();
  return await fetchJson<AcceptedMediaJob>(
    mediaUrl(auth.baseUrl, "/api/media/v1/generate"),
    {
      method: "POST",
      headers: {
        ...requestHeaders(auth),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
};

const getJob = async (jobId: string): Promise<MediaJob> => {
  const auth = getAuth();
  const url = new URL(mediaUrl(auth.baseUrl, "/api/media/v1/job"));
  url.searchParams.set("jobId", jobId);
  return await fetchJson<MediaJob>(url.toString(), {
    method: "GET",
    headers: requestHeaders(auth),
  });
};

// Effect-backed sleep (kernel/cli/effect-runtime.ts); poll pacing timing
// is unchanged.
const sleep = async (ms: number): Promise<void> => await sleepMs(ms);

const waitForJob = async (
  jobId: string,
  options: Pick<CliOptions, "timeoutMs" | "pollIntervalMs" | "json">,
): Promise<MediaJob> => {
  const deadline = Date.now() + options.timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const job = await getJob(jobId);
    if (job.status !== lastStatus && !options.json) {
      process.stderr.write(`media job ${jobId}: ${job.status}\n`);
      lastStatus = job.status;
    }
    if (terminalStatuses.has(job.status)) {
      return job;
    }
    await sleep(
      Math.min(options.pollIntervalMs, Math.max(250, deadline - Date.now())),
    );
  }
  throw new Error(
    `Media job ${jobId} is still running; check it later with: stella-media status --job-id ${jobId} --save`,
  );
};

/** The model's own complaint, which says what to change in the input. */
const mediaFailure = (error: MediaJobError | undefined): string =>
  `Media generation failed: ${error?.message || "unknown error"}${error?.code ? ` (${error.code})` : ""}`;

const extensionFromUrl = (
  url: string,
  fallback: string,
  contentType?: string | null,
): string => {
  const fromUrl = url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1];
  if (fromUrl) return fromUrl.toLowerCase();
  if (contentType?.includes("jpeg")) return "jpg";
  if (contentType?.includes("png")) return "png";
  if (contentType?.includes("webp")) return "webp";
  if (contentType?.includes("mp4")) return "mp4";
  if (contentType?.includes("mpeg")) return "mp3";
  if (contentType?.includes("wav")) return "wav";
  return fallback;
};

const KIND_BY_KEY: Record<string, { kind: OutputFile["kind"]; ext: string }> = {
  images: { kind: "image", ext: "png" },
  image: { kind: "image", ext: "png" },
  video: { kind: "video", ext: "mp4" },
  audio: { kind: "audio", ext: "mp3" },
  audio_file: { kind: "audio", ext: "mp3" },
};

/** Every file the output names (`{ url }` anywhere in it), each once. */
const outputUrls = (
  output: unknown,
): Array<{
  kind: OutputFile["kind"];
  url: string;
  fallbackExt: string;
  fileExt?: string;
}> => {
  const found = new Map<
    string,
    { kind: OutputFile["kind"]; url: string; fallbackExt: string; fileExt?: string }
  >();
  const visit = (
    value: unknown,
    as: { kind: OutputFile["kind"]; ext: string },
    depth: number,
  ) => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, as, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.url === "string" && /^https?:/i.test(record.url)) {
      if (!found.has(record.url)) {
        // The model's own file name says what it is (`.glb`, `.wav`, …).
        const fileExt =
          typeof record.file_name === "string"
            ? record.file_name.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase()
            : undefined;
        found.set(record.url, {
          kind: as.kind,
          url: record.url,
          fallbackExt: as.ext,
          ...(fileExt ? { fileExt } : {}),
        });
      }
    }
    for (const [key, entry] of Object.entries(record)) {
      visit(entry, KIND_BY_KEY[key] ?? as, depth + 1);
    }
  };
  visit(output, { kind: "download", ext: "bin" }, 0);
  return [...found.values()];
};

const saveOutputs = async (job: MediaJob): Promise<OutputFile[]> => {
  const urls = outputUrls(job.output);
  if (urls.length === 0) return [];
  const outputDir = path.join(resolveStatePath(), "media", "outputs");
  await mkdir(outputDir, { recursive: true });

  const files: OutputFile[] = [];
  for (const [index, item] of urls.entries()) {
    const response = await fetch(item.url);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download media output (${response.status}).`);
    }
    const ext =
      item.fileExt ??
      extensionFromUrl(
        item.url,
        item.fallbackExt,
        response.headers.get("content-type"),
      );
    const suffix = urls.length > 1 ? `_${index}` : "";
    const filePath = path.join(outputDir, `${job.jobId}${suffix}.${ext}`);
    await pipeline(response.body, createWriteStream(filePath));
    files.push({ kind: item.kind, url: item.url, path: filePath });
  }
  return files;
};

const print = (value: unknown, json: boolean): void => {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
};

const handleTerminalJob = async (
  job: MediaJob,
  options: Pick<CliOptions, "json" | "save">,
): Promise<number> => {
  if (job.status === "succeeded") {
    const files = options.save ? await saveOutputs(job) : [];
    if (options.json) {
      print({ job, files }, true);
    } else {
      print(`Media job ${job.jobId} completed.`, false);
      for (const file of files) {
        print(`${file.kind}: ${file.path}`, false);
      }
    }
    return 0;
  }

  const message = mediaFailure(job.error);
  if (options.json) {
    print({ job, error: message }, true);
  } else {
    process.stderr.write(`${message}\n`);
  }
  return 1;
};

const run = async (): Promise<number> => {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    print(usage, false);
    return 0;
  }

  if (options.command === "models") {
    const auth = getAuth();
    const result = await fetchJson<{
      data: Array<{ id: string; kind: string; does: string; docsUrl: string }>;
    }>(mediaUrl(auth.baseUrl, "/api/media/v1/models"), {
      method: "GET",
      headers: requestHeaders(auth),
    });
    if (options.json) {
      print(result, true);
    } else {
      for (const model of result.data) {
        print(`${model.id}  [${model.kind}]  ${model.does}\n  docs: ${model.docsUrl}`, false);
      }
    }
    return 0;
  }

  if (options.command === "generate") {
    const body = await readRequestBody(options);
    const accepted = await submitJob(body);
    if (!options.wait) {
      print(accepted, options.json);
      return 0;
    }
    if (!accepted.jobId) {
      throw new Error("Media gateway did not return a jobId.");
    }
    if (!options.json) {
      process.stderr.write(`media job ${accepted.jobId}: submitted\n`);
    }
    const job = await waitForJob(accepted.jobId, options);
    return await handleTerminalJob(job, { ...options, save: true });
  }

  if (options.command === "status") {
    if (!options.jobId) throw new Error("status requires --job-id.");
    const job = await getJob(options.jobId);
    if (!terminalStatuses.has(job.status)) {
      print(job, options.json);
      return 0;
    }
    return await handleTerminalJob(job, options);
  }

  throw new Error(`Unknown command: ${options.command}`);
};

run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = /took too long/i.test(message) ? 124 : 1;
  });
