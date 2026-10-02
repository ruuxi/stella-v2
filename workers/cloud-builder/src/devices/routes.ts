/**
 * Devices' HTTP surface on the Worker.
 *
 *   /api/mobile/<route>             phones and the desktop's bridge service, user JWT
 *   POST /internal/devices/close    Convex account deletion: delete the owner's tunnels
 *
 * Desktop UI and runtime use backend calls (`devices.*`, `phone.*`) instead.
 */

import { verifyServiceBearerRequest } from "../service-bearer.js";
import { verifyCaller } from "../owner-store/routes.js";

const MOBILE_PREFIX = "/api/mobile/";
const MAX_BODY_BYTES = 64 * 1024;
const OWNER_ID_MAX = 512;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (request.method !== "POST") return {};
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  if (!text) return {};
  try {
    const body = JSON.parse(text) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const mobileRoute = async (request: Request, env: Cloudflare.Env, url: URL): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const header = request.headers.get("authorization") ?? "";
  const verified = await verifyCaller(env, header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  if (!verified.ok) {
    return json({ error: verified.error.message }, verified.error.code === "UNAUTHENTICATED" ? 401 : 503);
  }
  if (verified.caller.isAnonymous) return json({ error: "Sign in with an account to use this." }, 403);
  const body = await readBody(request);
  if (!body) return json({ error: "Request body must be a JSON object" }, 400);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (name.startsWith("x-stella-mobile-")) headers[name] = value;
  });
  const result = await env.OWNER_GATES.getByName(verified.caller.ownerId).mobileRoute({
    route: `${request.method} ${url.pathname.slice(MOBILE_PREFIX.length)}`,
    caller: verified.caller,
    query: Object.fromEntries(url.searchParams),
    body,
    headers,
  });
  return new Response(result.json, {
    status: result.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

const closeRoute = async (request: Request, env: Cloudflare.Env): Promise<Response> => {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!(await verifyServiceBearerRequest(request, env.BUILDER_SERVICE_SECRET))) {
    return json({ error: "Unauthorized." }, 401);
  }
  const body = await readBody(request);
  const ownerId = typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
  if (!ownerId || ownerId.length > OWNER_ID_MAX) return json({ error: "ownerId is required." }, 400);
  await env.OWNER_GATES.getByName(ownerId).closeDevices();
  return json({ ok: true });
};

/** Devices routes, or null when the request is not one. */
export const handleDevicesRoute = async (request: Request, env: Cloudflare.Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname.startsWith(MOBILE_PREFIX)) return await mobileRoute(request, env, url);
  if (url.pathname === "/internal/devices/close") return await closeRoute(request, env);
  return null;
};
