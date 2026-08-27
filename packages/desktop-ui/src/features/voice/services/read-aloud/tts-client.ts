import { createServiceRequest } from "@/platform/http/service-request";

export type ReadAloudVoiceFamily = "openai" | "inworld";

export type ReadAloudRequest = {
  text: string;
  voice?: string;
  voiceProvider: ReadAloudVoiceFamily;
  speed?: number;
  signal?: AbortSignal;
};

export type ReadAloudResponse = {
  audio: ArrayBuffer;

  contentType: string;
};

const TTS_PATH = "/api/voice/tts";
const TTS_STREAM_PATH = "/api/voice/tts/stream";

export async function openReadAloudStream(
  req: Omit<ReadAloudRequest, "voiceProvider">,
): Promise<Response> {
  const { endpoint, headers } = await createServiceRequest(TTS_STREAM_PATH, {
    "Content-Type": "application/json",
  });
  const body: Record<string, unknown> = { text: req.text };
  if (req.voice) body.voice = req.voice;
  if (typeof req.speed === "number" && Number.isFinite(req.speed)) {
    body.speed = req.speed;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Read-aloud stream failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return response;
}

export async function fetchReadAloudAudio(
  req: ReadAloudRequest,
): Promise<ReadAloudResponse> {
  const { endpoint, headers } = await createServiceRequest(TTS_PATH, {
    "Content-Type": "application/json",
  });
  const body: Record<string, unknown> = {
    text: req.text,
    voiceProvider: req.voiceProvider,
  };
  if (req.voice) body.voice = req.voice;
  if (typeof req.speed === "number" && Number.isFinite(req.speed)) {
    body.speed = req.speed;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Read-aloud TTS failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  const contentType =
    response.headers.get("content-type")?.split(";")[0]?.trim() ?? "audio/mpeg";
  const audio = await response.arrayBuffer();
  return { audio, contentType };
}
