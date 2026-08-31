import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const serviceAuthorized = (request: Request): boolean => {
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );
};

const requiredString = (
  body: Record<string, unknown>,
  field: string,
  maxLength = 256,
): string | null => {
  const value = typeof body[field] === "string" ? body[field].trim() : "";
  return value && value.length <= maxLength ? value : null;
};

type SocketIdentity = {
  ownerId: string;
  deviceId: string;
  presenceSessionId: string;
  connectionId: string;
};

async function parseSocketIdentity(
  request: Request,
  requireAuthExpiry: true,
): Promise<(SocketIdentity & { authExpiresAtMs: number }) | null>;
async function parseSocketIdentity(
  request: Request,
  requireAuthExpiry: false,
): Promise<SocketIdentity | null>;
async function parseSocketIdentity(
  request: Request,
  requireAuthExpiry: boolean,
): Promise<(SocketIdentity & { authExpiresAtMs?: number }) | null> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 4096) return null;
  let body: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    body = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const ownerId = requiredString(body, "ownerId", 512);
  const deviceId = requiredString(body, "deviceId");
  const presenceSessionId = requiredString(body, "presenceSessionId", 128);
  const connectionId = requiredString(body, "connectionId", 128);
  const authExpiresAtMs = Number(body.authExpiresAtMs);
  if (!ownerId || !deviceId || !presenceSessionId || !connectionId) return null;
  if (requireAuthExpiry && !Number.isSafeInteger(authExpiresAtMs)) return null;
  return {
    ownerId,
    deviceId,
    presenceSessionId,
    connectionId,
    ...(requireAuthExpiry ? { authExpiresAtMs } : {}),
  };
}

export function registerExecutionPresenceRoutes(http: HttpRouter) {
  http.route({
    path: "/api/execution-placement/presence/socket/check",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const identity = await parseSocketIdentity(request, true);
      if (!identity) return json({ error: "Malformed socket identity" }, 400);
      const current = await ctx.runMutation(
        internal.execution_placement.confirmExecutionPresenceSocketInternal,
        identity,
      );
      return json({ current });
    }),
  });

  http.route({
    path: "/api/execution-placement/presence/socket/disconnect",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const identity = await parseSocketIdentity(request, false);
      if (!identity) return json({ error: "Malformed socket identity" }, 400);
      const result = await ctx.runMutation(
        internal.execution_placement.disconnectExecutionPresenceSocketInternal,
        {
          ...identity,
          now: Date.now(),
        },
      );
      return json(result);
    }),
  });
}
