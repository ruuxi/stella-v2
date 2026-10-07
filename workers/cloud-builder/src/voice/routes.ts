/**
 * Voice's HTTP surface: the bodies that are not JSON calls.
 *
 *   POST /api/voice/live/sdp              SDP offer in, SDP answer out (`voice.sdp`)
 *   POST /api/voice/tts                   one-shot read-aloud audio
 *   POST /api/voice/tts/stream            progressive `audio/mpeg` (desktop)
 *   POST /api/voice/tts/stream/cancel     stop a mobile HLS synthesis
 *   GET  /api/voice/tts/stream/hls/<ticket>/{index.m3u8,seg-<n>.mp3}
 *
 * Everything but the HLS GETs takes the user's bearer JWT. The HLS GETs come
 * from a native player that cannot send headers, so the signed ticket in the
 * path authorizes them and they read `MEDIA` without touching the owner's
 * object. Read-aloud runs Gemini TTS on OpenRouter or fal (`tts.ts`).
 * Provider keys never leave the Worker; read-aloud spend is logged
 * (`tts_usage`), not charged, since read-aloud is free on every plan.
 */

import { Effect } from "effect";
import {
  rpcErrorStatus,
  type BackendError,
} from "@stella/contracts/backend/protocol";
import {
  VOICE_LEASE_HEADER,
  VOICE_LIVE_SDP_PATH,
  VOICE_TTS_HLS_PREFIX,
  VOICE_TTS_PATH,
  VOICE_TTS_STREAM_CANCEL_PATH,
  VOICE_TTS_STREAM_PATH,
} from "@stella/contracts/backend/voice";
import { log } from "../build-session/shared/keys.js";
import { sha256Hex } from "../hash.js";
import { DictationUsageError, type MuseControl, type PreparedSession } from "../muse-transcribe-socket.js";
import { RpcError, toBackendError, unwrapRpc } from "../owner-store/errors.js";
import { verifyCaller } from "../owner-store/routes.js";
import type { OwnerCaller } from "../owner-store/registry.js";
import { ttsText } from "../owner-store/domains/voice.js";
import { createPcmMp3Encoder, estimateTtsUsage, openTtsPcm, pcmToWav, resolveGeminiTtsVoice, ttsProvider } from "./tts.js";
import { buildHlsPlaylist, HLS_MANIFEST_FILE, type HlsManifest } from "./hls.js";
import { mediaSigningSecret, ttsObjectKey, verifyTtsTicket } from "./ticket.js";

type VoiceEnv = Cloudflare.Env;

const MAX_JSON_BYTES = 256 * 1024;
const MAX_SDP_BYTES = 1_000_000;
/** AVPlayer can fail for good on an empty EVENT playlist: hold the first read. */
const PLAYLIST_WAIT_MS = 5_000;
const PLAYLIST_POLL_MS = 250;
const PROVIDER_TIMEOUT_MS = 60_000;

