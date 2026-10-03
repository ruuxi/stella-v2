import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { CONVEX_OWNER_RESET_PATH } from "@stella/contracts/backend/account";
import { CONVEX_OWNER_SNAPSHOT_PATH } from "@stella/contracts/turn-plane/owner-snapshot";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { resolveOwnerAccountAction } from "../auth";
import { constantTimeEqual } from "../lib/crypto_utils";

/**
 * The cloud-builder owner object's routes, taking that worker's
 * `BUILDER_SERVICE_SECRET`: the owner snapshot
 * (`@stella/contracts/turn-plane/owner-snapshot`) and the start of an
 * account reset.
 */

const BUILDER_SERVICE_SECRET_ENV = "BUILDER_SERVICE_SECRET";
const MAX_ID_LENGTH = 512;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Bearer check with a constant-time compare; 503 when the secret is unset. */
const requireBuilderServiceRequest = (request: Request): Response | null => {
  const expected = process.env[BUILDER_SERVICE_SECRET_ENV]?.trim() ?? "";
  if (!expected) {
    return json(
      {
        error: "Cloud builder routes are disabled.",
        env: BUILDER_SERVICE_SECRET_ENV,
      },
      503,
    );
  }
  const provided =
    request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim() ?? "";
  if (!provided || !constantTimeEqual(provided, expected)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
};

const readJsonObject = async (
  request: Request,
): Promise<Record<string, unknown> | null> => {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const isId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= MAX_ID_LENGTH;

const convexErrorCode = (error: unknown): string | null => {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as { code?: unknown } | string | undefined;
  return typeof data === "object" && data && typeof data.code === "string"
    ? data.code
    : null;
};

// ---------------------------------------------------------------------------
// GET /api/gateway/owner-snapshot?ownerId=
// ---------------------------------------------------------------------------

const ownerSnapshot = httpAction(async (ctx, request) => {
  const denied = requireBuilderServiceRequest(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const ownerId = url.searchParams.get("ownerId")?.trim() ?? "";
  if (!isId(ownerId)) return json({ error: "bad_request" }, 400);
  const account = await resolveOwnerAccountAction(ctx, ownerId);
  if (!account) return json({ error: "owner_unknown" }, 404);
  try {
    const snapshot = await ctx.runAction(
      internal.owner_snapshot.getOwnerSnapshotInternal,
      { ownerId },
    );
    return json(snapshot);
  } catch (error) {
    switch (convexErrorCode(error)) {
      case "OWNER_DATA_PURGE_ACTIVE":
      case "OWNERSHIP_MIGRATED":
        return json({ error: "owner_unavailable" }, 404);
      default:
        throw error;
    }
  }
});

// ---------------------------------------------------------------------------
// POST /api/cloud/owners/reset  { ownerId }
// ---------------------------------------------------------------------------

/**
 * The owner object's `account.reset`. Opens the reset purge (a new blocking
 * owner generation) and runs it before answering, so the client's live
 * queries resume only after the purge fence lifts. The purge job's own retry
 * cron resumes it if this run dies.
 */
const ownerReset = httpAction(async (ctx, request) => {
  const denied = requireBuilderServiceRequest(request);
  if (denied) return denied;
  const body = await readJsonObject(request);
  if (!body || !isId(body.ownerId)) return json({ error: "bad_request" }, 400);
  const ownerId = body.ownerId;
  let lifecycle: { operationId: string; generation: string };
  try {
    lifecycle = await ctx.runMutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId,
        operationId: crypto.randomUUID(),
        mode: "reset",
        now: Date.now(),
      },
    );
  } catch (error) {
    if (convexErrorCode(error) === "OWNER_DATA_PURGE_ACTIVE") {
      return json({ error: "owner_deleting" }, 409);
    }
    throw error;
  }
  await ctx.runAction(internal.reset.resumeOwnerResetInternal, {
    ownerId,
    operationId: lifecycle.operationId,
    generation: lifecycle.generation,
  });
  return json({ ok: true }, 200);
});

export const registerGatewayRoutes = (http: HttpRouter) => {
  http.route({
    path: CONVEX_OWNER_SNAPSHOT_PATH,
    method: "GET",
    handler: ownerSnapshot,
  });
  http.route({
    path: CONVEX_OWNER_RESET_PATH,
    method: "POST",
    handler: ownerReset,
  });
};
