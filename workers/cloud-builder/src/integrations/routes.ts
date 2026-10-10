/**
 * Integrations over HTTP, for the desktop runtime, Electron and the
 * `stella-x-api` CLI:
 *
 *   GET  /api/native-integrations/catalog        the executable Store catalog (public)
 *   GET  /api/native-integrations/actions        ?id&action|query&cursor&limit
 *   GET  /api/native-integrations/connections    `integrations.connections`
 *   GET  /api/native-integrations/status         ?id → `integrations.status`
 *   POST /api/native-integrations/connect-link   {id} → `integrations.connectLink`
 *   POST /api/native-integrations/run            {id, action, input}; `x-stella-request-id` or `Idempotency-Key`
 *   POST /api/admin/native-integrations/upsert   publish one integration (STELLA_ADMIN_API_SECRET)
 *   GET  /api/native-oauth/providers             configured server-side token exchanges
 *   POST /api/native-oauth/token                 one token exchange
 *   GET  /api/x/connect-url | /api/x/connections, POST /api/x/request
 *   GET  /api/x/oauth_callback                   X's redirect, with the signed state
 *
 * Bearer JWTs are verified here and owner work runs in the owner's object,
 * as `/api/rpc` does. Errors are `{ error }` with the RPC error's status.
 */

import { rpcErrorStatus, type RpcResponse } from "@stella/contracts/backend/protocol";
import { X_OAUTH_CALLBACK_PATH } from "@stella/contracts/backend/integrations";
import { verifyOAuthState } from "../oauth-state.js";
import { RpcError } from "../owner-store/errors.js";
import { readJsonObject, type BodyResult } from "../http/body.js";
import { requireCaller } from "../http/caller.js";
import { fail, failRpcError, json } from "../http/response.js";
import type { OwnerCaller } from "../owner-store/registry.js";
import { verifyServiceBearerRequest } from "../service-bearer.js";
import { listIntegrationActions, listIntegrationCatalog, publishIntegration } from "./catalog.js";
import { exchangeNativeOAuthToken, listNativeOAuthProviders } from "./native-oauth.js";
import { X_STATE_KIND, xResultPage } from "./x.js";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ADMIN_BODY_BYTES = 8 * 1024 * 1024;

type RouteEnv = Cloudflare.Env;

const failError = (error: unknown): Response => {
  if (error instanceof RpcError) return failRpcError(error);
  console.error(JSON.stringify({
    event: "integration_route_failed",
    message: error instanceof Error ? error.message : String(error),
  }));
  return fail(500, "Stella hit an error. Try again.");
};

const respond = (response: RpcResponse): Response =>
  response.ok ? json(response.value) : failRpcError(response.error);

const authenticate = async (
  request: Request,
  env: RouteEnv,
): Promise<{ ok: true; caller: OwnerCaller } | { ok: false; response: Response }> => {
  const verified = await requireCaller(request, env, { allowAnonymous: false, anonymousMessage: "sign_in_required" });
  return verified.ok ? verified : { ok: false, response: failRpcError(verified.error) };
};

/** A refused body: 413 says so, anything else gets the route's own message. */
const failBody = (body: Extract<BodyResult<unknown>, { ok: false }>, invalid: string): Response =>
  fail(body.status, body.status === 413 ? body.error : invalid);

const rpc = async (env: RouteEnv, caller: OwnerCaller, name: string, args: unknown): Promise<RpcResponse> =>
  await env.OWNER_GATES.getByName(caller.ownerId).ownerRpc({ name, args, caller });

const internal = async (env: RouteEnv, ownerId: string, name: string, args: unknown): Promise<RpcResponse> => {
  const gate = env.OWNER_GATES.getByName(ownerId);
  const { ownerGeneration } = await gate.snapshot();
  return await gate.ownerInternal({ name, args, ownerGeneration });
};

/** An owner call with JSON in and out, authenticated by the bearer. */
const ownerCall = async (
  request: Request,
  env: RouteEnv,
  name: string,
  args: (body: Record<string, unknown> | null, url: URL) => unknown,
): Promise<Response> => {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  let body: Record<string, unknown> | null = null;
  if (request.method === "POST") {
    const read = await readJsonObject(request, MAX_BODY_BYTES);
    if (!read.ok) return failBody(read, "Invalid JSON body.");
    body = read.value;
  }
  return respond(await rpc(env, auth.caller, name, args(body, new URL(request.url))));
};

const actions = async (request: Request, env: RouteEnv): Promise<Response> => {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  const params = new URL(request.url).searchParams;
  const id = params.get("id")?.trim().toLowerCase();
  if (!id) return fail(400, "Missing integration id.");
  const limit = params.get("limit");
  if (limit !== null && !/^\d{1,3}$/u.test(limit)) return fail(400, "Action page limit must be an integer from 1 to 100.");
  const query = params.get("query")?.trim();
  if (query && query.length > 200) return fail(400, "Action query is too long.");
  try {
    const page = await listIntegrationActions(env, {
      id,
      ...(params.get("action") ? { action: params.get("action")!.trim() } : {}),
      ...(query ? { query } : {}),
      ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
      ...(limit !== null ? { limit: Number(limit) } : {}),
    });
    return page ? json(page) : fail(404, "Executable integration actions are unavailable.");
  } catch (error) {
    return failError(error);
  }
};

