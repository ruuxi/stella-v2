/**
 * Realtime voice, read-aloud and dictation metering for one owner.
 *
 * - **Realtime voice (Pro):** `voice.session` records a lease holding the
 *   OpenAI session config; the SDP route (`voice.sdp`) creates the call on
 *   OpenAI and keeps its call id, so the server can always hang it up. Each
 *   `response.done` usage report is charged exactly; when the lease closes
 *   (client end, supersession, or `voice.reap` after 2 minutes without a
 *   heartbeat) the call is hung up and the duplex envelope for its open time
 *   is charged less what usage already covered. The object is
 *   single-threaded, so there is no dispatch-lease ledger.
 * - **Read-aloud:** free on every plan, bounded by a rate limit and a daily
 *   character allowance. `tts.prepare` signs an HLS ticket and runs one
 *   synthesis job that writes segments to `MEDIA` at `tts/<ticket>/`.
 * - **Dictation:** the Muse relay sizes a session with `dictation.prepare`
 *   and charges its audio once with `dictation.settle`.
 */

import {
  voiceTtsPlaylistPath,
  type VoiceLease,
  type VoiceSession,
  type VoiceToolSchema,
} from "@stella/contracts/backend/voice";
import { log } from "../../build-session/shared/keys.js";
import { resolveGeminiTtsVoice } from "../../voice/gemini-tts.js";
import { synthesizeHls } from "../../voice/hls.js";
import { mediaSigningSecret, signTtsTicket, ttsOwnerPrefix } from "../../voice/ticket.js";
import { array, empty, json, literal, number, object, optional, string, type Parser } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDomain, OwnerPurgeMode } from "../registry.js";
import { billingAccess, billingPlan, recordUsage } from "./billing.js";

// ── Constants ──────────────────────────────────────────────────────────────

const VOICE_SESSION_RATE = { count: 10, windowMs: 60_000 };
/** A heartbeat renews the lease this far ahead; clients poll every 2 s. */
const LEASE_TTL_MS = 10_000;
/** A realtime session ends after this. */
const SESSION_MAX_MS = 5 * 60_000;
/** `voice.reap` closes open leases with no heartbeat for this long. */
const IDLE_REAP_MS = 2 * 60_000;
const CLOSED_LEASE_RETENTION_MS = 24 * 60 * 60_000;
/**
 * The continuously open duplex envelope: 10 audio-in plus 20 audio-out
 * tokens a second at $32/$64 per million. Charged for a call's open time,
 * less the exact usage already reported, and never above one full session.
 */
const ENVELOPE_MICRO_CENTS_PER_SECOND = 160_000;
const SESSION_CHARGE_CAP = (SESSION_MAX_MS / 1_000) * ENVELOPE_MICRO_CENTS_PER_SECOND;

const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1";
const DEFAULT_REALTIME_VOICE = "marin";
const OPENAI_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

const TTS_RATE = { count: 20, windowMs: 60_000 };
const TTS_MAX_INPUT_CHARS = 8_000;
const TTS_DAILY_CHARS = { free: 60_000, go: 300_000, pro: 1_000_000 } as const;
/** A long clip plays in real time, so its ticket outlives synthesis. */
const TTS_TICKET_TTL_MS = 15 * 60_000;

const MUSE_DICTATION_MODEL = "muse-voice-transcribe-1.0";
const DICTATION_RATE = { count: 30, windowMs: 60_000 };
const MUSE_STT_USD_PER_SECOND = 0.18 / 3_600;
const MUSE_MAX_SESSION_SECONDS = 60 * 60;
const PCM_BYTES_PER_SECOND = 16_000 * 2;
const DICTATION_SESSION_ID = /^muse_[0-9a-f-]{36}$/u;

export const VOICE_REAP_JOB = "voice.reap";
export const TTS_SYNTHESIZE_JOB = "tts.synthesize";
const ttsJobId = (id: string) => `tts:${id}`;

const usdToMicroCents = (usd: number): number => Math.round(usd * 100_000_000);

