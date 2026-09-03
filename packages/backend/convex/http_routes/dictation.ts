/**
 * Muse Voice Transcribe control plane.
 *
 * Audio never passes through Convex. Clients stream 16 kHz mono PCM to the
 * Cloudflare relay, which keeps the Meta API key server-side. Convex only
 * authenticates the user, applies the pre-spend gate, and records metered
 * audio after the stream closes.
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  errorResponse,
  handleCorsRequest,
  jsonResponse,
  registerCorsOptions,
} from "../http_shared/cors";
import { requireSignedInAccountAction } from "../http_shared/auth";
import { dollarsToMicroCents } from "../lib/billing_money";
import { runManagedGate } from "../lib/gate_and_meter";

const DICTATION_RATE_LIMIT = 30;
const DICTATION_RATE_WINDOW_MS = 60_000;
const PCM_BYTES_PER_SECOND = 16_000 * 2;
const SESSION_ID_PATTERN = /^muse_[0-9a-f-]{36}$/u;

export const MUSE_DICTATION_MODEL = "muse-voice-transcribe-1.0";
export const MUSE_STT_USD_PER_SECOND = 0.18 / 3600;

const hasBuilderAuthorization = (request: Request): boolean => {
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );
};

export const registerDictationRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, ["/api/dictation/realtime-config"]);

  http.route({
    path: "/api/dictation/realtime-config",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use dictation.",
          realm: "stella-dictation",
        });
        if (!auth.ok) return auth.response;

        const relayOrigin = process.env.CLOUD_BUILDER_URL?.trim().replace(
          /\/+$/u,
          "",
        );
        if (!relayOrigin) {
          return errorResponse(
            503,
            "Muse dictation is not configured.",
            origin,
          );
        }
        return jsonResponse(
          { relayOrigin, modelId: MUSE_DICTATION_MODEL },
          200,
          origin,
        );
      }),
    ),
  });

  http.route({
    path: "/api/cloud/dictation/prepare",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!hasBuilderAuthorization(request)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const body = (await request.json().catch(() => null)) as {
        ownerId?: unknown;
      } | null;
      const ownerId =
        typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
      if (!ownerId) {
        return Response.json({ error: "ownerId required" }, { status: 400 });
      }

      const gate = await runManagedGate(ctx, null, {
        ownerId,
        order: ["usage", "rate"],
        usage: {},
        rateLimit: {
          scope: "dictation_transcribe",
          key: ownerId,
          limit: DICTATION_RATE_LIMIT,
          windowMs: DICTATION_RATE_WINDOW_MS,
          blockMs: DICTATION_RATE_WINDOW_MS,
        },
      });
      if (!gate.ok) return gate.response;

      return Response.json({
        sessionId: `muse_${crypto.randomUUID()}`,
        ownerGeneration: gate.ownerGeneration,
      });
    }),
  });

  http.route({
    path: "/api/cloud/dictation/settle",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!hasBuilderAuthorization(request)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const body = (await request.json().catch(() => null)) as {
        ownerId?: unknown;
        ownerGeneration?: unknown;
        sessionId?: unknown;
        audioBytes?: unknown;
        durationMs?: unknown;
        success?: unknown;
      } | null;
      const ownerId =
        typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
      const ownerGeneration =
        typeof body?.ownerGeneration === "string"
          ? body.ownerGeneration.trim()
          : "";
      const sessionId =
        typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      const audioBytes =
        typeof body?.audioBytes === "number" && Number.isFinite(body.audioBytes)
          ? Math.max(0, Math.floor(body.audioBytes))
          : -1;
      if (
        !ownerId ||
        !ownerGeneration ||
        !SESSION_ID_PATTERN.test(sessionId) ||
        audioBytes < 0
      ) {
        return Response.json({ error: "Invalid settlement" }, { status: 400 });
      }

      const audioSeconds = audioBytes / PCM_BYTES_PER_SECOND;
      await ctx.runMutation(internal.billing.logDictationUsage, {
        ownerId,
        ownerGeneration,
        model: MUSE_DICTATION_MODEL,
        durationMs:
          typeof body?.durationMs === "number" &&
          Number.isFinite(body.durationMs)
            ? Math.max(0, Math.round(body.durationMs))
            : Math.round(audioSeconds * 1000),
        success: body?.success === true,
        costMicroCents: dollarsToMicroCents(
          audioSeconds * MUSE_STT_USD_PER_SECOND,
        ),
      });
      return Response.json({ ok: true });
    }),
  });
};
