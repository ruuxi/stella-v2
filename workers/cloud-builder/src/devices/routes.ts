/**
 * Devices' HTTP surface on the Worker.
 *
 *   /api/mobile/<route>             phones (pairing, push tokens), user JWT
 *
 * A phone's requests to one of the owner's computers are not here: they are
 * `POST /owners/me/devices/:deviceId/requests` (device-request-route.ts).
 *
 * Desktop UI and runtime use backend calls (`devices.*`, `phone.*`) instead.
 */

import { readJsonObject } from "../http/body.js";
import { requireCaller } from "../http/caller.js";
import { fail, failRpcError } from "../http/response.js";

const MOBILE_PREFIX = "/api/mobile/";
const MAX_BODY_BYTES = 64 * 1024;

const mobileRoute = async (request: Request, env: Cloudflare.Env, url: URL): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "POST") return fail(405, "Method not allowed");
  const verified = await requireCaller(request, env, { allowAnonymous: false });
  if (!verified.ok) return failRpcError(verified.error);
  const body =
    request.method === "POST"
      ? await readJsonObject(request, MAX_BODY_BYTES, { allowEmpty: true })
      : ({ ok: true, value: {} } as const);
  if (!body.ok) return fail(body.status, body.error);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (name.startsWith("x-stella-mobile-")) headers[name] = value;
  });
  const result = await env.OWNER_GATES.getByName(verified.caller.ownerId).mobileRoute({
    route: `${request.method} ${url.pathname.slice(MOBILE_PREFIX.length)}`,
    caller: verified.caller,
    query: Object.fromEntries(url.searchParams),
    body: body.value,
    headers,
  });
  return new Response(result.json, {
    status: result.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

/** Devices routes, or null when the request is not one. */
export const handleDevicesRoute = async (request: Request, env: Cloudflare.Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname.startsWith(MOBILE_PREFIX)) return await mobileRoute(request, env, url);
  return null;
};
