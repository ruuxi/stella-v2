// Backends for the cloud orchestrator's memory and scheduling tools
// (contract C8). The orchestrator DO holds no database, so its Recall and
// Schedule tools call these routes with the builder service secret — the same
// trust boundary as /api/cloud/spawn. Sandboxes never reach these routes:
// a per-turn token is not accepted here, because memory and schedules are
// account-wide state, not turn-scoped state.

import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { normalizeScheduleInput } from "../cloud_schedule";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const serviceAuthorized = (request: Request): boolean => {
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );
};

const errorMessage = (error: unknown): string => {
  if (error instanceof ConvexError) return String(error.data);
  return error instanceof Error ? error.message : String(error);
};

const MEMORY_DOC_NAMES = ["MEMORY.md", "memory_map.md", "profile.md"];

export function registerCloudAgentRoutes(http: HttpRouter) {
  // Recall's conversation half. The memory DOCUMENTS themselves live in R2
  // under the orchestrator DO's AGENT_HOME binding (contract C5) — Convex has
  // no credential for that bucket, so `documents` is returned empty here and
  // the DO merges what it read from R2 before handing the tool result to the
  // model. `registeredDocuments` reports what Convex knows exists, which is
  // how a caller can tell "no memory yet" from "memory the DO failed to read".
  http.route({
    path: "/api/cloud/recall",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        ownerId?: string;
        query?: string;
        /** The tool's search terms, unjoined — see below. */
        terms?: unknown;
        limit?: number;
      };
      const ownerId = body.ownerId?.trim();
      if (!ownerId) return json({ error: "ownerId required" }, 400);
      const query = (body.query ?? "").trim();
      // Terms are forwarded whole rather than reconstructed by splitting
      // `query`: "pivot table broken" is one term the model chose, and a
      // server that only ever sees the joined string cannot tell it from
      // three unrelated words competing for the same cap.
      const terms = Array.isArray(body.terms)
        ? body.terms
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [];
      const now = Date.now();
      const [matches, registeredDocuments] = await Promise.all([
        query || terms.length > 0
          ? ctx.runQuery(
              internal.cloud_agent_home.searchOwnerMessagesInternal,
              {
                ownerId,
                ...(query ? { query } : {}),
                ...(terms.length > 0 ? { terms } : {}),
                limit: body.limit,
                now,
              },
            )
          : Promise.resolve([]),
        ctx.runQuery(internal.cloud_agent_home.listOwnerDocumentsInternal, {
          ownerId,
        }),
      ]);
      return json({ documents: [], registeredDocuments, matches });
    }),
  });

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
        name?: string;
        r2Key?: string;
        sizeBytes?: number;
      };
      const ownerId = body.ownerId?.trim();
      const name = body.name?.trim();
      const r2Key = body.r2Key?.trim();
      if (!ownerId || !name || !r2Key) {
        return json({ error: "ownerId, name, r2Key required" }, 400);
      }
      if (!MEMORY_DOC_NAMES.includes(name)) {
        return json(
          { error: `name must be one of ${MEMORY_DOC_NAMES.join(", ")}` },
          400,
        );
      }
      try {
        await ctx.runMutation(
          internal.cloud_agent_home.recordDocumentInternal,
          {
            ownerId,
            name,
            r2Key,
            sizeBytes: Math.max(0, Math.floor(body.sizeBytes ?? 0)),
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
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        ownerId?: string;
        action?: string;
        scheduleId?: string;
        prompt?: string;
        description?: string;
        conversationId?: string;
        status?: string;
        schedule?: unknown;
      };
      const ownerId = body.ownerId?.trim();
      if (!ownerId) return json({ error: "ownerId required" }, 400);
      const action = body.action ?? "list";
      const now = Date.now();
      // Every action answers with the owner's current rows, so the Schedule
      // tool renders one receipt shape no matter what it just did.
      const listSchedules = () =>
        ctx.runQuery(internal.cloud_schedule.listOwnerSchedulesInternal, {
          ownerId,
        });
      try {
        if (action === "create") {
          if (!body.prompt) return json({ error: "prompt required" }, 400);
          const created = await ctx.runMutation(
            internal.cloud_schedule.createScheduleInternal,
            {
              ownerId,
              prompt: body.prompt,
              schedule: normalizeScheduleInput(body.schedule),
              description: body.description,
              conversationId: body.conversationId,
              now,
            },
          );
          return json({
            ok: true,
            schedule: created,
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
          return json({
            ok: true,
            schedule: updated,
            schedules: await listSchedules(),
          });
        }
        if (action === "remove") {
          if (!body.scheduleId)
            return json({ error: "scheduleId required" }, 400);
          const result = await ctx.runMutation(
            internal.cloud_schedule.removeScheduleInternal,
            { ownerId, scheduleId: body.scheduleId, now },
          );
          return json({
            ok: result.removed,
            removed: result.removed,
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
        return json({ error: errorMessage(error) }, 400);
      }
    }),
  });
}