const run = async (request: Request, env: RouteEnv): Promise<Response> =>
  await ownerCall(request, env, "integrations.run", (body) => ({
    id: body?.id,
    action: body?.action,
    input: body?.input,
    requestId: (request.headers.get("x-stella-request-id") ?? request.headers.get("idempotency-key") ?? "").trim(),
  }));

const adminUpsert = async (request: Request, env: RouteEnv): Promise<Response> => {
  const secret = (env as unknown as Record<string, unknown>).STELLA_ADMIN_API_SECRET;
  if (!(await verifyServiceBearerRequest(request, typeof secret === "string" ? secret : null))) {
    return fail(401, "Unauthorized");
  }
  const body = await readJsonObject(request, MAX_ADMIN_BODY_BYTES);
  if (!body.ok) return failBody(body, "Invalid integration payload.");
  try {
    return json({ ok: true, ...(await publishIntegration(env, body.value)) });
  } catch (error) {
    return failError(error);
  }
};

const nativeOAuthToken = async (request: Request, env: RouteEnv): Promise<Response> => {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (!body.ok) return failBody(body, "Invalid JSON body.");
  try {
    const result = await exchangeNativeOAuthToken(env, body.value);
    return json(result.body, result.status);
  } catch (error) {
    return failError(error);
  }
};

const xRequest = async (request: Request, env: RouteEnv): Promise<Response> => {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  const read = await readJsonObject(request, MAX_BODY_BYTES);
  if (!read.ok) return failBody(read, "Provide method and an X API v2 path such as /2/users/me.");
  const body = read.value;
  const response = await rpc(env, auth.caller, "x.request", {
    ...(body.method !== undefined ? { method: body.method } : {}),
    path: body.path,
    ...(body.query !== undefined ? { query: body.query } : {}),
    ...(body.body !== undefined ? { body: body.body } : {}),
  });
  if (!response.ok) return respond(response);
  // The CLI reads X's own status and body.
  const { status, payload } = response.value as { status: number; payload: unknown };
  return json(payload, status);
};

const xCallback = async (request: Request, env: RouteEnv): Promise<Response> => {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!state) return xResultPage(false, "Missing OAuth state.", 400);
  const verified = await verifyOAuthState(env, state);
  if (!verified || verified.kind !== X_STATE_KIND) {
    return xResultPage(false, "Invalid or expired OAuth state. Please start the X connection again.", 400);
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  let response: RpcResponse;
  try {
    response = await internal(env, verified.ownerId, "x.completeOAuth", {
      nonce: verified.nonce,
      ...(code ? { code } : {}),
      ...(error ? { error: error.slice(0, 512) } : {}),
    });
  } catch (cause) {
    console.error(JSON.stringify({
      event: "x_oauth_callback_failed",
      message: cause instanceof Error ? cause.message : String(cause),
    }));
    return xResultPage(false, "X connection failed. Please retry the connection.", 500);
  }
  if (!response.ok) {
    return xResultPage(false, response.error.message, rpcErrorStatus(response.error.code));
  }
  const { username } = response.value as { username: string };
  return xResultPage(true, `Connected @${username} to Stella. You can close this tab.`, 200);
};

const methodNotAllowed = () => fail(405, "Method not allowed.");

/** The integration routes, or null when the path is someone else's. */
export const handleIntegrationsRoute = async (request: Request, env: RouteEnv): Promise<Response | null> => {
  const path = new URL(request.url).pathname;
  const method = request.method;
  switch (path) {
    case "/api/native-integrations/catalog":
      if (method !== "GET") return methodNotAllowed();
      try {
        return json({ integrations: await listIntegrationCatalog(env) });
      } catch (error) {
        return failError(error);
      }
    case "/api/native-integrations/actions":
      return method === "GET" ? await actions(request, env) : methodNotAllowed();
    case "/api/native-integrations/connections":
      return method === "GET" ? await ownerCall(request, env, "integrations.connections", () => ({})) : methodNotAllowed();
    case "/api/native-integrations/status":
      return method === "GET"
        ? await ownerCall(request, env, "integrations.status", (_body, url) => ({
            id: url.searchParams.get("id") ?? "",
          }))
        : methodNotAllowed();
    case "/api/native-integrations/connect-link":
      return method === "POST"
        ? await ownerCall(request, env, "integrations.connectLink", (body) => ({ id: body?.id }))
        : methodNotAllowed();
    case "/api/native-integrations/run":
      return method === "POST" ? await run(request, env) : methodNotAllowed();
    case "/api/admin/native-integrations/upsert":
      return method === "POST" ? await adminUpsert(request, env) : methodNotAllowed();
    case "/api/native-oauth/providers": {
      if (method !== "GET") return methodNotAllowed();
      const auth = await authenticate(request, env);
      return auth.ok ? json(listNativeOAuthProviders(env)) : auth.response;
    }
    case "/api/native-oauth/token":
      return method === "POST" ? await nativeOAuthToken(request, env) : methodNotAllowed();
    case "/api/x/connect-url":
      return method === "GET" ? await ownerCall(request, env, "x.connectUrl", () => ({})) : methodNotAllowed();
    case "/api/x/connections":
      return method === "GET" ? await ownerCall(request, env, "x.connections", () => ({})) : methodNotAllowed();
    case "/api/x/request":
      return method === "POST" ? await xRequest(request, env) : methodNotAllowed();
    case X_OAUTH_CALLBACK_PATH:
      return method === "GET" ? await xCallback(request, env) : methodNotAllowed();
    default:
      return null;
  }
};