const secret = (env: VoiceEnv, name: string): string | null => {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const errorResponse = (error: unknown): Response => {
  const body: BackendError = toBackendError(error);
  if (!(error instanceof RpcError)) {
    log("error", "voice_route_failed", { message: error instanceof Error ? error.message : String(error) });
  }
  return Response.json(
    { error: body },
    {
      status: rpcErrorStatus(body.code),
      headers: {
        "cache-control": "no-store",
        ...(body.retryAfterMs !== undefined
          ? { "retry-after": String(Math.max(1, Math.ceil(body.retryAfterMs / 1_000))) }
          : {}),
      },
    },
  );
};

// ── Owner object access ────────────────────────────────────────────────────

/** The owner's current generation, read from the owner's object. */
export const ownerGeneration = async (env: Pick<VoiceEnv, "OWNER_GATES">, ownerId: string): Promise<string> => {
  try {
    return (await env.OWNER_GATES.getByName(ownerId).snapshot()).ownerGeneration;
  } catch {
    throw new RpcError("UNAVAILABLE", "Account state is unavailable. Try again.");
  }
};

/** A server-internal voice operation on the owner's object, unwrapped. */
export const voiceInternal = async <T>(
  env: Pick<VoiceEnv, "OWNER_GATES">,
  ownerId: string,
  generation: string,
  name: string,
  args: unknown,
): Promise<T> =>
  unwrapRpc(
    await env.OWNER_GATES.getByName(ownerId).ownerInternal({ name, args, ownerGeneration: generation }),
  ) as T;

/** The Muse relay's metering, on the owner's object under one generation. */
export const ownerDictationControl = (env: Pick<VoiceEnv, "OWNER_GATES">, ownerId: string): MuseControl => {
  let generation: Promise<string> | null = null;
  const current = () => (generation ??= ownerGeneration(env, ownerId));
  return {
    async prepare(sessionId) {
      try {
        return await voiceInternal<PreparedSession>(env, ownerId, await current(), "dictation.prepare", { sessionId });
      } catch (error) {
        if (error instanceof RpcError && (error.code === "FORBIDDEN" || error.code === "RATE_LIMITED")) {
          throw new DictationUsageError(error.message);
        }
        throw error;
      }
    },
    async settle({ sessionId, audioBytes }) {
      await voiceInternal(env, ownerId, await current(), "dictation.settle", { sessionId, audioBytes });
    },
  };
};

const callOwner = async <T>(env: VoiceEnv, ownerId: string, name: string, args: unknown): Promise<T> =>
  await voiceInternal<T>(env, ownerId, await ownerGeneration(env, ownerId), name, args);

const authenticate = async (request: Request, env: VoiceEnv): Promise<OwnerCaller> => {
  const header = request.headers.get("authorization") ?? "";
  const verified = await verifyCaller(env, header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  if (!verified.ok) throw verified.error;
  if (verified.caller.isAnonymous) {
    throw new RpcError("FORBIDDEN", "Sign in to Stella to use voice.");
  }
  return verified.caller;
};

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw new RpcError("BAD_REQUEST", "Request body is too large.");
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Falls through to the refusal below.
  }
  throw new RpcError("BAD_REQUEST", "Request body must be a JSON object.");
};

/** Trim, bound and admit read-aloud text against the owner's allowance. */
const admitText = async (env: VoiceEnv, caller: OwnerCaller, raw: unknown): Promise<string> => {
  const text = typeof raw === "string" ? ttsText(raw) : "";
  if (!text) throw new RpcError("BAD_REQUEST", "text is required.");
  await callOwner(env, caller.ownerId, "tts.admit", { chars: text.length });
  return text;
};

// ── Live voice ─────────────────────────────────────────────────────────────

const liveSdp = async (request: Request, env: VoiceEnv): Promise<Response> => {
  const caller = await authenticate(request, env);
  const leaseId = request.headers.get(VOICE_LEASE_HEADER)?.trim() ?? "";
  if (!leaseId) throw new RpcError("BAD_REQUEST", `${VOICE_LEASE_HEADER} is required.`);
  const sdp = await request.text();
  if (sdp.length < 10 || sdp.length > MAX_SDP_BYTES) throw new RpcError("BAD_REQUEST", "Missing or invalid SDP offer.");
  const answer = await callOwner<{ sdp: string }>(env, caller.ownerId, "voice.sdp", { leaseId, sdp });
  return new Response(answer.sdp, {
    headers: { "content-type": "application/sdp", "cache-control": "no-store" },
  });
};

// ── Read-aloud: desktop ────────────────────────────────────────────────────

const logTtsUsage = (fields: Record<string, unknown>) => log("info", "tts_usage", fields);

const notConfigured = () => new RpcError("UNAVAILABLE", "Stella read-aloud is not configured yet.", { retryable: false });

const providerSignal = (request: Request): AbortSignal =>
  AbortSignal.any([request.signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]);

const openPcm = async (env: VoiceEnv, text: string, voice: string, transport: string, signal: AbortSignal) => {
  try {
    return await openTtsPcm(env, { text, voice, signal });
  } catch (error) {
    log("error", "tts_provider_failed", { transport, message: error instanceof Error ? error.message : String(error) });
    throw new RpcError("UNAVAILABLE", "Speech generation failed.");
  }
};

