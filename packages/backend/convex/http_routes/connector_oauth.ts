import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireAdminRequest } from "../http_shared/admin";
import { readRequestTextBounded } from "../http_shared/bounded_request_body";
import { ROLLOUT_MODES, type RolloutMode } from "../connectors/routing";

/**
 * HTTP surface for the first-party connector core:
 *  - the shared hosted OAuth callback (the provider redirect target), and
 *  - the admin rollout control.
 *
 * Connect-start, status, account listing, binding, disconnect and execution are
 * exposed as authenticated Convex functions (Convex-client callable), matching
 * the existing X OAuth precedent where only the callback is an HTTP route.
 */

const MAX_ADMIN_BODY_BYTES = 64 * 1024;

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * Branded result page. Strict CSP, no-store, no-referrer, no analytics, and no
 * provider response detail. The optional deep link carries ONLY the opaque
 * attempt id — never code, state, tokens, email, or error payloads.
 */
const buildResultPage = (
  success: boolean,
  message: string,
  deepLink?: string,
): string => {
  const title = success ? "Connected to Stella" : "Connection not completed";
  const color = success ? "#165c46" : "#8a2f2f";
  const safeMessage = escapeHtml(message);
  const linkHtml = deepLink
    ? `<p><a href="${escapeHtml(deepLink)}">Return to Stella</a></p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; background:#fbfaf6; color:#17201d; }
  .card { text-align:center; max-width:420px; padding:3rem; }
  h1 { font-size:1.5rem; margin:0 0 .5rem; color:${color}; }
  p { color:#5e6a66; line-height:1.6; }
  a { color:#235b8c; }
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${safeMessage}</p>${linkHtml}</div></body></html>`;
};

const htmlResponse = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const registerConnectorOAuthRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/connectors/oauth/callback",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (!state) {
        return htmlResponse(
          buildResultPage(false, "Missing authorization state."),
          400,
        );
      }
      let result: {
        status: "succeeded" | "denied" | "failed" | "invalid";
        attemptId?: string;
      };
      try {
        result = await ctx.runAction(
          internal.connectors.oauth.callback.handleOAuthCallback,
          {
            state,
            code: code ?? undefined,
            error: error ?? undefined,
          },
        );
      } catch (err) {
        console.error("[connectors] oauth callback failed", {
          message: err instanceof Error ? err.name : "error",
        });
        return htmlResponse(
          buildResultPage(false, "We couldn't complete the connection."),
          500,
        );
      }
      const success = result.status === "succeeded";
      const message = success
        ? "The connection is ready. You can return to Stella."
        : result.status === "denied"
          ? "The connection was declined."
          : "We couldn't complete the connection. Please try again from Stella.";
      const deepLink =
        result.attemptId && success
          ? `stella://oauth/complete?attempt=${encodeURIComponent(result.attemptId)}`
          : undefined;
      return htmlResponse(
        buildResultPage(success, message, deepLink),
        success ? 200 : result.status === "invalid" ? 410 : 400,
      );
    }),
  });

  http.route({
    path: "/api/admin/connectors/rollouts",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;
      let body: unknown;
      try {
        const text = await readRequestTextBounded(request, MAX_ADMIN_BODY_BYTES);
        body = JSON.parse(text) as unknown;
      } catch {
        return jsonResponse({ error: "Invalid rollout payload." }, 400);
      }
      if (!isJsonObject(body)) {
        return jsonResponse({ error: "Invalid rollout payload." }, 400);
      }
      const connectorId =
        typeof body.connectorId === "string" ? body.connectorId.trim() : "";
      const mode = typeof body.mode === "string" ? body.mode : "";
      if (!connectorId || !ROLLOUT_MODES.includes(mode as RolloutMode)) {
        return jsonResponse({ error: "connectorId and a valid mode are required." }, 400);
      }
      const canaryPercent =
        typeof body.canaryPercent === "number" ? body.canaryPercent : undefined;
      const saltVersion =
        typeof body.saltVersion === "number" ? body.saltVersion : undefined;
      const allowedFallbacks = Array.isArray(body.allowedFallbacks)
        ? body.allowedFallbacks.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : undefined;
      const minimumClientVersion =
        typeof body.minimumClientVersion === "string"
          ? body.minimumClientVersion
          : undefined;
      try {
        const rollout = await ctx.runMutation(
          internal.connectors.rollouts.setConnectorRollout,
          {
            connectorId,
            mode: mode as RolloutMode,
            canaryPercent,
            saltVersion,
            allowedFallbacks,
            minimumClientVersion,
          },
        );
        return jsonResponse({ ok: true, rollout }, 200);
      } catch (err) {
        console.error("[connectors] rollout update rejected", {
          message: err instanceof Error ? err.message : "error",
        });
        return jsonResponse({ error: "Invalid rollout payload." }, 400);
      }
    }),
  });
};
