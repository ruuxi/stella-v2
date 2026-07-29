import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { enforceActionRateLimit } from "../lib/rate_limits";
import { executeWebSearch } from "../tools/backend";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const serviceAuthorized = (request: Request): boolean => {
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );
};

const hashToken = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

type TurnTokenRow = {
  ownerId: string;
  turnId: string;
  agentType: string;
  expiresAt: number;
};

// The sandbox/DO executor's only credential: an opaque per-turn token whose
// hash Convex stored at dispatch. Callers present it as `x-stella-turn-token`.
const verifyTurnToken = async (
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  request: Request,
): Promise<TurnTokenRow | null> => {
  const token = request.headers.get("x-stella-turn-token")?.trim();
  if (!token) return null;
  const row = await ctx.runQuery(
    internal.cloud_apps.getTurnTokenByHashInternal,
    { tokenHash: await hashToken(token), now: Date.now() },
  );
  return (row as TurnTokenRow | null) ?? null;
};

export function registerCloudAppRoutes(http: HttpRouter) {
  http.route({
    path: "/api/cloud/interior-active-route",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const stableRouteId = new URL(request.url).searchParams
        .get("stableRouteId")
        ?.trim();
      if (
        !stableRouteId ||
        !/^sr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          stableRouteId,
        )
      ) {
        return json({ error: "stableRouteId required" }, 400);
      }
      const route = await ctx.runQuery(
        internal.cloud_deployments.getInteriorRouteByStableRouteIdInternal,
        { stableRouteId },
      );
      return route
        ? json(route)
        : json({ error: "Stella interior route not found." }, 404);
    }),
  });

  http.route({
    path: "/api/cloud/events",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const service = serviceAuthorized(request);
      const token = service ? null : await verifyTurnToken(ctx, request);
      if (!service && !token) return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        turnId: string;
        sessionId: string;
        seq?: number | "auto";
        kind: string;
        payload: unknown;
        terminal?: boolean;
      };
      // A turn token only speaks for its own turn.
      if (token && token.turnId !== body.turnId) {
        return json({ error: "Forbidden" }, 403);
      }
      const autoSeq = body.seq === undefined || body.seq === "auto";
      const result = await ctx.runMutation(
        internal.cloud_apps.appendEventInternal,
        {
          turnId: body.turnId,
          sessionId: body.sessionId,
          seq: autoSeq ? 0 : (body.seq as number),
          autoSeq,
          kind: body.kind,
          payloadJson: JSON.stringify(body.payload ?? {}),
          terminal: body.terminal === true,
          now: Date.now(),
        },
      );
      return json(result);
    }),
  });

  // A spawned agent's THREAD transcript, for `send_input` continuations.
  //
  // Narrowed with the DO-resident transcript migration: `conversationId` here
  // names a `cloud_agent_threads` row, never a user conversation. User
  // conversation history is not readable over HTTP at all any more — it lives
  // in the OrchestratorSession DO, which is the only thing that reads it.
  // Service-secret only, as before: the fetching DO holds no turn token yet,
  // and history is never handed to a sandbox directly.
  http.route({
    path: "/api/cloud/context",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      const threadId = url.searchParams.get("conversationId")?.trim();
      if (!threadId) return json({ error: "conversationId required" }, 400);
      try {
        const messages = await ctx.runQuery(
          internal.cloud_apps.listThreadMessagesInternal,
          {
            threadId,
            excludeTurnId: url.searchParams.get("excludeTurnId") ?? undefined,
          },
        );
        return json({ messages });
      } catch {
        // An id that is not a thread is simply not here. Saying which is which
        // would confirm the existence of conversations to a caller that only
        // has the service secret's thread audience.
        return json({ error: "Unknown agent thread." }, 404);
      }
    }),
  });

  // The write half of the same surface. The check that a turn token can only
  // ever write its OWN thread lives in `appendThreadMessagesInternal`; it is
  // half of the guarantee that a hijacked sandbox cannot forge history the
  // orchestrator would reload as genuine context. The other half is the
  // `x-stella-owner` compare on the DO's journal-append route.
  http.route({
    path: "/api/cloud/messages",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const service = serviceAuthorized(request);
      const token = service ? null : await verifyTurnToken(ctx, request);
      if (!service && !token) return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        conversationId: string;
        turnId: string;
        messages: Array<{ role: string; payloadJson: string }>;
      };
      if (token && token.turnId !== body.turnId) {
        return json({ error: "Forbidden" }, 403);
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return json({ error: "messages required" }, 400);
      }
      if (body.messages.length > 50) {
        return json({ error: "Too many messages in one append." }, 400);
      }
      const result = await ctx.runMutation(
        internal.cloud_apps.appendThreadMessagesInternal,
        {
          threadId: body.conversationId,
          turnId: body.turnId,
          messages: body.messages.map((message) => ({
            role: message.role,
            payloadJson: message.payloadJson,
          })),
          now: Date.now(),
        },
      );
      return json(result);
    }),
  });

  // Who owns a conversation. One call per OrchestratorSession lifetime: a DO
  // that has never been bound asks here rather than adopting whoever connects
  // to it first, which would make a conversation id a bearer token.
  http.route({
    path: "/api/cloud/conversation-owner",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      const conversationId = url.searchParams.get("conversationId")?.trim();
      if (!conversationId)
        return json({ error: "conversationId required" }, 400);
      const owner = await ctx.runQuery(
        internal.cloud_apps.getConversationOwnerInternal,
        { conversationId },
      );
      if (!owner) return json({ error: "Conversation not found." }, 404);
      return json(owner);
    }),
  });

  // The DO's index flush: the sidebar row plus this turn's search excerpts.
  // Fenced on (epoch, lastSeq) inside the mutation, so a retried or reordered
  // flush is dropped as stale rather than moving the row backwards. The reply
  // always carries the row's current (lastSeq, epoch) so a DO that lost track
  // of what it synced converges without a second call.
  http.route({
    path: "/api/cloud/index",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        conversationId?: string;
        ownerId?: string;
        epoch?: number;
        lastSeq?: number;
        updatedAt?: number;
        createdAt?: number;
        title?: string;
        lastPreview?: string;
        lastRole?: string;
        activity?: string;
        excerpts?: Array<{
          turnId?: string;
          seqStart?: number;
          seqEnd?: number;
          text?: string;
          createdAt?: number;
        }>;
        force?: boolean;
      };
      const conversationId = body.conversationId?.trim();
      const ownerId = body.ownerId?.trim();
      if (!conversationId || !ownerId) {
        return json({ error: "conversationId and ownerId required" }, 400);
      }
      if (
        !Number.isFinite(body.epoch) ||
        !Number.isFinite(body.lastSeq) ||
        !Number.isFinite(body.updatedAt)
      ) {
        return json({ error: "epoch, lastSeq, updatedAt required" }, 400);
      }
      const excerpts = (body.excerpts ?? []).flatMap((entry) =>
        entry.turnId && typeof entry.text === "string"
          ? [
              {
                turnId: entry.turnId,
                seqStart: Math.floor(entry.seqStart ?? 0),
                seqEnd: Math.floor(entry.seqEnd ?? 0),
                text: entry.text,
                createdAt: Math.floor(entry.createdAt ?? Date.now()),
              },
            ]
          : [],
      );
      try {
        const result = await ctx.runMutation(
          internal.cloud_apps.upsertConversationIndexInternal,
          {
            conversationId,
            ownerId,
            epoch: Math.floor(body.epoch as number),
            lastSeq: Math.floor(body.lastSeq as number),
            updatedAt: Math.floor(body.updatedAt as number),
            ...(Number.isFinite(body.createdAt)
              ? { createdAt: Math.floor(body.createdAt as number) }
              : {}),
            ...(typeof body.title === "string" ? { title: body.title } : {}),
            ...(typeof body.lastPreview === "string"
              ? { lastPreview: body.lastPreview }
              : {}),
            ...(typeof body.lastRole === "string"
              ? { lastRole: body.lastRole }
              : {}),
            ...(typeof body.activity === "string"
              ? { activity: body.activity }
              : {}),
            ...(excerpts.length > 0 ? { excerpts } : {}),
            ...(body.force === true ? { force: true } : {}),
          },
        );
        return json(result);
      } catch (error) {
        // Over-sized excerpt batches are the only throw here, and they are a
        // caller bug, not a transient failure — say so rather than 500ing.
        return json(
          {
            error:
              error instanceof ConvexError
                ? String(error.data)
                : "Index flush rejected.",
          },
          400,
        );
      }
    }),
  });

  // Spawn/cancel surface for the orchestrator DO's agent tools. Service
  // secret only — spawning is a platform decision, never a sandbox one.
  http.route({
    path: "/api/cloud/spawn",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        action?: "spawn" | "cancel";
        ownerId: string;
        conversationId: string;
        parentTurnId?: string;
        description?: string;
        prompt?: string;
        workspace?: string;
        threadId?: string;
        model?: string;
        execution?: {
          engine: "stella" | "anthropic" | "openai-codex";
          provider: "stella" | "anthropic" | "openai-codex";
          model: string;
          reasoningEffort:
            | "default"
            | "none"
            | "minimal"
            | "low"
            | "medium"
            | "high"
            | "xhigh";
        };
      };
      if (body.action === "cancel") {
        if (!body.threadId) return json({ error: "threadId required" }, 400);
        const control = await ctx.runQuery(
          internal.cloud_apps.getCloudAgentThreadControlInternal,
          {
            ownerId: body.ownerId,
            threadId: body.threadId,
          },
        );
        if (!control) return json({ error: "Thread not found." }, 404);
        if (control.status !== "running") {
          return json({
            ok: true,
            threadId: body.threadId,
            status: control.status,
          });
        }
        if (!control.runningTurnId) {
          return json({ error: "Thread has no active turn." }, 409);
        }
        // This endpoint only resolves the exact active turn. The BuildSession
        // Durable Object owns the terminal decision and sandbox teardown. If
        // dispatch has not reached it yet, /cancel records a durable pending
        // cancellation that is consumed when the turn arrives.
        return json({
          ok: true,
          threadId: body.threadId,
          status: "running",
          turnId: control.runningTurnId,
        });
      }
      if (!body.parentTurnId || !body.prompt || !body.description) {
        return json(
          { error: "description, prompt, parentTurnId required" },
          400,
        );
      }
      const result = await ctx.runMutation(
        internal.cloud_apps.spawnCloudAgentInternal,
        {
          ownerId: body.ownerId,
          conversationId: body.conversationId,
          parentTurnId: body.parentTurnId,
          description: body.description,
          prompt: body.prompt,
          workspace: body.workspace ?? "cloud",
          threadId: body.threadId,
          model: body.model,
          execution: body.execution,
          now: Date.now(),
        },
      );
      return json(result, result.ok ? 200 : 409);
    }),
  });

  http.route({
    path: "/api/cloud/threads/complete",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const service = serviceAuthorized(request);
      const token = service ? null : await verifyTurnToken(ctx, request);
      if (!service && !token) return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        threadId: string;
        turnId?: string;
        status: string;
        resultJson?: string;
        errorMessage?: string;
        wake?: boolean;
      };
      if (token && body.turnId && token.turnId !== body.turnId) {
        return json({ error: "Forbidden" }, 403);
      }
      // A turn token is bound to its own thread inside the mutation (the
      // volunteered-turnId check above is skippable by omitting turnId).
      await ctx.runMutation(internal.cloud_apps.completeAgentThreadInternal, {
        threadId: body.threadId,
        status: body.status,
        resultJson: body.resultJson,
        errorMessage: body.errorMessage,
        wake: body.wake,
        callerTurnId: token?.turnId,
        ...((token?.turnId ?? body.turnId)
          ? { completingTurnId: token?.turnId ?? body.turnId }
          : {}),
        now: Date.now(),
      });
      return json({ ok: true });
    }),
  });

  // Web search for cloud executors (orchestrator DO + sandbox agents). The
  // turn token attributes the search to its owner for rate limiting.
  http.route({
    path: "/api/cloud/web-search",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const service = serviceAuthorized(request);
      const token = service ? null : await verifyTurnToken(ctx, request);
      if (!service && !token) return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        query: string;
        category?: string;
        ownerId?: string;
      };
      const ownerId = token?.ownerId ?? body.ownerId;
      if (!ownerId) return json({ error: "ownerId required" }, 400);
      await enforceActionRateLimit(
        ctx,
        "cloud_web_search",
        ownerId,
        { rate: 30, periodMs: 60_000 },
        "Too many web searches. Wait a moment and try again.",
      );
      const result = await executeWebSearch(ctx, body.query ?? "", {
        ownerId,
        category: body.category,
      });
      return json(result);
    }),
  });

  http.route({
    path: "/api/cloud/builds",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        buildId: string;
        appId: string;
        ownerId: string;
        artifactPrefix: string;
        previewUrl: string;
        metrics: unknown;
        slug: string;
        autoActivate: boolean;
        title?: string;
      };
      await ctx.runMutation(internal.cloud_apps.recordBuildInternal, {
        buildId: body.buildId,
        appId: body.appId,
        ownerId: body.ownerId,
        artifactPrefix: body.artifactPrefix,
        previewUrl: body.previewUrl,
        metricsJson: JSON.stringify(body.metrics),
        slug: body.slug,
        autoActivate: body.autoActivate,
        title: typeof body.title === "string" ? body.title : undefined,
        now: Date.now(),
      });
      return json({ ok: true });
    }),
  });

  // Immutable Stella-interior build candidate callback. Activation remains a
  // signed-in user operation in `cloud_deployments`; the builder may publish
  // bytes and record metadata, but it cannot move an owner's active route.
  http.route({
    path: "/api/cloud/interior-builds",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request)) {
        return json({ error: "Unauthorized" }, 401);
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "A JSON request body is required." }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ error: "A JSON object is required." }, 400);
      }
      const candidate = body as Record<string, unknown>;
      const requiredString = (field: string): string | null => {
        const value = candidate[field];
        return typeof value === "string" && value.trim() ? value : null;
      };
      const buildId = requiredString("buildId");
      const ownerId = requiredString("ownerId");
      const turnId = requiredString("turnId");
      const threadId = requiredString("threadId");
      const sourceRevision =
        candidate.sourceRevision === undefined ||
        candidate.sourceRevision === null
          ? undefined
          : typeof candidate.sourceRevision === "string" &&
              candidate.sourceRevision.trim()
            ? candidate.sourceRevision
            : null;
      const artifactPrefix = requiredString("artifactPrefix");
      const artifactDigest = requiredString("digest");
      const manifestSha256 =
        candidate.manifestSha256 === undefined ||
        candidate.manifestSha256 === null
          ? undefined
          : typeof candidate.manifestSha256 === "string" &&
              candidate.manifestSha256.trim()
            ? candidate.manifestSha256
            : null;
      const minShellVersion = requiredString("minShellVersion");
      const baseRevision =
        candidate.baseRevision === undefined || candidate.baseRevision === null
          ? undefined
          : typeof candidate.baseRevision === "string" &&
              candidate.baseRevision.trim()
            ? candidate.baseRevision
            : null;
      const artifactManifestJson = requiredString("manifestJson");
      const artifactSizeBytes = candidate.size;
      const bridgeAbi = candidate.bridgeAbi;
      if (
        !buildId ||
        !ownerId ||
        !turnId ||
        !threadId ||
        sourceRevision === null ||
        !artifactPrefix ||
        !artifactDigest ||
        manifestSha256 === null ||
        !minShellVersion ||
        baseRevision === null ||
        !artifactManifestJson ||
        !Number.isSafeInteger(artifactSizeBytes) ||
        (artifactSizeBytes as number) < 0 ||
        !Number.isSafeInteger(bridgeAbi) ||
        (bridgeAbi as number) < 1
      ) {
        return json({ error: "Invalid interior build candidate." }, 400);
      }
      try {
        const parsed = JSON.parse(artifactManifestJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return json({ error: "manifestJson must encode an object." }, 400);
        }
      } catch {
        return json({ error: "manifestJson must be valid JSON." }, 400);
      }
      try {
        const result = await ctx.runMutation(
          internal.cloud_deployments.recordInteriorBuildInternal,
          {
            buildId,
            ownerId,
            turnId,
            threadId,
            ...(sourceRevision === undefined ? {} : { sourceRevision }),
            ...(baseRevision === undefined ? {} : { baseRevision }),
            artifactPrefix,
            artifactManifestJson,
            ...(manifestSha256 === undefined ? {} : { manifestSha256 }),
            artifactDigest,
            artifactSizeBytes: artifactSizeBytes as number,
            bridgeAbi: bridgeAbi as number,
            minShellVersion,
            now: Date.now(),
          },
        );
        return json({ ok: true, ...result });
      } catch (error) {
        if (error instanceof ConvexError) {
          return json({ error: String(error.data) }, 409);
        }
        throw error;
      }
    }),
  });

  http.route({
    path: "/api/cloud/model",
    method: "POST",
    handler: httpAction(async (_ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
      if (!apiKey)
        return json({ error: "Anthropic relay is not configured" }, 503);
      const body = (await request.json()) as { prompt?: string };
      const startedAt = Date.now();
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 900,
          system:
            "You are Stella's cloud app art director. Return only JSON with keys title, eyebrow, headline, subhead, accent, accentSoft, habits (array of exactly four objects with name, detail, progress number 0-100), and focus. No markdown.",
          messages: [{ role: "user", content: body.prompt ?? "" }],
        }),
      });
      const payload = (await upstream.json()) as {
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        model?: string;
        error?: { message?: string };
      };
      if (!upstream.ok) {
        return json(
          { error: payload.error?.message ?? "Provider request failed" },
          upstream.status,
        );
      }
      const text =
        payload.content?.find((item) => item.type === "text")?.text ?? "";
      const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
      const inputTokens = payload.usage?.input_tokens ?? 0;
      const outputTokens = payload.usage?.output_tokens ?? 0;
      return json({
        spec: parsed,
        usage: {
          model: payload.model ?? "claude-haiku-4-5-20251001",
          inputTokens,
          outputTokens,
          estimatedCostUsd:
            inputTokens / 1_000_000 + (outputTokens * 5) / 1_000_000,
          durationMs: Date.now() - startedAt,
        },
      });
    }),
  });
}
