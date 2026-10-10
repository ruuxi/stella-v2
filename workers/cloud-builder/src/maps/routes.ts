import { MAPS_RESOLVE_PATH } from "@stella/contracts/map-artifact";
import { readJsonBody } from "../http/body.js";
import { requireCaller } from "../http/caller.js";
import { fail, failRpcError, json } from "../http/response.js";
import { ownerGeneration, voiceInternal } from "../voice/routes.js";
import { ownerMapsAdmission } from "./admission.js";
import { mapsServerKey, resolveMapRequest } from "./google-resolve.js";

const MAX_BODY_BYTES = 16 * 1024;

export const handleMapsRoute = async (request: Request, env: Cloudflare.Env): Promise<Response | null> => {
  if (new URL(request.url).pathname !== MAPS_RESOLVE_PATH) return null;
  if (request.method !== "POST") return fail(405, "Method not allowed.");
  const verified = await requireCaller(request, env, { allowAnonymous: true });
  if (!verified.ok) return failRpcError(verified.error);
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return fail(body.status, body.status === 413 ? "The map request is too large." : body.error);
  const ownerId = verified.caller.ownerId;
  const generation = await ownerGeneration(env, ownerId);
  const result = await resolveMapRequest(body.value, mapsServerKey(env), {
    signal: request.signal,
    admit: ownerMapsAdmission((name, args) => voiceInternal(env, ownerId, generation, name, args)),
  });
  return json(result.body, result.status);
};
