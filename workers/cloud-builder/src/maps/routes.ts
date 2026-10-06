/**
 * POST /api/maps/resolve: the desktop `map` tool's resolver. A signed-in
 * Stella bearer (anonymous included) is required so the Google key isn't an
 * open proxy.
 */

import { MAPS_RESOLVE_PATH } from "@stella/contracts/map-artifact";
import { rpcErrorStatus } from "@stella/contracts/backend/protocol";
import { verifyCaller } from "../owner-store/routes.js";
import { mapsServerKey, resolveMapRequest } from "./google-resolve.js";

const MAX_BODY_BYTES = 16 * 1024;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const handleMapsRoute = async (request: Request, env: Cloudflare.Env): Promise<Response | null> => {
  if (new URL(request.url).pathname !== MAPS_RESOLVE_PATH) return null;
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const header = request.headers.get("authorization") ?? "";
  const verified = await verifyCaller(env, header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  if (!verified.ok) return json({ error: verified.error.message }, rpcErrorStatus(verified.error.code));
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return json({ error: "The map request is too large." }, 413);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "The map request is too large." }, 413);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }
  const result = await resolveMapRequest(body, mapsServerKey(env), { signal: request.signal });
  return json(result.body, result.status);
};
