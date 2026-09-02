import type { HttpRouter } from "convex/server";
import {
  CONVEX_OUTBOX_PATH,
  OUTBOX_EVENT_VERSION,
  OUTBOX_MAX_BATCH,
  type OutboxBatchResult,
  type OutboxEvent,
} from "@stella/contracts/turn-plane/outbox";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { isConnectedOwnerIdAction } from "../auth";
import { constantTimeEqual } from "../lib/crypto_utils";
import { parseOutboxEvent, sortOutboxBatch } from "../lib/outbox_events";

/**
 * `POST /api/cloud/outbox`: the TURN_OUTBOX queue consumer's batch ingest.
 * Service secret only (the cloud-builder's). Every event is applied by its
 * own mutation so one bad event cannot roll back its neighbours, and the
 * reply names each event as applied, duplicate, or permanently rejected.
 */

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const requireBuilderServiceRequest = (
  request: Request,
): Response | null => {
  const expected = process.env.BUILDER_SERVICE_SECRET?.trim() ?? "";
  if (!expected) {
    return json(
      { error: "Cloud builder routes are disabled.", env: "BUILDER_SERVICE_SECRET" },
      503,
    );
  }
  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ??
    "";
  if (!provided || !constantTimeEqual(provided, expected)) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
};

const outbox = httpAction(async (ctx, request) => {
  const denied = requireBuilderServiceRequest(request);
  if (denied) return denied;
  let body: { v?: unknown; events?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (
    !body ||
    typeof body !== "object" ||
    body.v !== OUTBOX_EVENT_VERSION ||
    !Array.isArray(body.events)
  ) {
    return json({ error: "bad_request" }, 400);
  }
  if (body.events.length > OUTBOX_MAX_BATCH) {
    return json({ error: "batch_too_large", max: OUTBOX_MAX_BATCH }, 413);
  }
  const result: OutboxBatchResult = { applied: [], duplicate: [], rejected: [] };
  const events: OutboxEvent[] = [];
  for (const raw of body.events) {
    const parsed = parseOutboxEvent(raw);
    if (parsed.ok) {
      events.push(parsed.event);
    } else {
      result.rejected.push({
        kind: parsed.kind as OutboxEvent["kind"],
        key: parsed.key,
        reason: parsed.reason,
      });
    }
  }
  // Account status is an auth-component read an action must do; only a
  // hosted-browser wait needs it (anonymous owners may not hand off a browser).
  const connectedByOwner = new Map<string, boolean>();
  for (const event of sortOutboxBatch(events)) {
    let connectedAccount: boolean | undefined;
    if (
      event.kind === "turn.event" &&
      event.eventKind === "waiting_for_user" &&
      !event.terminal
    ) {
      let known = connectedByOwner.get(event.ownerId);
      if (known === undefined) {
        known = await isConnectedOwnerIdAction(ctx, event.ownerId);
        connectedByOwner.set(event.ownerId, known);
      }
      connectedAccount = known;
    }
    const outcome = await ctx.runMutation(
      internal.cloud_outbox.applyOutboxEventInternal,
      {
        event,
        ...(connectedAccount !== undefined ? { connectedAccount } : {}),
        now: Date.now(),
      },
    );
    if (outcome.status === "applied") result.applied.push(event.key);
    else if (outcome.status === "duplicate") result.duplicate.push(event.key);
    else {
      result.rejected.push({
        kind: event.kind,
        key: event.key,
        reason: outcome.reason as OutboxBatchResult["rejected"][number]["reason"],
      });
    }
  }
  return json(result);
});

export const registerOutboxRoutes = (http: HttpRouter) => {
  http.route({ path: CONVEX_OUTBOX_PATH, method: "POST", handler: outbox });
};
