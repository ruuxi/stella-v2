import { forkAbortTimer } from "@stella/runtime/kernel/tools/effect-runtime.js";
import { SUBPROTOCOL } from "./conversation-hub.js";

const MUSE_MODEL = "muse-voice-transcribe-1.0";
const MUSE_SOCKET_URL = "https://api.meta.ai/v1/asr/realtime";
const PCM_BYTES_PER_SECOND = 16_000 * 2;
const MAX_AUDIO_BYTES = 60 * 60 * PCM_BYTES_PER_SECOND;
const MAX_FRAME_BYTES = PCM_BYTES_PER_SECOND;

type MuseRelayEnv = Pick<
  Cloudflare.Env,
  "BUILDER_SERVICE_SECRET" | "META_MODEL_API_KEY" | "STELLA_CONVEX_SITE_URL"
>;

type PreparedSession = {
  sessionId: string;
  ownerGeneration: string;
  providerDeadlineAt: number;
};

export const createMuseHandshake = (apiKey: string) => ({
  authorization: { accessToken: `Bearer ${apiKey}` },
  audioEncoding: "PCM_16KHZ" as const,
  model: MUSE_MODEL,
  mode: "PUSH_TO_TALK" as const,
  partialMode: "CUMULATIVE" as const,
  emitAudioProgress: false,
});

export const isMuseEndStreamFrame = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value) as { type?: unknown };
    return parsed.type === "endStream" && Object.keys(parsed).length === 1;
  } catch {
    return false;
  }
};

const closeSocket = (socket: WebSocket, code: number, reason: string): void => {
  try {
    const validCode =
      code === 1000 ||
      code === 1001 ||
      code === 1002 ||
      code === 1003 ||
      (code >= 1007 && code <= 1014) ||
      (code >= 3000 && code <= 4999)
        ? code
        : 1011;
    socket.close(validCode, reason.slice(0, 120));
  } catch {
    // Closing is best effort once the peer has already gone away.
  }
};

