import {
  getManagedGatewayConfig,
  resolveManagedGatewayApiKey,
} from "./managed_gateway";

export const XAI_STT_MODEL_LABEL = "grok-stt-1.0";
export const XAI_STT_USD_PER_SECOND = 0.1 / 3600;

export type XaiSttErrorKind =
  | "invalid_base64"
  | "upstream"
  | "invalid_response"
  | "network";

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

export type XaiSttResult = {
  text: string;
  durationSeconds?: number;
};

export const transcribeWithXaiRest = async (args: {
  apiKey: string;
  audioBase64: string;
  audioFormat: string;
  language?: string;
}): Promise<XaiSttResult> => {
  const audioBytes = base64ToBytes(args.audioBase64);
  const language = args.language?.trim();
  const format = args.audioFormat.trim().toLowerCase();

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