/** Streaming synthesis, re-encoded to one progressive MP3 stream. */
const ttsStream = async (request: Request, env: VoiceEnv): Promise<Response> => {
  const caller = await authenticate(request, env);
  const body = await readJson(request);
  if (!ttsProvider(env)) throw notConfigured();
  const text = await admitText(env, caller, body.text);
  const voice = resolveGeminiTtsVoice(body.voice);
  const startedAt = Date.now();
  const { provider, pcm } = await openPcm(env, text, voice, "stream", providerSignal(request));
  const reader = pcm.getReader();
  const encoder = createPcmMp3Encoder();
  let audioBytes = 0;
  let firstAudioMs: number | null = null;
  const report = (status: string) =>
    logTtsUsage({
      transport: "stream",
      status,
      requestChars: text.length,
      audioBytes,
      firstAudioMs,
      ...estimateTtsUsage(provider, text.length, encoder.pcmBytes),
      durationMs: Date.now() - startedAt,
    });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = encoder.finish();
            if (tail.length > 0) controller.enqueue(tail);
            audioBytes += tail.length;
            report(audioBytes > 0 ? "completed" : "failed");
            controller.close();
            return;
          }
          const chunk = value ? encoder.push(value) : new Uint8Array(0);
          if (chunk.length > 0) {
            firstAudioMs ??= Date.now() - startedAt;
            audioBytes += chunk.length;
            controller.enqueue(chunk);
            return;
          }
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        report("interrupted");
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      report("interrupted");
    },
  });
  return new Response(stream, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
};

/** One-shot synthesis: WAV from Gemini TTS, MP3 from OpenAI. */
const ttsOneShot = async (request: Request, env: VoiceEnv): Promise<Response> => {
  const caller = await authenticate(request, env);
  const body = await readJson(request);
  const provider = body.voiceProvider === "gemini" ? "gemini" : "openai";
  const apiKey = provider === "gemini" ? (ttsProvider(env)?.apiKey ?? null) : secret(env, "OPENAI_API_KEY");
  if (!apiKey) throw notConfigured();
  const text = await admitText(env, caller, body.text);
  const startedAt = Date.now();
  const signal = providerSignal(request);

  if (provider === "gemini") {
    const voice = resolveGeminiTtsVoice(body.voice);
    const opened = await openPcm(env, text, voice, "oneshot_gemini", signal);
    const pcm = new Uint8Array(await new Response(opened.pcm).arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (pcm.byteLength === 0) {
      log("error", "tts_provider_failed", { transport: "oneshot_gemini", provider: opened.provider });
      throw new RpcError("UNAVAILABLE", "Speech generation failed.");
    }
    const audio = pcmToWav(pcm);
    logTtsUsage({
      transport: "oneshot_gemini",
      requestChars: text.length,
      audioBytes: audio.byteLength,
      ...estimateTtsUsage(opened.provider, text.length, pcm.byteLength),
      durationMs: Date.now() - startedAt,
    });
    return new Response(audio, { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
  }

  const voice = typeof body.voice === "string" && body.voice.trim() ? body.voice.trim().slice(0, 100) : "marin";
  const speed =
    typeof body.speed === "number" && Number.isFinite(body.speed) && body.speed >= 0.25 && body.speed <= 4
      ? body.speed
      : undefined;
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      response_format: "mp3",
      ...(speed !== undefined ? { speed } : {}),
    }),
    signal,
  }).catch(() => null);
  const audio = response?.ok ? await response.arrayBuffer().catch(() => null) : null;
  if (!audio) {
    await response?.body?.cancel().catch(() => undefined);
    log("error", "tts_provider_failed", { transport: "oneshot_openai", status: response?.status ?? 0 });
    throw new RpcError("UNAVAILABLE", "OpenAI TTS failed.");
  }
  logTtsUsage({ transport: "oneshot_openai", requestChars: text.length, audioBytes: audio.byteLength, durationMs: Date.now() - startedAt });
  return new Response(audio, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
};

// ── Read-aloud: mobile HLS ─────────────────────────────────────────────────

const ttsCancel = async (request: Request, env: VoiceEnv): Promise<Response> => {
  const caller = await authenticate(request, env);
  const body = await readJson(request);
  const signingSecret = mediaSigningSecret(env);
  const ticket =
    signingSecret && typeof body.ticket === "string"
      ? await verifyTtsTicket(signingSecret, body.ticket.trim(), Date.now())
      : null;
  // An expired or foreign ticket has nothing left to stop.
  if (ticket && ticket.ownerHash === (await sha256Hex(caller.ownerId))) {
    await callOwner(env, caller.ownerId, "tts.cancel", { id: ticket.id });
  }
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
};

