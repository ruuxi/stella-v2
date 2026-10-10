/**
 * The Worker half of the backend client protocol: verify the caller, then
 * hand owner-scoped work to the owner's object and run global work here.
 *
 *   POST /api/rpc/<name>   → `OwnerGate.ownerRpc` or a global handler
 *   GET  /owners/me/live   → the owner object's `/live` socket
 *
 * The Worker runs at the caller's edge, so the first request for an owner
 * creates that owner's object near the user (see the placement note on
 * `OwnerGate`).
 */

import {
  LIVE_CLOSE,
  LIVE_PATH,
  LIVE_SUBPROTOCOL,
  LIVE_TOKEN_SUBPROTOCOL_PREFIX,
  RPC_PATH_PREFIX,
  rpcErrorStatus,
  type RpcResponse,
} from "@stella/contracts/backend/protocol";
import { stripStellaHeaders } from "../conversation-hub.js";
import {
  HEADER_ANONYMOUS,
  HEADER_IDENTITY_LEVEL,
  HEADER_OWNER,
  HEADER_SESSION,
  HEADER_SUBJECT,
  HEADER_TOKEN_EXP,
  HEADER_TOKEN_IAT,
} from "../conversation-types.js";
import { readJsonObject } from "../http/body.js";
import { requireCaller, verifyCaller } from "../http/caller.js";
import { ownerRegistry } from "./domains.js";
import { RpcError, toBackendError } from "./errors.js";
import type { OwnerRegistry } from "./registry.js";

const MAX_RPC_BODY_BYTES = 1024 * 1024;

type RouteEnv = Pick<Cloudflare.Env, "OWNER_GATES" | "CLOUD_BUILDER_PUBLIC_URL">;

const rpcJson = (body: RpcResponse): Response =>
  Response.json(body, {
    status: body.ok ? 200 : rpcErrorStatus(body.error.code),
    headers: { "cache-control": "no-store" },
  });

const readArgs = async (request: Request, maxBytes = MAX_RPC_BODY_BYTES): Promise<unknown> => {
  const body = await readJsonObject(request, maxBytes, { allowEmpty: true });
  // The RPC envelope has no 413: an oversized body is a BAD_REQUEST like any other.
  if (!body.ok) throw new RpcError("BAD_REQUEST", body.error);
  return body.value.args ?? {};
};

export const handleRpc = async (
  request: Request,
  env: RouteEnv,
  registry: OwnerRegistry = ownerRegistry,
): Promise<Response> => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const url = new URL(request.url);
  let name: string;
  try {
    name = decodeURIComponent(url.pathname.slice(RPC_PATH_PREFIX.length));
  } catch {
    return rpcJson({ ok: false, error: toBackendError(new RpcError("BAD_REQUEST", "Bad function name.")) });
  }
  const def = registry.calls.get(name);
  if (!def) {
    return rpcJson({ ok: false, error: toBackendError(new RpcError("NOT_FOUND", `Unknown function ${name}.`)) });
  }
  const verified = await requireCaller(request, env, { allowAnonymous: true });
  if (!verified.ok) return rpcJson({ ok: false, error: toBackendError(verified.error) });
  const { caller } = verified;
  let args: unknown;
  try {
    args = await readArgs(request, def.scope === "owner" ? def.maxBodyBytes : undefined);
  } catch (error) {
    return rpcJson({ ok: false, error: toBackendError(error) });
  }
  if (def.scope === "owner") {
    const response = await env.OWNER_GATES.getByName(caller.ownerId).ownerRpc({ name, args, caller });
    return rpcJson(response);
  }
  try {
    if (def.requireAccount && caller.isAnonymous) {
      throw new RpcError("FORBIDDEN", "Sign in with an account to use this.");
    }
    const value = await def.handler(
      { caller, env: env as unknown as Cloudflare.Env, now: Date.now() },
      def.parse(args) as never,
    );
    return rpcJson({ ok: true, value: value ?? null });
  } catch (error) {
    if (!(error instanceof RpcError)) {
      console.error(JSON.stringify({
        event: "global_call_failed",
        name,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    return rpcJson({ ok: false, error: toBackendError(error) });
  }
};

const liveOffer = (request: Request): { offered: boolean; token: string } => {
  let offered = false;
  let token = "";
  for (const part of (request.headers.get("sec-websocket-protocol") ?? "").split(",")) {
    const value = part.trim();
    if (value === LIVE_SUBPROTOCOL) offered = true;
    else if (value.startsWith(LIVE_TOKEN_SUBPROTOCOL_PREFIX)) {
      token = value.slice(LIVE_TOKEN_SUBPROTOCOL_PREFIX.length);
    }
  }
  return { offered, token };
};

/**
 * Refuse by completing the handshake and closing with a real code: an HTTP
 * error before the 101 reaches the client as 1006, which it cannot tell apart
 * from a network drop.
 */
const refuseLive = (offered: boolean, code: number, reason: string): Response => {
  const pair = new WebSocketPair();
  const server = pair[1]!;
  server.accept();
  try {
    server.close(code, reason);
  } catch {
    // The peer is already gone.
  }
  return new Response(null, {
    status: 101,
    webSocket: pair[0]!,
    headers: offered ? { "sec-websocket-protocol": LIVE_SUBPROTOCOL } : {},
  });
};

export const handleLive = async (request: Request, env: RouteEnv): Promise<Response> => {
  if (request.method !== "GET" || (request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return Response.json({ error: "This endpoint speaks WebSocket only." }, { status: 426 });
  }
  const offer = liveOffer(request);
  if (!offer.offered) return refuseLive(false, LIVE_CLOSE.protocol, "unsupported_client");
  const verified = await verifyCaller(env, offer.token);
  if (!verified.ok) {
    return refuseLive(
      true,
      verified.error.code === "UNAUTHENTICATED" ? LIVE_CLOSE.unauthenticated : LIVE_CLOSE.internal,
      verified.error.code === "UNAUTHENTICATED" ? "unauthenticated" : "unavailable",
    );
  }
  const { caller } = verified;
  const forwarded = new Request("https://owner-gate.internal/live", request);
  stripStellaHeaders(forwarded.headers);
  forwarded.headers.delete("authorization");
  forwarded.headers.set(HEADER_OWNER, caller.ownerId);
  forwarded.headers.set(HEADER_SUBJECT, caller.subject);
  forwarded.headers.set(HEADER_SESSION, caller.sessionId);
  forwarded.headers.set(HEADER_TOKEN_EXP, String(caller.expiresAtMs));
  forwarded.headers.set(HEADER_ANONYMOUS, caller.isAnonymous ? "1" : "0");
  if (caller.identityLevel !== undefined) forwarded.headers.set(HEADER_IDENTITY_LEVEL, String(caller.identityLevel));
  if (caller.issuedAtMs !== undefined) forwarded.headers.set(HEADER_TOKEN_IAT, String(caller.issuedAtMs));
  try {
    // The token has done its job; keep it out of anything downstream logs.
    forwarded.headers.set("sec-websocket-protocol", LIVE_SUBPROTOCOL);
  } catch {
    // Some runtimes guard Sec-* headers; the object is inside the same trust boundary.
  }
  return await env.OWNER_GATES.getByName(caller.ownerId).fetch(forwarded);
};

/** The backend client routes, or null when the path is someone else's. */
export const handleBackendRoute = async (
  request: Request,
  env: RouteEnv,
): Promise<Response | null> => {
  const path = new URL(request.url).pathname;
  if (path.startsWith(RPC_PATH_PREFIX)) return await handleRpc(request, env);
  if (path === LIVE_PATH) return await handleLive(request, env);
  return null;
};
