import { makeFunctionReference, type HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "../_generated/server";
import {
  MEMORY_POLICY_APPLY_PATH,
  parseMemoryPolicyChange,
} from "@stella/contracts/turn-plane/memory-policy";
import { synchronizeMemoryPolicyChange } from "../lib/memory_policy_change";
import { internal } from "../_generated/api";
import {
  authenticateControlPlaneRequest,
  authorizeControlPlaneRequest,
} from "../lib/capability_verify";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const serviceAuthorized = (request: Request): boolean => {
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );
};

const errorPayload = (error: unknown): { error: unknown; code?: string } => {
  if (error instanceof ConvexError) {
    const data = error.data;
    if (typeof data === "object" && data !== null && "code" in data) {
      return { error: data, code: String((data as { code: unknown }).code) };
    }
    return { error: String(data) };
  }
  return { error: "Cloud home request failed." };
};

const requiredOwner = (
  body: Record<string, unknown>,
): { ownerId: string; ownerGeneration: string } | null => {
  const ownerId = typeof body.ownerId === "string" ? body.ownerId.trim() : "";
  const ownerGeneration =
    typeof body.ownerGeneration === "string" ? body.ownerGeneration.trim() : "";
  return ownerId && ownerGeneration ? { ownerId, ownerGeneration } : null;
};

const memoryBeginRef = makeFunctionReference<"mutation", any, any>(
  "cloud_memory:beginWriteInternal",
);
const cloudHomeAccessRef = makeFunctionReference<"query", any, any>(
  "cloud_memory:getOwnerCloudHomeAccessInternal",
);
const memoryCommitRef = makeFunctionReference<"mutation", any, any>(
  "cloud_memory:commitWriteInternal",
);
const memoryHeadRef = makeFunctionReference<"query", any, any>(
  "cloud_memory:getOwnerDocumentHeadInternal",
);
const memoryCatalogRef = makeFunctionReference<"query", any, any>(
  "cloud_memory:listOwnerDocumentHeadsInternal",
);
const memoryPreferenceRef = makeFunctionReference<"query", any, any>(
  "cloud_memory:getOwnerMemoryPreferenceInternal",
);
const memoryEpochAssertRef = makeFunctionReference<"query", any, any>(
  "cloud_memory_lifecycle:assertMemoryEpochInternal",
);
const memoryWipeStatusRef = makeFunctionReference<"query", any, any>(
  "cloud_memory_lifecycle:getMemoryWipeStatusInternal",
);
const memoryReimportAuthorizeRef = makeFunctionReference<"mutation", any, any>(
  "cloud_memory_lifecycle:authorizeMemoryReimportInternal",
);
const skillBeginRef = makeFunctionReference<"mutation", any, any>(
  "cloud_skills:beginSkillWriteInternal",
);
const skillCommitRef = makeFunctionReference<"mutation", any, any>(
  "cloud_skills:commitSkillWriteInternal",
);
const skillCatalogRef = makeFunctionReference<"query", any, any>(
  "cloud_skills:listMirroredSkillsInternal",
);
type CloudHomeRouteAuth = "authenticate" | "authorize";

type CloudHomeRoute = {
  path: string;
  kind: "query" | "mutation";
  /**
   * Capability check for a turn-authorized caller. `authorize` also verifies
   * the owner's lifecycle before the handler runs. `authenticate` skips that
   * round trip for read queries whose handler validates the capability's
   * generation and owner lifecycle in the SAME database snapshot as the data.
   */
  auth: CloudHomeRouteAuth;
  ref: ReturnType<typeof makeFunctionReference>;
};

const failureResponse = (error: unknown): Response => {
  const payload = errorPayload(error);
  const status =
    payload.code?.includes("CONFLICT") ||
    payload.code === "CLOUD_MEMORY_WIPE_ACTIVE" ||
    payload.code === "CLOUD_MEMORY_REIMPORT_CONFIRMATION_REQUIRED" ||
    payload.code === "CLOUD_MEMORY_REIMPORT_NOT_REQUIRED"
      ? 409
      : payload.code?.includes("STALE")
        ? 412
        : 400;
  return json(payload, status);
};

/**
 * The owner a cloud-home request acts for: the capability subject for a
 * turn-authorized caller, or the owner named in the body for the service.
 */
const resolveRequestOwner = async (
  ctx: Parameters<typeof authorizeControlPlaneRequest>[0],
  request: Request,
  auth: CloudHomeRouteAuth,
): Promise<
  | {
      ok: true;
      owner: { ownerId: string; ownerGeneration: string };
      body: Record<string, unknown>;
    }
  | { ok: false; response: Response }
> => {
  let capabilityOwner: { ownerId: string; ownerGeneration: string } | null =
    null;
  if (!serviceAuthorized(request)) {
    const verified =
      auth === "authenticate"
        ? await authenticateControlPlaneRequest(request)
        : await authorizeControlPlaneRequest(ctx, request);
    if (!verified.ok) return verified;
    capabilityOwner = {
      ownerId: verified.authority.ownerId,
      ownerGeneration: verified.authority.ownerGeneration,
    };
  }
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) {
    return { ok: false, response: json({ error: "JSON body required" }, 400) };
  }
  const owner = capabilityOwner ?? requiredOwner(body);
  if (!owner) {
    return {
      ok: false,
      response: json({ error: "ownerId and ownerGeneration required" }, 400),
    };
  }
  return { ok: true, owner, body };
};