const readManifest = async (bucket: R2Bucket, ticket: string): Promise<HlsManifest | null> => {
  const object = await bucket.get(ttsObjectKey(ticket, HLS_MANIFEST_FILE));
  return object ? ((await object.json()) as HlsManifest) : null;
};

const AUDIO_RANGE = /^bytes=(\d*)-(\d*)$/u;

/** A segment with byte ranges, so native players can probe it. */
const audioResponse = (bytes: Uint8Array, range: string | null): Response => {
  const total = bytes.byteLength;
  const headers = { "content-type": "audio/mpeg", "accept-ranges": "bytes", "cache-control": "no-store" };
  const match = range ? AUDIO_RANGE.exec(range.trim()) : null;
  if (!match) return new Response(bytes, { headers: { ...headers, "content-length": String(total) } });
  let start = match[1] ? Number.parseInt(match[1], 10) : 0;
  let end = match[2] ? Number.parseInt(match[2], 10) : total - 1;
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end >= total) end = total - 1;
  if (start > end || start >= total) {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${total}` } });
  }
  const slice = bytes.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: { ...headers, "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(slice.byteLength) },
  });
};

const ttsHls = async (request: Request, env: VoiceEnv, path: string): Promise<Response> => {
  const rest = path.slice(VOICE_TTS_HLS_PREFIX.length);
  const slash = rest.indexOf("/");
  const signingSecret = mediaSigningSecret(env);
  if (slash <= 0 || !signingSecret || !env.MEDIA) throw new RpcError("NOT_FOUND", "Not found.");
  let raw: string;
  try {
    raw = decodeURIComponent(rest.slice(0, slash));
  } catch {
    throw new RpcError("NOT_FOUND", "Not found.");
  }
  const ticket = await verifyTtsTicket(signingSecret, raw, Date.now());
  if (!ticket) throw new RpcError("NOT_FOUND", "Stream is invalid or expired.");
  const file = rest.slice(slash + 1);

  if (file === "index.m3u8") {
    const deadline = Date.now() + PLAYLIST_WAIT_MS;
    let manifest = await readManifest(env.MEDIA, ticket.ticket);
    while ((!manifest || (manifest.segments.length === 0 && !manifest.done)) && Date.now() < deadline) {
      await Effect.runPromise(Effect.sleep(PLAYLIST_POLL_MS));
      manifest = await readManifest(env.MEDIA, ticket.ticket);
    }
    if (manifest && (manifest.error || (manifest.done && manifest.segments.length === 0))) {
      throw new RpcError("UNAVAILABLE", "Speech generation failed.", { retryable: false });
    }
    if (!manifest || manifest.segments.length === 0) {
      throw new RpcError("UNAVAILABLE", "Speech is still being generated.", { retryAfterMs: 1_000 });
    }
    return new Response(buildHlsPlaylist(manifest), {
      headers: { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" },
    });
  }

  if (/^seg-\d{1,4}\.mp3$/u.test(file)) {
    const object = await env.MEDIA.get(ttsObjectKey(ticket.ticket, file));
    if (!object) throw new RpcError("NOT_FOUND", "Segment not found.");
    return audioResponse(new Uint8Array(await object.arrayBuffer()), request.headers.get("range"));
  }
  throw new RpcError("NOT_FOUND", "Not found.");
};

// ── Router ─────────────────────────────────────────────────────────────────

/** Voice's routes, or null when the path is someone else's. */
export const handleVoiceRoute = async (request: Request, env: VoiceEnv): Promise<Response | null> => {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/voice/")) return null;
  try {
    if (path.startsWith(VOICE_TTS_HLS_PREFIX)) {
      if (request.method !== "GET" && request.method !== "HEAD") throw new RpcError("BAD_REQUEST", "Method not allowed.");
      return await ttsHls(request, env, path);
    }
    if (request.method !== "POST") throw new RpcError("BAD_REQUEST", "Method not allowed.");
    switch (path) {
      case VOICE_LIVE_SDP_PATH:
        return await liveSdp(request, env);
      case VOICE_TTS_PATH:
        return await ttsOneShot(request, env);
      case VOICE_TTS_STREAM_PATH:
        return await ttsStream(request, env);
      case VOICE_TTS_STREAM_CANCEL_PATH:
        return await ttsCancel(request, env);
      default:
        throw new RpcError("NOT_FOUND", "Not found.");
    }
  } catch (error) {
    return errorResponse(error);
  }
};
