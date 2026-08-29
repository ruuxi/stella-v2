/**
 * Shared xAI Grok STT transport.
 *
 * Both cloud transcription routes (desktop dictation in
 * `http_routes/dictation.ts` and the mobile / CarPlay composer in
 * `http_routes/mobile.ts`) speak to the same one-shot REST endpoint, so the
 * multipart envelope, the MIME table, and the response parse live here once.
 *
 * Deliberately transport-only: this module never meters usage, never touches
 * dispatch leases, and never builds HTTP responses. Each route keeps its own
 * billing/idempotency machinery around the call — they differ (dictation gates
 * on managed usage, mobile also binds a logical request id) and must stay
 * route-local.
 */

import {
  getManagedGatewayConfig,
  resolveManagedGatewayApiKey,
} from "./managed_gateway";

// xAI's REST STT endpoint has a single model and accepts no model selector.
// This internal label is only for Stella usage metering and diagnostics.
export const XAI_STT_MODEL_LABEL = "grok-stt-1.0";
// Grok STT REST list price as of 2026-08 (docs.x.ai): $0.10/hr.
export const XAI_STT_USD_PER_SECOND = 0.1 / 3600;

export type XaiSttErrorKind =
  | "invalid_base64"
  | "upstream"
  | "invalid_response"
  | "network";

/**
 * Typed failure so callers can map a transport problem onto their own status
 * codes (400 for client-supplied garbage, the upstream status when xAI
 * rejected the request, 502 otherwise) without re-parsing error strings.
 */
export class XaiSttError extends Error {
  constructor(
    readonly kind: XaiSttErrorKind,
    message: string,
    readonly upstreamStatus?: number,
    readonly upstreamBody?: string,
  ) {
    super(message);
    this.name = "XaiSttError";
  }
}

/**
 * The same org key the realtime Grok Voice path uses (`voice.ts`); it never
 * leaves the backend.
 */
export const resolveXaiSttApiKey = (): string | undefined =>
  resolveManagedGatewayApiKey(getManagedGatewayConfig("xai"));

const base64ToBytes = (base64: string): Uint8Array<ArrayBuffer> => {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    throw new XaiSttError("invalid_base64", "Audio is not valid base64");
  }
};

const mimeTypeForFormat = (format: string): string => {
  switch (format) {
    case "mp3":
      return "audio/mpeg";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "webm":
      return "audio/webm";
    case "aac":
      return "audio/aac";
    case "wav":
    default:
      return "audio/wav";
  }
};

/**
 * Pre-flight for callers that must reject malformed audio BEFORE taking a
 * billing lease. Throws the same `invalid_base64` error the transport does.
 */
export const assertXaiSttAudioBase64 = (base64: string): void => {
  base64ToBytes(base64);
};

export type XaiSttResult = {
  text: string;
  /** Audio seconds xAI billed for, when it reported them. */
  durationSeconds?: number;
};

/**
 * One-shot transcription. Throws `XaiSttError` for every failure mode so the
 * caller's `catch` can both record the attempt and choose a response.
 */
export const transcribeWithXaiRest = async (args: {
  apiKey: string;
  audioBase64: string;
  audioFormat: string;
  language?: string;
  /** Forwarded to `fetch` so account-change/caller aborts cut the upload. */
  signal?: AbortSignal;
}): Promise<XaiSttResult> => {
  const audioBytes = base64ToBytes(args.audioBase64);
  const language = args.language?.trim();
  const format = args.audioFormat.trim().toLowerCase();

  // xAI requires multipart/form-data, with the file field last. Container
  // formats (WAV, MP3, ...) are auto-detected. `format=true` enables inverse
  // text normalization and requires an explicit language; the model
  // transcribes any language regardless.
  const form = new FormData();
  if (language) {
    form.append("format", "true");
    form.append("language", language);
  }
  form.append(
    "file",
    new Blob([audioBytes], { type: mimeTypeForFormat(format) }),
    `audio.${format}`,
  );

  const config = getManagedGatewayConfig("xai");
  let upstream: Response;
  try {
    upstream = await fetch(`${config.baseURL}/stt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}` },
      body: form,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (error) {
    throw new XaiSttError(
      "network",
      error instanceof Error ? error.message : "Failed to contact xAI",
    );
  }

  const responseText = await upstream.text();
  if (!upstream.ok) {
    throw new XaiSttError(
      "upstream",
      `xAI STT returned ${upstream.status}`,
      upstream.status,
      responseText,
    );
  }

  let parsed: { text?: unknown; duration?: unknown };
  try {
    parsed = JSON.parse(responseText) as typeof parsed;
  } catch {
    throw new XaiSttError(
      "invalid_response",
      "xAI returned a non-JSON transcription response",
    );
  }

  return {
    text: typeof parsed.text === "string" ? parsed.text : "",
    durationSeconds:
      typeof parsed.duration === "number" && Number.isFinite(parsed.duration)
        ? parsed.duration
        : undefined,
  };
};