const ROUTES: CloudHomeRoute[] = [
  {
    path: "/api/cloud/home/memory/begin",
    kind: "mutation",
    auth: "authorize",
    ref: memoryBeginRef,
  },
  {
    path: "/api/cloud/home/memory/commit",
    kind: "mutation",
    auth: "authorize",
    ref: memoryCommitRef,
  },
  {
    path: "/api/cloud/home/memory/head",
    kind: "query",
    auth: "authorize",
    ref: memoryHeadRef,
  },
  {
    path: "/api/cloud/home/memory/catalog",
    kind: "query",
    auth: "authorize",
    ref: memoryCatalogRef,
  },
  {
    path: "/api/cloud/home/memory/preference",
    kind: "query",
    auth: "authenticate",
    ref: memoryPreferenceRef,
  },
  {
    path: "/api/cloud/home/memory/epoch/assert",
    kind: "query",
    auth: "authorize",
    ref: memoryEpochAssertRef,
  },
  {
    path: "/api/cloud/home/memory/wipe/status",
    kind: "query",
    auth: "authorize",
    ref: memoryWipeStatusRef,
  },
  {
    path: "/api/cloud/home/memory/reimport/authorize",
    kind: "mutation",
    auth: "authorize",
    ref: memoryReimportAuthorizeRef,
  },
  {
    path: "/api/cloud/home/skills/begin",
    kind: "mutation",
    auth: "authorize",
    ref: skillBeginRef,
  },
  {
    path: "/api/cloud/home/skills/commit",
    kind: "mutation",
    auth: "authorize",
    ref: skillCommitRef,
  },
  {
    path: "/api/cloud/home/skills/catalog",
    kind: "query",
    auth: "authenticate",
    ref: skillCatalogRef,
  },
];

/**
 * Private metadata/control-plane endpoints for the cloud-builder Worker. Raw
 * R2 keys are returned only across this boundary. Browser, desktop, and
 * mobile clients use JWT-authenticated Worker routes instead.
 *
 * Two callers: the Worker's user-facing cloud-home routes present the
 * service secret and name the owner in the body; a running turn's tools
 * (OrchestratorSession/BuildSession) present the control-plane turn
 * capability, whose subject and generation ARE the owner — anything the body
 * says about the owner is ignored in that case.
 */
export function registerCloudHomeRoutes(http: HttpRouter) {
  http.route({
    path: MEMORY_POLICY_APPLY_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const change = parseMemoryPolicyChange(
        await request.json().catch(() => null),
      );
      if (!change) return json({ error: "Invalid memory policy change." }, 400);
      try {
        if (change.kind === "preference") {
          await ctx.runMutation(
            internal.cloud_memory.setOwnerMemoryEnabledInternal,
            {
              ownerId: change.ownerId,
              expectedOwnerGeneration: change.expectedOwnerGeneration,
              requestId: change.requestId,
              expectedRevision: change.expectedRevision,
              memoryEnabled: change.memoryEnabled,
            },
          );
        } else {
          await ctx.runMutation(
            internal.cloud_memory_lifecycle.startMemoryWipeInternal,
            {
              ownerId: change.ownerId,
              ownerGeneration: change.expectedOwnerGeneration,
              expectedMemoryEpoch: change.expectedMemoryEpoch,
              requestId: change.requestId,
            },
          );
        }
        return json({ ok: true });
      } catch (error) {
        // Only a known application refusal is definitive. Infrastructure
        // failure must leave the owner's durable intent available for retry.
        return json(
          errorPayload(error),
          error instanceof ConvexError ? 400 : 503,
        );
      }
    }),
  });
  http.route({
    path: "/api/cloud/home/access",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const body = (await request.json().catch(() => null)) as {
        ownerId?: unknown;
      } | null;
      const ownerId =
        typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
      if (!ownerId) return json({ error: "ownerId required" }, 400);
      try {
        return json(
          await ctx.runQuery(cloudHomeAccessRef as never, { ownerId } as never),
        );
      } catch (error) {
        return json(errorPayload(error), 409);
      }
    }),
  });
  http.route({
    path: "/api/cloud/home/memory/wipe/start",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const resolved = await resolveRequestOwner(ctx, request, "authorize");
      if (!resolved.ok) return resolved.response;
      const { owner, body } = resolved;
      try {
        const change = parseMemoryPolicyChange({
          ...body,
          ...owner,
          kind: "wipe",
          expectedOwnerGeneration: owner.ownerGeneration,
        });
        if (!change)
          return json({ error: "Invalid memory wipe request." }, 400);
        await synchronizeMemoryPolicyChange(change);
        return json(
          await ctx.runQuery(
            internal.cloud_memory_lifecycle.getMemoryWipeStatusInternal,
            owner,
          ),
        );
      } catch (error) {
        return failureResponse(error);
      }
    }),
  });
  for (const route of ROUTES) {
    http.route({
      path: route.path,
      method: "POST",
      handler: httpAction(async (ctx, request) => {
        const resolved = await resolveRequestOwner(ctx, request, route.auth);
        if (!resolved.ok) return resolved.response;
        const { owner, body } = resolved;
        try {
          // Convex rejects undeclared arguments. Cloud Home mutations use an
          // explicit server timestamp, while the read-only query contracts do
          // not declare `now`; shape each call to its exact validator.
          const args =
            route.kind === "query"
              ? { ...body, ...owner }
              : { ...body, ...owner, now: Date.now() };
          const result =
            route.kind === "query"
              ? await ctx.runQuery(route.ref as never, args as never)
              : await ctx.runMutation(route.ref as never, args as never);
          return json(result);
        } catch (error) {
          return failureResponse(error);
        }
      }),
    });
  }
}