export const VOICE_MIGRATION = {
  id: "voice.1-init",
  statements: [
    `CREATE TABLE voice_leases (
       lease_id TEXT PRIMARY KEY,
       model TEXT NOT NULL,
       voice TEXT NOT NULL,
       session_config TEXT NOT NULL,
       status TEXT NOT NULL,
       call_id TEXT,
       call_started_at INTEGER,
       charged INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL,
       last_seen_at INTEGER NOT NULL,
       closed_at INTEGER,
       close_reason TEXT,
       hangup_pending INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE INDEX voice_leases_status ON voice_leases (status, last_seen_at)`,
    `CREATE TABLE tts_streams (
       id TEXT PRIMARY KEY,
       status TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE tts_daily (
       day TEXT PRIMARY KEY,
       chars INTEGER NOT NULL
     )`,
  ],
};

type LeaseRow = {
  lease_id: string;
  model: string;
  voice: string;
  session_config: string;
  status: string;
  call_id: string | null;
  call_started_at: number | null;
  charged: number;
  created_at: number;
  last_seen_at: number;
  closed_at: number | null;
  close_reason: string | null;
  hangup_pending: number;
};

const secret = (env: Cloudflare.Env, name: string): string | null => {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const readLease = (ctx: OwnerContext, leaseId: string): LeaseRow | null =>
  ctx.db.one<LeaseRow>("SELECT * FROM voice_leases WHERE lease_id = ?", leaseId);

// ── Pricing ────────────────────────────────────────────────────────────────

type RealtimePrice = {
  textIn: number;
  textCachedIn: number;
  textOut: number;
  audioIn: number;
  audioCachedIn: number;
  audioOut: number;
  imageIn: number;
  imageCachedIn: number;
};

/** USD per million tokens. */
const REALTIME_PRICES: Record<string, RealtimePrice> = {
  "gpt-realtime-1.5": {
    textIn: 4, textCachedIn: 0.4, textOut: 16, audioIn: 32, audioCachedIn: 0.4, audioOut: 64, imageIn: 5, imageCachedIn: 0.5,
  },
  "gpt-realtime-2": {
    textIn: 4, textCachedIn: 0.4, textOut: 24, audioIn: 32, audioCachedIn: 0.4, audioOut: 64, imageIn: 5, imageCachedIn: 0.5,
  },
  "gpt-realtime-2.1": {
    textIn: 4, textCachedIn: 0.4, textOut: 24, audioIn: 32, audioCachedIn: 0.4, audioOut: 64, imageIn: 5, imageCachedIn: 0.5,
  },
};

const realtimePrice = (model: string): RealtimePrice | undefined =>
  REALTIME_PRICES[model] ??
  Object.entries(REALTIME_PRICES).find(([base]) => model.startsWith(`${base}-`))?.[1];

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** What one realtime `response.done` usage object costs. */
const realtimeCost = (model: string, usage: unknown): number => {
  const price = realtimePrice(model);
  if (!price) return 0;
  const input = record(record(usage).input_token_details);
  const output = record(record(usage).output_token_details);
  const usd =
    (count(input.text_tokens) * price.textIn +
      count(input.cached_text_tokens ?? input.cached_tokens) * price.textCachedIn +
      count(output.text_tokens) * price.textOut +
      count(input.audio_tokens) * price.audioIn +
      count(input.cached_audio_tokens) * price.audioCachedIn +
      count(output.audio_tokens) * price.audioOut +
      count(input.image_tokens) * price.imageIn +
      count(input.cached_image_tokens) * price.imageCachedIn) /
    1_000_000;
  return usdToMicroCents(usd);
};

// ── Realtime voice ─────────────────────────────────────────────────────────

const UNSUPPORTED_ROOT_SCHEMA_KEYS = ["oneOf", "anyOf", "allOf", "enum", "const", "not"];

/** Strip each tool's root schema down to what the Realtime API accepts. */
const normalizeTools = (tools: VoiceToolSchema[]): VoiceToolSchema[] => {
  const seen = new Set<string>();
  return tools.map((tool) => {
    const name = tool.name.trim();
    if (!name || seen.has(name) || tool.parameters.type !== "object") {
      throw new RpcError("BAD_REQUEST", "tools must be a valid voice tool catalog.");
    }
    seen.add(name);
    const parameters = { ...tool.parameters };
    for (const key of UNSUPPORTED_ROOT_SCHEMA_KEYS) delete parameters[key];
    return {
      type: "function",
      name,
      description: tool.description.trim(),
      parameters: { ...parameters, type: "object", properties: record(parameters.properties) },
    };
  });
};

const hangupCall = async (env: Cloudflare.Env, callId: string): Promise<boolean> => {
  const apiKey = secret(env, "OPENAI_API_KEY");
  if (!apiKey) return false;
  try {
    const response = await fetch(`${OPENAI_CALLS_URL}/${encodeURIComponent(callId)}/hangup`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
};

const scheduleReap = (ctx: OwnerContext, at: number): void => {
  ctx.jobs.schedule(VOICE_REAP_JOB, at, null, { id: VOICE_REAP_JOB });
};

/**
 * Close an open lease: charge the envelope for the call's open time up to
 * `closedAt`, less what usage reports already charged, then hang up. State
 * changes before the hangup's await, so a concurrent call sees it closed.
 */
const closeLease = async (ctx: OwnerContext, leaseId: string, reason: string, closedAt: number): Promise<void> => {
  // Read it here: another close may have run while the caller awaited.
  const lease = readLease(ctx, leaseId);
  if (lease?.status !== "open") return;
  const now = Date.now();
  ctx.db.run(
    "UPDATE voice_leases SET status = 'closed', closed_at = ?, close_reason = ?, hangup_pending = ? WHERE lease_id = ? AND status = 'open'",
    now,
    reason,
    lease.call_id ? 1 : 0,
    lease.lease_id,
  );
  let residual = 0;
  if (lease.call_started_at !== null) {
    const seconds = Math.max(1, Math.ceil(Math.max(0, closedAt - lease.call_started_at) / 1_000));
    const envelope = Math.min(SESSION_CHARGE_CAP, seconds * ENVELOPE_MICRO_CENTS_PER_SECOND);
    residual = Math.max(0, envelope - lease.charged);
    if (residual > 0) {
      const { recorded } = recordUsage(ctx, [{ id: `voice:${lease.lease_id}:final`, costMicroCents: residual }]);
      if (recorded > 0) {
        ctx.db.run("UPDATE voice_leases SET charged = charged + ? WHERE lease_id = ?", residual, lease.lease_id);
      }
    }
  }
  log("info", "voice_lease_closed", {
    leaseId: lease.lease_id,
    reason,
    chargedMicroCents: lease.charged + residual,
    hadCall: lease.call_id !== null,
  });
  if (lease.call_id && (await hangupCall(ctx.env, lease.call_id))) {
    ctx.db.run("UPDATE voice_leases SET hangup_pending = 0 WHERE lease_id = ?", lease.lease_id);
  } else if (lease.call_id) {
    scheduleReap(ctx, now + 30_000);
  }
};

const closedLease = (reason: string | null): VoiceLease => ({ directive: "closed", leaseExpiresAt: null, reason });

const openSession = async (
  ctx: OwnerContext,
  args: {
    instructions: string;
    tools?: VoiceToolSchema[];
    voice?: string;
    model?: string;
    voiceProvider?: "openai" | "xai" | "inworld";
    turnDetection?: "semantic_vad" | "server_vad";
    turnEagerness?: "low" | "medium" | "high";
  },
): Promise<VoiceSession> => {
  enforceOwnerRateLimit(ctx.db, ctx.now, "voice.session", VOICE_SESSION_RATE, "Too many voice sessions. Try again in a minute.");
  if ((args.voiceProvider ?? "openai") !== "openai") {
    throw new RpcError(
      "UNAVAILABLE",
      `Managed ${args.voiceProvider} realtime voice is unavailable because the provider has no call revocation boundary.`,
      { retryable: false },
    );
  }
  const access = billingAccess(ctx);
  if (access.isAnonymous || access.plan !== "pro") {
    throw new RpcError("FORBIDDEN", "Realtime voice is part of Stella Pro.", { reason: "capability_required" });
  }
  if (!access.allowed || (access.remainingMicroCents !== null && access.remainingMicroCents < SESSION_CHARGE_CAP)) {
    throw new RpcError("FORBIDDEN", access.message || "Realtime voice needs more usage allowance than you have left.", {
      reason: "usage_limit_reached",
      ...(access.retryAfterMs > 0 ? { retryAfterMs: access.retryAfterMs } : {}),
    });
  }
  if (!secret(ctx.env, "OPENAI_API_KEY")) {
    throw new RpcError("UNAVAILABLE", "Voice sessions are not configured yet.", { retryable: false });
  }
  const instructions = args.instructions.trim();
  if (!instructions) throw new RpcError("BAD_REQUEST", "instructions is required.");
  const model = args.model?.trim() || DEFAULT_REALTIME_MODEL;
  const voice = args.voice?.trim() || DEFAULT_REALTIME_VOICE;
  const turnDetection =
    args.turnDetection === "semantic_vad"
      ? { type: "semantic_vad", eagerness: args.turnEagerness ?? "medium", create_response: true, interrupt_response: true }
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 120,
          silence_duration_ms: 220,
          create_response: true,
          interrupt_response: true,
        };
  const sessionConfig = JSON.stringify({
    type: "realtime",
    model,
    instructions,
    reasoning: { effort: "minimal" },
    tools: normalizeTools(args.tools ?? []),
    audio: {
      output: { voice },
      input: { transcription: { model: "gpt-4o-transcribe" }, turn_detection: turnDetection },
    },
  });

  // One realtime session per owner: a new one supersedes the rest.
  for (const lease of ctx.db.all<LeaseRow>("SELECT * FROM voice_leases WHERE status = 'open'")) {
    await closeLease(ctx, lease.lease_id, "superseded", Date.now());
  }
  const now = Date.now();
  const leaseId = `voice_${crypto.randomUUID()}`;
  ctx.db.run(
    `INSERT INTO voice_leases (lease_id, model, voice, session_config, status, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?)`,
    leaseId,
    model,
    voice,
    sessionConfig,
    now,
    now,
  );
  scheduleReap(ctx, now + IDLE_REAP_MS + 1_000);
  log("info", "voice_session_opened", { leaseId, model });
  return { leaseId, model, voice, leaseExpiresAt: now + LEASE_TTL_MS };
};

const leaseEvent = async (
  ctx: OwnerContext,
  args: { leaseId: string; event: "heartbeat" | "ended" | "expired" | "lost" },
): Promise<VoiceLease> => {
  const lease = readLease(ctx, args.leaseId);
  if (!lease) return closedLease("unknown_session");
  if (lease.status !== "open") return closedLease(lease.close_reason);
  const deadline = lease.created_at + SESSION_MAX_MS;
  if (args.event !== "heartbeat") {
    await closeLease(ctx, lease.lease_id, args.event, Math.min(ctx.now, deadline));
    return closedLease(args.event);
  }
  const renewable = lease.last_seen_at + LEASE_TTL_MS;
  if (ctx.now >= deadline || ctx.now > renewable) {
    const reason = ctx.now >= deadline ? "session_expired" : "lease_expired";
    await closeLease(ctx, lease.lease_id, reason, Math.min(deadline, renewable));
    return closedLease(reason);
  }
  ctx.db.run("UPDATE voice_leases SET last_seen_at = ? WHERE lease_id = ?", ctx.now, lease.lease_id);
  return { directive: "continue", leaseExpiresAt: Math.min(ctx.now + LEASE_TTL_MS, deadline), reason: null };
};

const reportUsage = (
  ctx: OwnerContext,
  args: { leaseId: string; responseId: string; usage: Record<string, unknown> },
): { recorded: boolean; costMicroCents: number } => {
  const lease = readLease(ctx, args.leaseId);
  if (!lease || lease.status !== "open") {
    throw new RpcError("CONFLICT", "The realtime voice session is no longer available.");
  }
  // A modified client could report anything: never charge past one session.
  const costMicroCents = Math.min(realtimeCost(lease.model, args.usage), Math.max(0, SESSION_CHARGE_CAP - lease.charged));
  const { recorded } = recordUsage(ctx, [{ id: `voice:${lease.lease_id}:${args.responseId}`, costMicroCents }]);
  if (recorded > 0) {
    ctx.db.run("UPDATE voice_leases SET charged = charged + ? WHERE lease_id = ?", costMicroCents, lease.lease_id);
  }
  return { recorded: recorded > 0, costMicroCents };
};

/** Create the lease's OpenAI call from the client's SDP offer; returns the answer. */
const createCall = async (ctx: OwnerContext, raw: unknown): Promise<{ sdp: string }> => {
  const args = object({ leaseId: string({ min: 1, max: 200 }), sdp: string({ min: 10, max: 1_000_000 }) })(raw);
  const lease = readLease(ctx, args.leaseId);
  if (!lease || lease.status !== "open" || lease.call_started_at !== null) {
    throw new RpcError("CONFLICT", "The realtime voice session is no longer available.");
  }
  const apiKey = secret(ctx.env, "OPENAI_API_KEY");
  if (!apiKey) throw new RpcError("UNAVAILABLE", "Voice sessions are not configured yet.", { retryable: false });
  const startedAt = Date.now();
  ctx.db.run(
    "UPDATE voice_leases SET call_started_at = ?, last_seen_at = ? WHERE lease_id = ?",
    startedAt,
    startedAt,
    lease.lease_id,
  );
  const form = new FormData();
  form.set("sdp", args.sdp);
  form.set("session", lease.session_config);
  let response: Response;
  try {
    response = await fetch(OPENAI_CALLS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "x-client-request-id": lease.lease_id },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    // The call may exist without its locator; charge the few seconds and move on.
    await closeLease(ctx, lease.lease_id, "openai_call_unreachable", Date.now());
    throw new RpcError("UNAVAILABLE", "Failed to create the OpenAI voice call.");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log("error", "voice_call_create_failed", { leaseId: lease.lease_id, status: response.status, detail: detail.slice(0, 500) });
    // No call exists, so nothing is charged.
    ctx.db.run("UPDATE voice_leases SET call_started_at = NULL WHERE lease_id = ?", lease.lease_id);
    await closeLease(ctx, lease.lease_id, `openai_call_${response.status}`, Date.now());
    throw new RpcError("UNAVAILABLE", "Failed to create the OpenAI voice call.", { retryable: response.status >= 500 });
  }
  const callId = readCallId(response.headers.get("location"));
  const answer = await response.text().catch(() => null);
  const current = readLease(ctx, lease.lease_id);
  if (!callId || answer === null || current?.status !== "open") {
    if (callId) await hangupCall(ctx.env, callId);
    await closeLease(ctx, lease.lease_id, "openai_call_unbound", Date.now());
    throw new RpcError("CONFLICT", "The realtime voice session is no longer available.");
  }
  ctx.db.run("UPDATE voice_leases SET call_id = ? WHERE lease_id = ?", callId, lease.lease_id);
  log("info", "voice_call_created", { leaseId: lease.lease_id });
  return { sdp: answer };
};

/** The call id from OpenAI's `Location: /v1/realtime/calls/<id>`. */
const readCallId = (location: string | null): string | null => {
  if (!location) return null;
  try {
    const url = new URL(location, "https://api.openai.com");
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.origin !== "https://api.openai.com" || parts.length !== 4 || parts[0] !== "v1" || parts[1] !== "realtime" || parts[2] !== "calls") {
      return null;
    }
    const callId = parts[3]!.trim();
    return /^[A-Za-z0-9._:-]{1,200}$/u.test(callId) ? callId : null;
  } catch {
    return null;
  }
};

/** Close idle leases, retry failed hangups, prune old rows, then rearm. */
const reap = async (ctx: OwnerContext): Promise<void> => {
  const now = Date.now();
  for (const lease of ctx.db.all<LeaseRow>("SELECT * FROM voice_leases WHERE status = 'open'")) {
    const deadline = lease.created_at + SESSION_MAX_MS;
    if (now - lease.last_seen_at > IDLE_REAP_MS) {
      await closeLease(ctx, lease.lease_id, "idle", Math.min(lease.last_seen_at + LEASE_TTL_MS, deadline));
    } else if (now >= deadline + IDLE_REAP_MS) {
      await closeLease(ctx, lease.lease_id, "session_expired", deadline);
    }
  }
  for (const lease of ctx.db.all<LeaseRow>("SELECT * FROM voice_leases WHERE hangup_pending = 1 AND call_id IS NOT NULL")) {
    if (await hangupCall(ctx.env, lease.call_id!)) {
      ctx.db.run("UPDATE voice_leases SET hangup_pending = 0 WHERE lease_id = ?", lease.lease_id);
    }
  }
  ctx.db.run(
    "DELETE FROM voice_leases WHERE status = 'closed' AND hangup_pending = 0 AND closed_at < ?",
    now - CLOSED_LEASE_RETENTION_MS,
  );
  const oldestOpen = ctx.db.one<{ at: number | null }>(
    "SELECT MIN(last_seen_at) AS at FROM voice_leases WHERE status = 'open'",
  )?.at;
  const pendingHangup = ctx.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM voice_leases WHERE hangup_pending = 1")?.n ?? 0;
  if (typeof oldestOpen === "number") scheduleReap(ctx, Math.max(now + 1_000, oldestOpen + IDLE_REAP_MS + 1_000));
  else if (pendingHangup > 0) scheduleReap(ctx, now + 60_000);
};

// ── Read-aloud ─────────────────────────────────────────────────────────────

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** Rate limit plus the plan's daily character allowance. */
const admitTts = (ctx: OwnerContext, chars: number): void => {
  enforceOwnerRateLimit(ctx.db, ctx.now, "tts", TTS_RATE, "Too many read-aloud requests. Try again in a minute.");
  const day = utcDay(ctx.now);
  const limit = TTS_DAILY_CHARS[billingPlan(ctx).plan];
  const used = ctx.db.one<{ chars: number }>("SELECT chars FROM tts_daily WHERE day = ?", day)?.chars ?? 0;
  if (used + chars > limit) {
    const midnight = Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60_000;
    throw new RpcError("RATE_LIMITED", "You've reached today's read-aloud limit.", {
      reason: "tts_quota",
      retryAfterMs: Math.max(1_000, midnight - ctx.now),
    });
  }
  ctx.db.run(
    `INSERT INTO tts_daily (day, chars) VALUES (?, ?)
     ON CONFLICT (day) DO UPDATE SET chars = chars + excluded.chars`,
    day,
    chars,
  );
  ctx.db.run("DELETE FROM tts_daily WHERE day < ?", day);
};

/** The text read-aloud synthesizes: trimmed and bounded. */
export const ttsText = (text: string): string => text.trim().slice(0, TTS_MAX_INPUT_CHARS);

const prepareTts = async (
  ctx: OwnerContext,
  args: { text: string; voice?: string },
): Promise<{ ticket: string; playlistPath: string; expiresAt: number }> => {
  const text = ttsText(args.text);
  if (!text) throw new RpcError("BAD_REQUEST", "text is required.");
  const signingSecret = mediaSigningSecret(ctx.env);
  if (!signingSecret || !ctx.env.MEDIA || !secret(ctx.env, "GOOGLE_AI_API_KEY")) {
    throw new RpcError("UNAVAILABLE", "Stella read-aloud is not configured yet.", { retryable: false });
  }
  admitTts(ctx, text.length);
  const ticket = await signTtsTicket(signingSecret, ctx.ownerId, ctx.now + TTS_TICKET_TTL_MS);
  ctx.db.run("DELETE FROM tts_streams WHERE created_at < ?", ctx.now - TTS_TICKET_TTL_MS);
  ctx.db.run("INSERT INTO tts_streams (id, status, created_at) VALUES (?, 'synthesizing', ?)", ticket.id, ctx.now);
  ctx.jobs.schedule(
    TTS_SYNTHESIZE_JOB,
    ctx.now,
    { id: ticket.id, ticket: ticket.ticket, text, voice: resolveGeminiTtsVoice(args.voice) },
    { id: ttsJobId(ticket.id) },
  );
  return { ticket: ticket.ticket, playlistPath: voiceTtsPlaylistPath(ticket.ticket), expiresAt: ticket.expiresAt };
};

const streamStatus = (ctx: OwnerContext, id: string): string | null =>
  ctx.db.one<{ status: string }>("SELECT status FROM tts_streams WHERE id = ?", id)?.status ?? null;

const synthesize = async (ctx: OwnerContext, payload: unknown): Promise<void> => {
  const job = payload as { id: string; ticket: string; text: string; voice: string };
  if (streamStatus(ctx, job.id) !== "synthesizing") return;
  const apiKey = secret(ctx.env, "GOOGLE_AI_API_KEY");
  if (!apiKey || !ctx.env.MEDIA) {
    ctx.db.run("UPDATE tts_streams SET status = 'error' WHERE id = ?", job.id);
    return;
  }
  const startedAt = Date.now();
  const result = await synthesizeHls({
    bucket: ctx.env.MEDIA,
    apiKey,
    ticket: job.ticket,
    text: job.text,
    voice: job.voice,
    canceled: () => streamStatus(ctx, job.id) !== "synthesizing",
  });
  ctx.db.run("UPDATE tts_streams SET status = ? WHERE id = ? AND status = 'synthesizing'", result.status, job.id);
  log("info", "tts_usage", {
    transport: "hls",
    status: result.status,
    segments: result.segments,
    requestChars: job.text.length,
    ...result.usage,
    durationMs: Date.now() - startedAt,
  });
};

// ── Dictation ──────────────────────────────────────────────────────────────

const prepareDictation = (ctx: OwnerContext, raw: unknown) => {
  const { sessionId } = object({ sessionId: string({ pattern: DICTATION_SESSION_ID }) })(raw);
  enforceOwnerRateLimit(ctx.db, ctx.now, "dictation", DICTATION_RATE, "Too many dictation sessions. Try again in a minute.");
  const access = billingAccess(ctx);
  const perSecond = usdToMicroCents(MUSE_STT_USD_PER_SECOND);
  const maxSeconds =
    access.remainingMicroCents === null
      ? MUSE_MAX_SESSION_SECONDS
      : Math.min(MUSE_MAX_SESSION_SECONDS, Math.floor(access.remainingMicroCents / perSecond));
  if (!access.allowed || maxSeconds < 1) {
    throw new RpcError("FORBIDDEN", access.message || "Your Stella usage allowance is too low to start dictation.", {
      reason: "usage_limit_reached",
    });
  }
  return {
    sessionId,
    providerDeadlineAt: ctx.now + maxSeconds * 1_000,
    maxAudioBytes: maxSeconds * PCM_BYTES_PER_SECOND,
  };
};

const settleDictation = (ctx: OwnerContext, raw: unknown) => {
  const { sessionId, audioBytes } = object({
    sessionId: string({ pattern: DICTATION_SESSION_ID }),
    audioBytes: number({ int: true, min: 0, max: MUSE_MAX_SESSION_SECONDS * PCM_BYTES_PER_SECOND }),
  })(raw);
  const costMicroCents = usdToMicroCents((audioBytes / PCM_BYTES_PER_SECOND) * MUSE_STT_USD_PER_SECOND);
  recordUsage(ctx, [{ id: `dictation:${sessionId}`, costMicroCents }]);
  return { costMicroCents };
};

// ── Purge ──────────────────────────────────────────────────────────────────

const purgeVoice = async (ctx: OwnerContext, mode: OwnerPurgeMode): Promise<{ pending: boolean }> => {
  const calls = ctx.db.all<{ call_id: string }>(
    "SELECT call_id FROM voice_leases WHERE call_id IS NOT NULL AND (status = 'open' OR hangup_pending = 1)",
  );
  ctx.db.run("DELETE FROM voice_leases");
  for (const { id } of ctx.db.all<{ id: string }>("SELECT id FROM tts_streams")) ctx.jobs.cancel(ttsJobId(id));
  ctx.db.run("DELETE FROM tts_streams");
  if (mode === "delete") ctx.db.run("DELETE FROM tts_daily");
  ctx.jobs.cancel(VOICE_REAP_JOB);
  await Promise.all(calls.map(({ call_id }) => hangupCall(ctx.env, call_id)));
  const bucket = ctx.env.MEDIA;
  if (!bucket) return { pending: false };
  const listed = await bucket.list({ prefix: await ttsOwnerPrefix(ctx.ownerId), limit: 1_000 });
  if (listed.objects.length > 0) await bucket.delete(listed.objects.map((object) => object.key));
  return { pending: listed.truncated };
};

// ── Registration ───────────────────────────────────────────────────────────

/** A JSON object, bounded by its serialized size. */
const jsonRecord =
  (maxBytes: number): Parser<Record<string, unknown>> =>
  (value, path = "") => {
    const parsed = json({ maxBytes })(value, path);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RpcError("BAD_REQUEST", `${path || "args"} must be an object.`);
    }
    return parsed as Record<string, unknown>;
  };

