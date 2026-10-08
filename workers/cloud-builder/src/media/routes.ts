/**
 * Managed media over HTTP, for the CLI, the desktop runtime and API clients:
 *
 *   GET    /api/media/v1/models           the model list (public)
 *   POST   /api/media/v1/generate         `media.generate`; `Idempotency-Key` is its client request key
 *   GET    /api/media/v1/job              one job by `jobId` or `clientRequestKey`, outputs freshly signed
 *   DELETE /api/media/v1/job              `media.cancel` for the `Idempotency-Key`
 *   POST   /api/media/v1/webhooks/fal     fal's completion webhook (fal ED25519 + the job's own token)
 *
 * Bearer JWTs are verified here and the work runs in the owner's object,
 * exactly as `/api/rpc` does; these routes only adapt the wire shape.
 */

import { rpcErrorStatus, type RpcResponse } from "@stella/contracts/backend/protocol";
import { sha256Hex } from "../hash.js";
import { verifyCaller } from "../owner-store/routes.js";
import type { OwnerCaller } from "../owner-store/registry.js";
import { MEDIA_MODELS } from "@stella/contracts/media-models";
import { MEDIA_DOCS_URL } from "../owner-store/domains/media.js";
import { FAL_WEBHOOK_PATH, readFalWebhookUrl, verifyFalSignature } from "./fal.js";

const BASE = "/api/media/v1";
/** Inline sources ride in the body; the owner object stages them in R2. */
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_WEBHOOK_BYTES = 4 * 1024 * 1024;
const AUTH_ACTION =
  "Ask the user to open the Stella desktop app and finish signing in (Settings → Account, or the welcome screen on first launch). Once they're signed in, retry the same request — no payload changes needed.";

type RouteEnv = Pick<Cloudflare.Env, "OWNER_GATES" | "CLOUD_BUILDER_PUBLIC_URL">;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response =>
  json({ error, ...extra, docsUrl: MEDIA_DOCS_URL }, status);

/** An owner-object error as the JSON envelope media clients have always read. */
const failRpc = (response: Extract<RpcResponse, { ok: false }>): Response => {
  const { code, message, reason, retryAfterMs } = response.error;
  // A plan gate is "upgrade", not "bad credential": 402, as before.
  const status = reason === "capability_required" ? 402 : rpcErrorStatus(code);
  return fail(status, message, {
    code: reason === "capability_required" ? "CAPABILITY_REQUIRED" : code,
    ...(reason ? { reason } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
};

const authenticate = async (
  request: Request,
  env: RouteEnv,
): Promise<{ ok: true; caller: OwnerCaller } | { ok: false; response: Response }> => {
  const header = request.headers.get("authorization") ?? "";
  const verified = await verifyCaller(env, header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  if (verified.ok) return verified;
  if (verified.error.code !== "UNAUTHENTICATED") {
    return { ok: false, response: fail(rpcErrorStatus(verified.error.code), verified.error.message) };
  }
  return {
    ok: false,
    response: fail(401, "Sign in to Stella to use media generation.", {
      code: "auth_required",
      action: AUTH_ACTION,
    }),
  };
};

const readText = async (request: Request, maxBytes: number): Promise<string | null> => {
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) return null;
  const text = await request.text();
  return text.length > maxBytes ? null : text;
};

const rpc = async (env: RouteEnv, caller: OwnerCaller, name: string, args: unknown): Promise<RpcResponse> =>
  await env.OWNER_GATES.getByName(caller.ownerId).ownerRpc({ name, args, caller });

const internal = async (env: RouteEnv, ownerId: string, name: string, args: unknown): Promise<RpcResponse> => {
  const gate = env.OWNER_GATES.getByName(ownerId);
  const { ownerGeneration } = await gate.snapshot();
  return await gate.ownerInternal({ name, args, ownerGeneration });
};

const generate = async (request: Request, env: RouteEnv): Promise<Response> => {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  const raw = await readText(request, MAX_BODY_BYTES);
  if (raw === null) return fail(413, "The media request is too large.");
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(400, "Invalid media generation JSON body.");
  }
  const clientRequestKey = request.headers.get("idempotency-key")?.trim();
  const response = await rpc(env, auth.caller, "media.generate", {
    ...(body as Record<string, unknown>),
    ...(clientRequestKey ? { clientRequestKey, requestHash: await sha256Hex(raw!) } : {}),
  });
  return response.ok ? json(response.value, 202) : failRpc(response);
};

const job = async (request: Request, env: RouteEnv): Promise<Response> => {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  if (request.method === "DELETE") {
    const clientRequestKey = request.headers.get("idempotency-key")?.trim();
    if (!clientRequestKey) return fail(400, "Idempotency-Key is required to cancel a media request.");
    const response = await rpc(env, auth.caller, "media.cancel", { clientRequestKey });
    return response.ok ? json(response.value) : failRpc(response);
  }
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId")?.trim();
  const clientRequestKey = url.searchParams.get("clientRequestKey")?.trim();
  if (!jobId && !clientRequestKey) return fail(400, "Missing jobId or clientRequestKey.");
  const response = await internal(env, auth.caller.ownerId, "media.lookup", jobId ? { jobId } : { clientRequestKey });
  if (!response.ok) return failRpc(response);
  return response.value ? json(response.value) : fail(404, "Media job not found.");
};

const falWebhook = async (request: Request, env: RouteEnv): Promise<Response> => {
  const now = Date.now();
  const target = readFalWebhookUrl(new URL(request.url));
  if (!target) return fail(401, "Invalid webhook URL.");
  const raw = await readText(request, MAX_WEBHOOK_BYTES);
  if (raw === null) return fail(413, "Webhook body is too large.");
  if (!(await verifyFalSignature(request.headers, raw, now))) return fail(400, "Invalid fal webhook signature.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "Invalid fal webhook payload.");
  }
  const response = await internal(env, target.ownerId, "media.falWebhook", {
    jobId: target.jobId,
    token: target.token,
    body,
  });
  if (!response.ok) {
    // fal retries a non-2xx; only an outage is worth another delivery.
    if (response.error.code === "UNAVAILABLE" || response.error.code === "INTERNAL") return failRpc(response);
    return json({ received: true, discarded: response.error.code });
  }
  return json(response.value);
};

/** The media routes, or null when the path is someone else's. */
export const handleMediaRoute = async (request: Request, env: RouteEnv): Promise<Response | null> => {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(`${BASE}/`)) return null;
  if (path === `${BASE}/models`) {
    return request.method === "GET"
      ? json({
          data: MEDIA_MODELS.map(({ id, name, kind, does, docsUrl }) => ({ id, name, kind, does, docsUrl })),
          docsUrl: MEDIA_DOCS_URL,
        })
      : fail(405, "Method not allowed.");
  }
  if (path === `${BASE}/generate`) {
    return request.method === "POST" ? await generate(request, env) : fail(405, "Method not allowed.");
  }
  if (path === `${BASE}/job`) {
    return request.method === "GET" || request.method === "DELETE"
      ? await job(request, env)
      : fail(405, "Method not allowed.");
  }
  if (path === FAL_WEBHOOK_PATH) {
    return request.method === "POST" ? await falWebhook(request, env) : fail(405, "Method not allowed.");
  }
  return fail(404, "Not found.");
};
