// Backends for the cloud orchestrator's memory-document registry and Schedule
// tool. Sandboxes never reach the scheduling route: the control-plane audience
// never leaves the DO, and schedules are account-wide state. The owner is the
// capability's subject; a caller-supplied owner id is ignored.

import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { normalizeScheduleInput } from "../cloud_schedule";
import { authorizeControlPlaneRequest } from "../lib/capability_verify";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const serviceAuthorized = (request: Request): boolean => {
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );
};

const errorMessage = (error: unknown): string => {
  if (error instanceof ConvexError) {
    const data = error.data;
    if (
      data &&
      typeof data === "object" &&
      typeof (data as { message?: unknown }).message === "string"
    ) {
      return (data as { message: string }).message;
    }
    return String(data);
  }
  return error instanceof Error ? error.message : String(error);
};

const errorCode = (error: unknown): string | undefined => {
  if (!(error instanceof ConvexError)) return undefined;
  const data = error.data;
  return data &&
    typeof data === "object" &&
    typeof (data as { code?: unknown }).code === "string"
    ? (data as { code: string }).code
    : undefined;
};

const MEMORY_DOC_NAMES = ["MEMORY.md", "memory_map.md", "profile.md"];
const AGENT_HOME_DOC_MAX_BYTES = 64 * 1024;

export function registerCloudAgentRoutes(http: HttpRouter) {
  // Registers a memory document after the orchestrator DO writes its bytes to
  // R2, so Convex stays the canonical record of what exists (R2 holds only
  // the bytes). Writing the object itself stays with the DO.
  http.route({
    path: "/api/cloud/agent-home/register",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        ownerId?: string;
        ownerGeneration?: string;
        name?: string;
        r2Key?: string;
        sizeBytes?: number;
      };
      const ownerId = body.ownerId?.trim();
      const ownerGeneration = body.ownerGeneration?.trim();
      const name = body.name?.trim();
      const r2Key = body.r2Key?.trim();
      if (!ownerId || !ownerGeneration || !name || !r2Key) {
        return json(
          { error: "ownerId, ownerGeneration, name, r2Key required" },
          400,
        );
      }
      if (!MEMORY_DOC_NAMES.includes(name)) {
        return json(
          { error: `name must be one of ${MEMORY_DOC_NAMES.join(", ")}` },
          400,
        );
      }
      if (
        !Number.isSafeInteger(body.sizeBytes) ||
        body.sizeBytes! < 0 ||
        body.sizeBytes! > AGENT_HOME_DOC_MAX_BYTES
      ) {
        return json(
          {
            error: `sizeBytes must be an integer between 0 and ${AGENT_HOME_DOC_MAX_BYTES}`,
          },
          400,
        );
      }
      try {
        await ctx.runMutation(
          internal.cloud_agent_home.recordDocumentInternal,
          {
            ownerId,
            ownerGeneration,
            name,
            r2Key,
            sizeBytes: body.sizeBytes!,
            now: Date.now(),
          },
        );
      } catch (error) {
        return json({ error: errorMessage(error) }, 400);
      }
      return json({ ok: true });
    }),
  });

  // The Schedule tool's whole surface.
  http.route({
    path: "/api/cloud/schedule",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const auth = await authorizeControlPlaneRequest(ctx, request);
      if (!auth.ok) return auth.response;
      const { ownerId, ownerGeneration } = auth.authority;
      const body = (await request.json().catch(() => ({}))) as {
        action?: string;
        requestId?: string;
        scheduleId?: string;
        prompt?: string;
        description?: string;
        conversationId?: string;
        status?: string;
        schedule?: unknown;
      };
      const action = body.action ?? "list";
      const now = Date.now();
      const requestId = body.requestId?.trim();
      if (
        action !== "list" &&
        (!requestId || !/^[A-Za-z0-9._:-]{8,128}$/u.test(requestId))
      ) {
        return json({ error: "requestId required for schedule changes" }, 400);
      }
      // Every action answers with the owner's current rows, so the Schedule
      // tool renders one receipt shape no matter what it just did.
      const listSchedules = () =>
        ctx.runQuery(internal.cloud_schedule.listOwnerSchedulesInternal, {
          ownerId,
          ownerGeneration,
        });
      try {
        if (action === "create") {
          if (!body.prompt) return json({ error: "prompt required" }, 400);
          const created = await ctx.runMutation(
            internal.cloud_schedule.createScheduleInternal,
            {
              ownerId,
              ownerGeneration,
              requestId: requestId!,
              prompt: body.prompt,
              schedule: normalizeScheduleInput(body.schedule),
              description: body.description,
              conversationId: body.conversationId,
              now,
            },
          );
          const receipt = JSON.parse(created.resultJson) as Record<
            string,
            unknown
          >;
          return json({
            ...receipt,
            replayed: created.replayed,
            schedules: await listSchedules(),
          });
        }
        if (action === "update") {
          if (!body.scheduleId)
            return json({ error: "scheduleId required" }, 400);
          const updated = await ctx.runMutation(
            internal.cloud_schedule.updateScheduleInternal,
            {
              ownerId,
              ownerGeneration,
              requestId: requestId!,
              scheduleId: body.scheduleId,
              prompt: body.prompt,
              schedule:
                body.schedule === undefined
                  ? undefined
                  : normalizeScheduleInput(body.schedule),
              description: body.description,
              status: body.status,
              now,
            },
          );
          const receipt = JSON.parse(updated.resultJson) as Record<
            string,
            unknown
          >;
          return json({
            ...receipt,
            replayed: updated.replayed,
            schedules: await listSchedules(),
          });
        }
        if (action === "remove") {
          if (!body.scheduleId)
            return json({ error: "scheduleId required" }, 400);
          const result = await ctx.runMutation(
            internal.cloud_schedule.removeScheduleInternal,
            {
              ownerId,
              ownerGeneration,
              requestId: requestId!,
              scheduleId: body.scheduleId,
              now,
            },
          );
          const receipt = JSON.parse(result.resultJson) as Record<
            string,
            unknown
          >;
          return json({
            ...receipt,
            replayed: result.replayed,
            schedules: await listSchedules(),
          });
        }
        if (action !== "list") {
          return json(
            { error: 'action must be "list", "create", "update", or "remove"' },
            400,
          );
        }
        return json({ ok: true, schedules: await listSchedules() });
      } catch (error) {
        // The Schedule tool relays this text to the model verbatim, so the
        // readable ConvexError message has to survive the HTTP hop.
        return json(
          { error: errorMessage(error) },
          errorCode(error) === "IDEMPOTENCY_CONFLICT" ? 409 : 400,
        );
      }
    }),
  });
}
