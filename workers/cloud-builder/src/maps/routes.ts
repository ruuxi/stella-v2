import { MAPS_RESOLVE_PATH } from "@stella/contracts/map-artifact";
import { rpcErrorStatus } from "@stella/contracts/backend/protocol";
import { verifyCaller } from "../owner-store/routes.js";
import { ownerGeneration, voiceInternal } from "../voice/routes.js";
import { ownerMapsAdmission } from "./admission.js";
import { mapsServerKey, resolveMapRequest } from "./google-resolve.js";

const MAX_BODY_BYTES = 16 * 1024;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const readBoundedText = async (request: Request): Promise<string | null> => {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
};

export const handleMapsRoute = async (request: Request, env: Cloudflare.Env): Promise<Response | null> => {
  if (new URL(request.url).pathname !== MAPS_RESOLVE_PATH) return null;
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const header = request.headers.get("authorization") ?? "";
  const verified = await verifyCaller(env, header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  if (!verified.ok) return json({ error: verified.error.message }, rpcErrorStatus(verified.error.code));
  const text = await readBoundedText(request);
  if (text === null) return json({ error: "The map request is too large." }, 413);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }
  const ownerId = verified.caller.ownerId;
  const generation = await ownerGeneration(env, ownerId);
  const result = await resolveMapRequest(body, mapsServerKey(env), {
    signal: request.signal,
    admit: ownerMapsAdmission((name, args) => voiceInternal(env, ownerId, generation, name, args)),
  });
  return json(result.body, result.status);
};