const toolArg: Parser<VoiceToolSchema> = object({
  type: literal("function"),
  name: string({ min: 1, max: 128 }),
  description: string({ min: 1, max: 8_192 }),
  parameters: jsonRecord(65_536),
});

export const voiceDomain = {
  name: "voice",
  migrations: [VOICE_MIGRATION],
  calls: {
    "voice.session": {
      scope: "owner",
      requireAccount: true,
      parse: object({
        instructions: string({ min: 1, max: 100_000 }),
        tools: optional(array(toolArg, { max: 128 })),
        voice: optional(string({ max: 100 })),
        model: optional(string({ max: 100 })),
        voiceProvider: optional(literal("openai", "xai", "inworld")),
        turnDetection: optional(literal("semantic_vad", "server_vad")),
        turnEagerness: optional(literal("low", "medium", "high")),
      }),
      handler: openSession,
    },
    "voice.lease": {
      scope: "owner",
      requireAccount: true,
      parse: object({
        leaseId: string({ min: 1, max: 200 }),
        event: literal("heartbeat", "ended", "expired", "lost"),
      }),
      handler: leaseEvent,
    },
    "voice.usage": {
      scope: "owner",
      requireAccount: true,
      parse: object({
        leaseId: string({ min: 1, max: 200 }),
        responseId: string({ min: 1, max: 200 }),
        usage: jsonRecord(16_384),
      }),
      handler: reportUsage,
    },
    "tts.prepare": {
      scope: "owner",
      requireAccount: true,
      parse: object({ text: string({ min: 1, max: 100_000 }), voice: optional(string({ max: 100 })) }),
      handler: prepareTts,
    },
    "dictation.realtimeConfig": {
      scope: "global",
      parse: empty(),
      handler: (ctx) => {
        const relayOrigin = ctx.env.CLOUD_BUILDER_PUBLIC_URL?.trim().replace(/\/+$/u, "");
        if (!relayOrigin) throw new RpcError("UNAVAILABLE", "Muse dictation is not configured.", { retryable: false });
        return { relayOrigin, modelId: MUSE_DICTATION_MODEL };
      },
    },
  },
  internal: {
    "voice.sdp": createCall,
    "tts.admit": (ctx, raw) => {
      const { chars } = object({ chars: number({ int: true, min: 1, max: TTS_MAX_INPUT_CHARS }) })(raw);
      admitTts(ctx, chars);
      return { ok: true };
    },
    "tts.cancel": (ctx, raw) => {
      const { id } = object({ id: string({ min: 1, max: 64 }) })(raw);
      ctx.db.run("UPDATE tts_streams SET status = 'canceled' WHERE id = ? AND status = 'synthesizing'", id);
      return { ok: true };
    },
    "dictation.prepare": prepareDictation,
    "dictation.settle": settleDictation,
  },
  jobs: {
    [VOICE_REAP_JOB]: { run: (ctx: OwnerContext) => reap(ctx) },
    [TTS_SYNTHESIZE_JOB]: { run: synthesize, maxAttempts: 1 },
  },
  purge: purgeVoice,
} satisfies OwnerDomain;
