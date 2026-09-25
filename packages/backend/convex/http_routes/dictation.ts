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
import { authRequiredResponse } from "../http_shared/auth";
import { dollarsToMicroCents } from "../lib/billing_money";
import { managedGateFailureResponse } from "../lib/gate_and_meter";
import {
  MUSE_DICTATION_MODEL,
  MUSE_MAX_SESSION_MS,
  MUSE_STT_USD_PER_SECOND,
  PCM_BYTES_PER_SECOND,
  SESSION_ID_PATTERN,
  sessionAuthority,
  sessionBilling,
} from "../dictation_sessions";

export {
  MUSE_DICTATION_MODEL,
  MUSE_MAX_SESSION_MS,
  MUSE_STT_USD_PER_SECOND,
} from "../dictation_sessions";

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
        // Account-free clients have a verified Better Auth anonymous owner.
        // Keep that owner authenticated; the relay applies the same metered
        // usage and rate gates to anonymous and registered sessions.
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return authRequiredResponse(origin, {
            message: "Stella could not verify this session. Try again.",
            action: "Refresh the Stella session and retry dictation.",
            realm: "stella-dictation",
          });
        }

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
        sessionId?: unknown;
      } | null;
      const ownerId =
        typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
      if (!ownerId) {
        return Response.json({ error: "ownerId required" }, { status: 400 });
      }

      // The relay may choose the session id so it can open the provider
      // socket while this runs; the handshake still waits for the commit.
      const requestedSessionId =
        typeof body?.sessionId === "string" ? body.sessionId : undefined;
      if (
        requestedSessionId !== undefined &&
        !SESSION_ID_PATTERN.test(requestedSessionId)
      ) {
        return Response.json({ error: "Invalid sessionId" }, { status: 400 });
      }
      const prepared = await ctx.runMutation(internal.dictation_sessions.prepare, {
        ownerId,
        sessionId: requestedSessionId ?? `muse_${crypto.randomUUID()}`,
        now: Date.now(),
      });
      if (prepared.ok) {
        const { ok: _ok, ...session } = prepared;
        return Response.json(session);
      }
      switch (prepared.reason) {
        case "rate":
          return managedGateFailureResponse(
            { ok: false, gate: "rate", retryAfterMs: prepared.retryAfterMs },
            null,
          );
        case "usage":
          return Response.json(
            { error: prepared.message, code: "usage_limit_reached" },
            { status: 429 },
          );
        default:
          return Response.json(
            { error: "Session unavailable" },
            { status: 409 },
          );
      }
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
        audioBytes < 0 ||
        audioBytes > (MUSE_MAX_SESSION_MS / 1000) * PCM_BYTES_PER_SECOND
      ) {
        return Response.json({ error: "Invalid settlement" }, { status: 400 });
      }

      const audioSeconds = audioBytes / PCM_BYTES_PER_SECOND;
      const receipt = await ctx.runQuery(internal.dictation_sessions.receipt, {
        ownerId,
        ownerGeneration,
        sessionId,
      });
      if (!receipt)
        return Response.json({ error: "Session unavailable" }, { status: 409 });
      if (audioBytes > (receipt.maxMs / 1000) * PCM_BYTES_PER_SECOND)
        return Response.json(
          { error: "Audio exceeds the reserved session allowance" },
          { status: 400 },
        );
      const authority = sessionAuthority(ownerId, ownerGeneration, sessionId);
      const captured = await ctx.runMutation(
        internal.billing.captureManagedProviderDispatchUsageInternal,
        {
          ...authority,
          billing: sessionBilling(sessionId, receipt.fallbackCostMicroCents),
          now: Date.now(),
          usage: {
            durationMs:
              typeof body?.durationMs === "number" &&
              Number.isFinite(body.durationMs)
                ? Math.max(0, Math.round(body.durationMs))
                : Math.round(audioSeconds * 1000),
            success: body?.success === true,
            costMicroCents: dollarsToMicroCents(
              audioSeconds * MUSE_STT_USD_PER_SECOND,
            ),
          },
        },
      );
      if (!captured)
        return Response.json({ error: "Session unavailable" }, { status: 409 });
      const settled = await ctx.runMutation(
        internal.billing.settleManagedProviderDispatchInternal,
        {
          ...authority,
          outcome: body?.success === true ? "succeeded" : "failed",
          now: Date.now(),
        },
      );
      if (!settled)
        return Response.json({ error: "Session unavailable" }, { status: 409 });
      return Response.json({ ok: true });
    }),
  });
};