const callControlPlane = async <T>(
  env: MuseRelayEnv,
  path: string,
  body: unknown,
): Promise<T> => {
  const base = env.STELLA_CONVEX_SITE_URL?.trim().replace(/\/+$/u, "");
  if (!base || !env.BUILDER_SERVICE_SECRET) {
    throw new Error("Muse relay control plane is unavailable.");
  }
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.BUILDER_SERVICE_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Muse relay control plane rejected the request (${response.status}).`,
    );
  }
  return (await response.json()) as T;
};

export const handleMuseTranscribeSocket = async (args: {
  request: Request;
  env: MuseRelayEnv;
  ownerId: string;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<Response> => {
  const apiKey = args.env.META_MODEL_API_KEY?.trim();
  if (!apiKey)
    return new Response("Muse transcription is unavailable.", { status: 503 });

  let prepared: PreparedSession;
  try {
    prepared = await callControlPlane<PreparedSession>(
      args.env,
      "/api/cloud/dictation/prepare",
      { ownerId: args.ownerId },
    );
  } catch {
    return new Response("Muse transcription is unavailable.", { status: 503 });
  }

  if (
    !Number.isFinite(prepared.providerDeadlineAt) ||
    prepared.providerDeadlineAt <= Date.now()
  ) {
    return new Response("Muse transcription session expired.", { status: 503 });
  }
  const reportUsage = async (
    audioBytes: number,
    durationMs: number,
    success: boolean,
  ) => {
    // Reuse identical settlement bytes on retry; the durable session receipt
    // makes a lost successful response safe to repeat.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await callControlPlane(args.env, "/api/cloud/dictation/settle", {
          ownerId: args.ownerId,
          ownerGeneration: prepared.ownerGeneration,
          sessionId: prepared.sessionId,
          audioBytes,
          durationMs,
          success,
        });
        return;
      } catch {
        // If all attempts fail, Convex's receipt expiry bills the reserved cap.
      }
    }
  };
  const upstreamUrl = new URL(MUSE_SOCKET_URL);
  upstreamUrl.searchParams.set("sessionId", prepared.sessionId);
  const upstreamResponse = await fetch(upstreamUrl, {
    headers: { Upgrade: "websocket" },
    signal: AbortSignal.timeout(
      Math.max(1, Math.min(10_000, prepared.providerDeadlineAt - Date.now())),
    ),
  }).catch(() => null);
  if (
    !upstreamResponse ||
    upstreamResponse.status !== 101 ||
    !upstreamResponse.webSocket
  ) {
    await upstreamResponse?.body?.cancel().catch(() => undefined);
    args.waitUntil(reportUsage(0, 0, false));
    return new Response("Muse transcription is unavailable.", { status: 502 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const gateway = pair[1];
  const upstream = upstreamResponse.webSocket;
  // Current Workers compatibility dates deliver binary frames as Blob by
  // default. Keep PCM frames synchronous and ordered for the relay below.
  gateway.binaryType = "arraybuffer";
  gateway.accept();
  upstream.accept();

  let audioBytes = 0;
  let settled = false;
  let closing = false;
  let cancelDeadline: (() => void) | undefined;
  let sawFinalTranscript = false;
  let sawUpstreamError = false;
  const startedAt = Date.now();
  const settle = (success: boolean): void => {
    if (settled) return;
    settled = true;
    cancelDeadline?.();
    args.waitUntil(reportUsage(audioBytes, Date.now() - startedAt, success));
  };

  const closeBoth = (code: number, reason: string) => {
    closing = true;
    closeSocket(upstream, code, reason);
    closeSocket(gateway, code, reason);
  };
  cancelDeadline = forkAbortTimer(
    Math.max(0, prepared.providerDeadlineAt - Date.now()),
    () => {
      closeBoth(1000, "Transcription session time limit reached");
    },
  );

  gateway.addEventListener("message", (event) => {
    if (settled || closing) return;
    if (Date.now() >= prepared.providerDeadlineAt) {
      closeBoth(1000, "Transcription session time limit reached");
      return;
    }
    if (event.data instanceof ArrayBuffer) {
      if (
        event.data.byteLength === 0 ||
        event.data.byteLength > MAX_FRAME_BYTES ||
        audioBytes + event.data.byteLength > MAX_AUDIO_BYTES
      ) {
        closeBoth(1008, "Invalid audio frame");
        return;
      }
      audioBytes += event.data.byteLength;
      upstream.send(event.data);
      return;
    }
    if (isMuseEndStreamFrame(event.data)) {
      upstream.send(JSON.stringify({ type: "endStream" }));
      return;
    }
    closeBoth(1008, "Invalid transcription frame");
  });
  upstream.addEventListener("message", (event) => {
    if (settled || closing) return;
    if (typeof event.data === "string") {
      try {
        const frame = JSON.parse(event.data) as {
          type?: unknown;
          final?: unknown;
        };
        if (frame.type === "error") sawUpstreamError = true;
        if (frame.type === "transcript" && frame.final === true) {
          sawFinalTranscript = true;
        }
      } catch {
        // Forward provider frames unchanged; clients ignore unknown payloads.
      }
    }
    gateway.send(event.data);
  });
  upstream.addEventListener("close", (event) => {
    settle(
      !closing &&
        !sawUpstreamError &&
        (event.code === 1000 || sawFinalTranscript),
    );
    closeSocket(gateway, event.code, event.reason);
  });
  upstream.addEventListener("error", () => {
    closeBoth(1011, "Muse transcription failed");
    settle(false);
  });
  gateway.addEventListener("close", (event) => {
    closing = true;
    closeSocket(upstream, event.code, event.reason);
  });

  upstream.send(JSON.stringify(createMuseHandshake(apiKey)));

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { "sec-websocket-protocol": SUBPROTOCOL },
  });
};
