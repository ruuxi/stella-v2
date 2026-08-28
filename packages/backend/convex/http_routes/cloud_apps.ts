import { makeFunctionReference, type HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { enforceActionRateLimit } from "../lib/rate_limits";
import { executeWebSearch } from "../tools/backend";
import { parseCloudBuildCallback } from "../lib/cloud_build_callback";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
import { computeUsageCostMicroCents } from "../lib/billing_money";
import { estimateRequestTokens } from "../stella_provider/request";
import {
  bindManagedProviderRequest,
  createManagedUsageDispatchGuard,
} from "../lib/managed_billing";
import { runManagedDispatchAttempt } from "../runtime_ai/managed";
import { MANAGED_USAGE_BILLING_KIND } from "../lib/managed_dispatch";
import { isConnectedOwnerIdAction } from "../auth";

const CLOUD_APP_MODEL = "anthropic/claude-haiku-4.5";
const CLOUD_APP_UPSTREAM_MODEL = "claude-haiku-4-5-20251001";
const CLOUD_APP_MODEL_AGENT = "cloud-app-model";
const CLOUD_APP_MODEL_SYSTEM_PROMPT =
  "You are Stella's cloud app art director. Return only JSON with keys title, eyebrow, headline, subhead, accent, accentSoft, habits (array of exactly four objects with name, detail, progress number 0-100), and focus. No markdown.";

class CloudModelUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly providerMessage: string,
  ) {
    super(`Cloud model upstream returned ${status}`);
  }
}

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
  tokenHash: string;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  agentType: string;
  expiresAt: number;
};

const isActiveCloudParentTurnRef = makeFunctionReference<
  "query",
  {
    tokenHash: string;
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    turnId: string;
    now: number;
  },
  boolean
>("cloud_apps:isActiveCloudParentTurnInternal");

const getBrowserSuspensionReplayAuthorityRef = makeFunctionReference<
  "query",
  {
    interactionId: string;
    turnId: string;
    threadId: string;
    attemptGeneration: number;
    tokenHash: string;
    payloadHash: string;
  },
  TurnTokenRow | null
>("cloud_browser:getBrowserSuspensionReplayAuthorityInternal");

// The sandbox/DO executor's only credential: an opaque per-turn token whose
// hash Convex stored at dispatch. Callers present it as `x-stella-turn-token`.
const verifyTurnToken = async (
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  request: Request,
  requireActive = false,
): Promise<TurnTokenRow | null> => {
  const token = request.headers.get("x-stella-turn-token")?.trim();
  if (!token) return null;
  const row = (await ctx.runQuery(
    internal.cloud_apps.getTurnTokenByHashInternal,
    {
      tokenHash: await hashToken(token),
      now: Date.now(),
      ...(requireActive ? { requireActive: true } : {}),
    },
  )) as
    | (Omit<TurnTokenRow, "ownerGeneration"> & {
        ownerGeneration?: string;
      })
    | null;
  return row && typeof row.ownerGeneration === "string"
    ? { ...row, ownerGeneration: row.ownerGeneration }
    : null;
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
      const body = (await request.json()) as {
        tokenHash?: string;
        ownerId?: string;
        ownerGeneration?: string;
        turnId: string;
        attemptGeneration?: number;
        sessionId: string;
        seq?: number | "auto";
        kind: string;
        payload: unknown;
        terminal?: boolean;
      };
      const payloadJson = JSON.stringify(body.payload ?? {});
      let token = service ? null : await verifyTurnToken(ctx, request);
      // The first waiting projection revokes the physical turn token. If its
      // HTTP response was lost, admit only a byte-exact replay through the
      // durable interaction receipt; the revoked token cannot authorize any
      // other route or payload.
      if (
        !service &&
        !token &&
        body.kind === "waiting_for_user" &&
        body.terminal !== true &&
        typeof body.turnId === "string" &&
        typeof body.sessionId === "string" &&
        Number.isSafeInteger(body.attemptGeneration) &&
        body.payload !== null &&
        typeof body.payload === "object" &&
        !Array.isArray(body.payload)
      ) {
        const suspension = (body.payload as Record<string, unknown>).suspension;
        const rawToken = request.headers.get("x-stella-turn-token")?.trim();
        if (
          rawToken &&
          suspension !== null &&
          typeof suspension === "object" &&
          !Array.isArray(suspension) &&
          typeof (suspension as Record<string, unknown>).interactionId ===
            "string"
        ) {
          const tokenHash = await hashToken(rawToken);
          token = await ctx.runQuery(getBrowserSuspensionReplayAuthorityRef, {
            interactionId: (suspension as Record<string, unknown>)
              .interactionId as string,
            turnId: body.turnId,
            threadId: body.sessionId,
            attemptGeneration: body.attemptGeneration!,
            tokenHash,
            payloadHash: await hashToken(payloadJson),
          });
        }
      }
      if (!service && !token) return json({ error: "Unauthorized" }, 401);
      // A turn token only speaks for its own turn.
      if (token && token.turnId !== body.turnId) {
        return json({ error: "Forbidden" }, 403);
      }
      const ownerId = token?.ownerId ?? body.ownerId?.trim();
      const ownerGeneration =
        token?.ownerGeneration ?? body.ownerGeneration?.trim();
      if (!ownerId || !ownerGeneration) {
        return json({ error: "ownerId and ownerGeneration required" }, 400);
      }
      const tokenHash = token?.tokenHash ?? body.tokenHash?.trim();
      if (!tokenHash) {
        return json({ error: "Exact turn token hash required" }, 400);
      }
      const connectedAccount =
        body.kind === "waiting_for_user" && body.terminal !== true
          ? await isConnectedOwnerIdAction(ctx, ownerId)
          : undefined;
      if (connectedAccount === false) {
        return json(
          { error: "Sign in with an account to use the cloud browser." },
          403,
        );
      }
      const autoSeq = body.seq === undefined || body.seq === "auto";
      const result = await ctx.runMutation(
        internal.cloud_apps.appendEventInternal,
        {
          tokenHash,
          ownerId,
          ownerGeneration,
          turnId: body.turnId,
          ...(body.attemptGeneration !== undefined
            ? { attemptGeneration: body.attemptGeneration }
            : {}),
          sessionId: body.sessionId,
          seq: autoSeq ? 0 : (body.seq as number),
          autoSeq,
          kind: body.kind,
          payloadJson,
          terminal: body.terminal === true,
          ...(connectedAccount !== undefined ? { connectedAccount } : {}),
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
      const ownerId = url.searchParams.get("ownerId")?.trim();
      const ownerGeneration = url.searchParams.get("ownerGeneration")?.trim();
      if (!threadId || !ownerId || !ownerGeneration) {
        return json(
          {
            error: "conversationId, ownerId, and ownerGeneration are required",
          },
          400,
        );
      }
      try {
        const current = await assertOwnerDataAccessActive(ctx, ownerId);
        if (current.generation !== ownerGeneration) {
          return json({ error: "Owner data generation is stale" }, 409);
        }
        const messages = await ctx.runQuery(
          internal.cloud_apps.listThreadMessagesInternal,
          {
            ownerId,
            ownerGeneration,
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
      // Both the builder DO and the sandbox have the per-turn capability. A
      // service secret alone is intentionally insufficient on this
      // transcript-writing surface: every append must name one exact active
      // executor attempt.
      const token = await verifyTurnToken(ctx, request, true);
      if (!token) return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        ownerId?: string;
        ownerGeneration?: string;
        conversationId: string;
        turnId: string;
        messages: Array<{
          ordinal: number;
          role: string;
          payloadJson: string;
        }>;
      };
      if (token.turnId !== body.turnId) {
        return json({ error: "Forbidden" }, 403);
      }
      const ownerId = token.ownerId;
      const ownerGeneration = token.ownerGeneration;
      if (!ownerId || !ownerGeneration) {
        return json({ error: "ownerId and ownerGeneration required" }, 400);
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return json({ error: "messages required" }, 400);
      }
      if (body.messages.length > 1_024) {
        return json({ error: "Too many messages in one append." }, 400);
      }
      try {
        const result = await ctx.runMutation(
          internal.cloud_apps.appendThreadMessagesInternal,
          {
            tokenHash: token.tokenHash,
            ownerId,
            ownerGeneration,
            threadId: body.conversationId,
            turnId: body.turnId,
            messages: body.messages.map((message) => ({
              ordinal: message.ordinal,
              role: message.role,
              payloadJson: message.payloadJson,
            })),
            now: Date.now(),
          },
        );
        return json(result);
      } catch {
        return json({ error: "Cloud turn is no longer active." }, 409);
      }
    }),
  });

  // A builder worker rechecks this at admission and before every consequential
  // agent boundary. Including the current token hash makes redispatch rotation
  // revoke a still-running stale isolate without exposing the token itself.
  http.route({
    path: "/api/cloud/agent-turn-authority",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const body = (await request.json()) as {
        tokenHash?: string;
        ownerId?: string;
        ownerGeneration?: string;
        threadId?: string;
        turnId?: string;
        attemptGeneration?: number;
      };
      if (
        !body.tokenHash?.trim() ||
        !body.ownerId?.trim() ||
        !body.ownerGeneration?.trim() ||
        !body.threadId?.trim() ||
        !body.turnId?.trim() ||
        !Number.isSafeInteger(body.attemptGeneration) ||
        body.attemptGeneration! < 1
      ) {
        return json({ error: "Exact agent turn authority is required." }, 400);
      }
      try {
        const authoritative = await ctx.runQuery(
          internal.cloud_apps.isCloudAgentTurnAttemptAuthoritativeInternal,
          {
            tokenHash: body.tokenHash.trim(),
            ownerId: body.ownerId.trim(),
            ownerGeneration: body.ownerGeneration.trim(),
            threadId: body.threadId.trim(),
            turnId: body.turnId.trim(),
            attemptGeneration: body.attemptGeneration!,
            now: Date.now(),
          },
        );
        return authoritative
          ? json({ authoritative: true })
          : json({ authoritative: false }, 409);
      } catch {
        return json({ authoritative: false }, 409);
      }
    }),
  });

  // A BuildSession rechecks this immediately before it persists a fresh app
  // turn. The owner-purge Durable Object fences in-flight storage work, but it
  // cannot know that Convex rotated an owner's lifecycle generation after a
  // completed reset. This token-inclusive check prevents a delayed pre-reset
  // dispatch from recreating user data after that fence reopens.
  http.route({
    path: "/api/cloud/app-turn-authority",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const body = (await request.json().catch(() => null)) as {
        tokenHash?: unknown;
        ownerId?: unknown;
        ownerGeneration?: unknown;
        conversationId?: unknown;
        appId?: unknown;
        turnId?: unknown;
        sessionId?: unknown;
      } | null;
      const exact = {
        tokenHash:
          typeof body?.tokenHash === "string" ? body.tokenHash.trim() : "",
        ownerId: typeof body?.ownerId === "string" ? body.ownerId.trim() : "",
        ownerGeneration:
          typeof body?.ownerGeneration === "string"
            ? body.ownerGeneration.trim()
            : "",
        conversationId:
          typeof body?.conversationId === "string"
            ? body.conversationId.trim()
            : "",
        appId: typeof body?.appId === "string" ? body.appId.trim() : "",
        turnId: typeof body?.turnId === "string" ? body.turnId.trim() : "",
        sessionId:
          typeof body?.sessionId === "string" ? body.sessionId.trim() : "",
      };
      if (Object.values(exact).some((value) => !value)) {
        return json({ error: "Exact app turn authority is required." }, 400);
      }
      try {
        const authoritative = await ctx.runQuery(
          internal.cloud_apps.isCloudBuildTurnAttemptAuthoritativeInternal,
          { ...exact, now: Date.now() },
        );
        return authoritative
          ? json({ authoritative: true })
          : json({ authoritative: false }, 409);
      } catch {
        return json({ authoritative: false }, 409);
      }
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
        ownerGeneration?: string;
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
      const ownerId =
        typeof body.ownerId === "string" ? body.ownerId.trim() : "";
      const ownerGeneration =
        typeof body.ownerGeneration === "string"
          ? body.ownerGeneration.trim()
          : "";
      if (!conversationId || !ownerId || !ownerGeneration) {
        return json(
          { error: "conversationId, ownerId, and ownerGeneration required" },
          400,
        );
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
            ownerGeneration,
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
        action?: "spawn" | "cancel" | "cancel_ack";
        ownerId: string;
        ownerGeneration?: string;
        conversationId: string;
        parentTurnId?: string;
        description?: string;
        prompt?: string;
        workspace?: string;
        threadId?: string;
        turnId?: string;
        attemptGeneration?: number;
        expectedAttemptGeneration?: number;
        expectedThreadUpdatedAt?: number;
        cancelRequestId?: string;
        model?: string;
        clientMsgId?: string;
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
      const ownerGeneration = body.ownerGeneration?.trim();
      if (!body.ownerId?.trim() || !ownerGeneration) {
        return json({ error: "ownerId and ownerGeneration required" }, 400);
      }
      const parentToken = request.headers.get("x-stella-turn-token")?.trim();
      const parentTokenHash = parentToken
        ? await hashToken(parentToken)
        : undefined;
      if (
        body.action !== "cancel_ack" &&
        (!body.parentTurnId || !body.conversationId?.trim() || !parentTokenHash)
      ) {
        return json(
          {
            error:
              "An active parent turn, conversation, and turn token are required.",
          },
          401,
        );
      }
      if (body.action === "cancel_ack") {
        if (
          !body.threadId ||
          !body.turnId ||
          !body.cancelRequestId ||
          !Number.isSafeInteger(body.attemptGeneration) ||
          body.attemptGeneration! < 1
        ) {
          return json(
            {
              error:
                "threadId, turnId, attemptGeneration, and cancelRequestId required",
            },
            400,
          );
        }
        const canceled = await ctx.runMutation(
          internal.cloud_apps.cancelCloudAgentTurnInternal,
          {
            ownerId: body.ownerId,
            ownerGeneration,
            threadId: body.threadId,
            turnId: body.turnId,
            attemptGeneration: body.attemptGeneration!,
            controlRequestId: body.cancelRequestId,
            now: Date.now(),
          },
        );
        return json({ ok: canceled.canceled, ...canceled });
      }
      if (body.action === "cancel") {
        const parentActive = await ctx.runQuery(isActiveCloudParentTurnRef, {
          tokenHash: parentTokenHash!,
          ownerId: body.ownerId,
          ownerGeneration,
          conversationId: body.conversationId,
          turnId: body.parentTurnId!,
          now: Date.now(),
        });
        if (!parentActive) {
          return json(
            { error: "That orchestrator turn is no longer active." },
            409,
          );
        }
        if (
          !body.threadId ||
          !Number.isSafeInteger(body.expectedAttemptGeneration) ||
          !Number.isFinite(body.expectedThreadUpdatedAt)
        ) {
          return json(
            {
              error:
                "threadId, expectedAttemptGeneration, and expectedThreadUpdatedAt required",
            },
            400,
          );
        }
        const control = await ctx.runQuery(
          internal.cloud_apps.getCloudAgentThreadControlInternal,
          {
            ownerId: body.ownerId,
            ownerGeneration,
            threadId: body.threadId,
            conversationId: body.conversationId,
            ...(body.cancelRequestId
              ? { controlRequestId: body.cancelRequestId }
              : {}),
          },
        );
        if (!control) return json({ error: "Thread not found." }, 404);
        if (control.alreadyCanceled) {
          return json({
            ok: true,
            threadId: body.threadId,
            status: control.status,
            alreadyCanceled: true,
            attemptGeneration: control.attemptGeneration,
            threadUpdatedAt: control.threadUpdatedAt,
            currentControl: control.currentControl ?? {
              threadId: body.threadId,
              status: control.status,
              attemptGeneration: control.attemptGeneration,
              threadUpdatedAt: control.threadUpdatedAt,
            },
          });
        }
        if (control.status !== "running") {
          return json({
            ok: true,
            threadId: body.threadId,
            status: control.status,
            attemptGeneration: control.attemptGeneration,
            threadUpdatedAt: control.threadUpdatedAt,
            currentControl: {
              threadId: body.threadId,
              status: control.status,
              attemptGeneration: control.attemptGeneration,
              threadUpdatedAt: control.threadUpdatedAt,
            },
          });
        }
        if (
          control.attemptGeneration !== body.expectedAttemptGeneration ||
          control.threadUpdatedAt !== body.expectedThreadUpdatedAt
        ) {
          return json({ error: "Thread changed." }, 409);
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
          attemptGeneration: control.attemptGeneration,
          threadUpdatedAt: control.threadUpdatedAt,
          currentControl: {
            threadId: body.threadId,
            status: control.status,
            attemptGeneration: control.attemptGeneration,
            threadUpdatedAt: control.threadUpdatedAt,
          },
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
          ownerGeneration,
          conversationId: body.conversationId,
          parentTurnId: body.parentTurnId,
          parentTokenHash,
          description: body.description,
          prompt: body.prompt,
          workspace: body.workspace ?? "cloud",
          threadId: body.threadId,
          ...(body.threadId
            ? {
                expectedAttemptGeneration: body.expectedAttemptGeneration,
                expectedTerminalUpdatedAt: body.expectedThreadUpdatedAt,
              }
            : {}),
          model: body.model,
          clientMsgId: body.clientMsgId,
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
        tokenHash?: string;
        ownerId?: string;
        ownerGeneration?: string;
        threadId: string;
        turnId?: string;
        attemptGeneration?: number;
        status: string;
        resultJson?: string;
        errorMessage?: string;
        wake?: boolean;
      };
      if (token && body.turnId && token.turnId !== body.turnId) {
        return json({ error: "Forbidden" }, 403);
      }
      const ownerId = token?.ownerId ?? body.ownerId?.trim();
      const ownerGeneration =
        token?.ownerGeneration ?? body.ownerGeneration?.trim();
      if (!ownerId || !ownerGeneration) {
        return json({ error: "ownerId and ownerGeneration required" }, 400);
      }
      const tokenHash = token?.tokenHash ?? body.tokenHash?.trim();
      if (!tokenHash) {
        return json({ error: "Exact turn token hash required" }, 400);
      }
      const completingTurnId = token?.turnId ?? body.turnId?.trim();
      if (!completingTurnId) {
        return json({ error: "turnId required" }, 400);
      }
      if (
        !Number.isSafeInteger(body.attemptGeneration) ||
        body.attemptGeneration! < 1
      ) {
        return json({ error: "attemptGeneration required" }, 400);
      }
      // A turn token is bound to its own thread inside the mutation (the
      // volunteered-turnId check above is skippable by omitting turnId).
      await ctx.runMutation(internal.cloud_apps.completeAgentThreadInternal, {
        tokenHash,
        ownerId,
        ownerGeneration,
        threadId: body.threadId,
        attemptGeneration: body.attemptGeneration!,
        status: body.status,
        resultJson: body.resultJson,
        errorMessage: body.errorMessage,
        wake: body.wake,
        callerTurnId: token?.turnId ?? completingTurnId,
        completingTurnId,
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
      const token = await verifyTurnToken(ctx, request, true);
      if (!token) return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        query: string;
        category?: string;
        ownerId?: string;
        ownerGeneration?: string;
      };
      const ownerId = token.ownerId;
      const ownerGeneration = token.ownerGeneration;
      if (!ownerId || !ownerGeneration) {
        return json({ error: "ownerId and ownerGeneration required" }, 400);
      }
      try {
        const current = await assertOwnerDataAccessActive(ctx, ownerId);
        if (current.generation !== ownerGeneration) {
          return json({ error: "Owner data generation is stale" }, 409);
        }
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }
      await enforceActionRateLimit(
        ctx,
        "cloud_web_search",
        ownerId,
        { rate: 30, periodMs: 60_000 },
        "Too many web searches. Wait a moment and try again.",
      );
      // Rate limiting and provider preparation happen outside a database
      // transaction. Recheck the admitted generation at the last possible
      // moment before the search provider can incur work or return owner data.
      try {
        await ctx.runMutation(
          internal.owner_lifecycle.assertOwnerDataDispatchAllowedInternal,
          { ownerId, ownerGeneration },
        );
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }
      try {
        const result = await executeWebSearch(ctx, body.query ?? "", {
          ownerId,
          ownerGeneration,
          turnAuthority: {
            tokenHash: token.tokenHash,
            turnId: token.turnId,
          },
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(90_000),
          ]),
          category: body.category,
        });
        return json(result);
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }
    }),
  });

  http.route({
    path: "/api/cloud/builds",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      let body: ReturnType<typeof parseCloudBuildCallback>;
      try {
        body = parseCloudBuildCallback(await request.json());
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Invalid build callback.",
          },
          400,
        );
      }
      try {
        await ctx.runMutation(internal.cloud_apps.recordBuildInternal, {
          ...body,
          now: Date.now(),
        });
      } catch (error) {
        const message =
          error instanceof ConvexError
            ? String(error.data)
            : error instanceof Error
              ? error.message
              : String(error);
        return json({ error: message }, 409);
      }
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
      const ownerGeneration = requiredString("ownerGeneration");
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
        !ownerGeneration ||
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
            ownerGeneration,
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
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      let body: {
        ownerId?: unknown;
        ownerGeneration?: unknown;
        requestId?: unknown;
        prompt?: unknown;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: "Cloud model request must be valid JSON" }, 400);
      }
      const ownerId =
        typeof body.ownerId === "string" ? body.ownerId.trim() : "";
      const ownerGeneration =
        typeof body.ownerGeneration === "string"
          ? body.ownerGeneration.trim()
          : "";
      const requestId =
        typeof body.requestId === "string" ? body.requestId.trim() : "";
      if (!ownerId || !ownerGeneration || !requestId) {
        return json(
          { error: "ownerId, ownerGeneration, and requestId required" },
          400,
        );
      }
      if (!/^cloud-model:[a-f0-9]{64}$/u.test(requestId)) {
        return json({ error: "requestId is invalid" }, 400);
      }
      try {
        const current = await assertOwnerDataAccessActive(ctx, ownerId);
        if (current.generation !== ownerGeneration) {
          return json({ error: "Owner data generation is stale" }, 409);
        }
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }

      let access: {
        allowed: boolean;
        retryAfterMs: number;
        message: string;
      };
      try {
        access = await ctx.runMutation(
          internal.billing.resolveManagedModelAccess,
          { ownerId, ownerGeneration },
        );
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }
      if (!access.allowed) {
        const response = json({ error: access.message }, 429);
        response.headers.set(
          "Retry-After",
          String(Math.max(1, Math.ceil(access.retryAfterMs / 1_000))),
        );
        return response;
      }

      const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
      if (!apiKey)
        return json({ error: "Anthropic relay is not configured" }, 503);

      const upstreamBody = {
        model: CLOUD_APP_UPSTREAM_MODEL,
        max_tokens: 900,
        system: CLOUD_APP_MODEL_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: typeof body.prompt === "string" ? body.prompt : "",
          },
        ],
      };
      const upstreamBodyJson = JSON.stringify(upstreamBody);
      const tokenEstimate = estimateRequestTokens(upstreamBody);
      const modelPrice = await ctx.runQuery(
        internal.billing.getManagedModelPrice,
        { model: CLOUD_APP_MODEL },
      );
      const price = modelPrice
        ? {
            inputPerMillionUsd: modelPrice.inputPerMillionUsd,
            outputPerMillionUsd: modelPrice.outputPerMillionUsd,
            cacheReadPerMillionUsd: modelPrice.cacheReadPerMillionUsd,
            cacheWritePerMillionUsd: modelPrice.cacheWritePerMillionUsd,
            reasoningPerMillionUsd: modelPrice.reasoningPerMillionUsd,
          }
        : undefined;
      const estimatedCost = Math.max(
        1,
        computeUsageCostMicroCents({
          model: CLOUD_APP_MODEL,
          inputTokens: tokenEstimate.inputTokens,
          outputTokens: tokenEstimate.outputTokens,
          price,
        }),
      );
      try {
        const limit = await ctx.runMutation(
          internal.billing.enforceManagedUsageLimit,
          {
            ownerId,
            ownerGeneration,
            minimumRemainingMicroCents: estimatedCost,
          },
        );
        if (!limit.allowed) {
          const response = json({ error: limit.message }, 429);
          response.headers.set(
            "Retry-After",
            String(Math.max(1, Math.ceil(limit.retryAfterMs / 1_000))),
          );
          return response;
        }
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }

      let requestFingerprint: string;
      try {
        const binding = await bindManagedProviderRequest(ctx, {
          ownerId,
          ownerGeneration,
          route: "cloud:model",
          requestId,
          canonicalBody: upstreamBodyJson,
        });
        if (binding.replayed) {
          return json(
            {
              error:
                "This cloud model request was already accepted; use a new requestId for new work.",
            },
            409,
          );
        }
        requestFingerprint = binding.requestFingerprint;
      } catch {
        return json(
          { error: "requestId conflicts with an existing cloud model request" },
          409,
        );
      }

      const startedAt = Date.now();
      const dispatchGuard = createManagedUsageDispatchGuard(ctx, {
        ownerId,
        ownerGeneration,
      });
      const billing = {
        kind: MANAGED_USAGE_BILLING_KIND,
        requestFingerprint,
        agentType: CLOUD_APP_MODEL_AGENT,
        model: CLOUD_APP_MODEL,
        fallbackCostMicroCents: estimatedCost,
      } as const;
      try {
        const result = await runManagedDispatchAttempt({
          dispatchGuard,
          callerSignal: request.signal,
          billing,
          run: async (signal, receipt) => {
            const upstream = await fetch(
              "https://api.anthropic.com/v1/messages",
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-api-key": apiKey,
                  "anthropic-version": "2023-06-01",
                },
                body: upstreamBodyJson,
                signal,
              },
            );
            const payload = (await upstream.json()) as {
              content?: Array<{ type?: string; text?: string }>;
              usage?: { input_tokens?: number; output_tokens?: number };
              model?: string;
              error?: { message?: string };
            };
            const inputTokens =
              payload.usage?.input_tokens ?? tokenEstimate.inputTokens;
            const outputTokens = payload.usage?.output_tokens ?? 0;
            const exactCost = Math.max(
              1,
              computeUsageCostMicroCents({
                model: CLOUD_APP_MODEL,
                inputTokens,
                outputTokens,
                price,
              }),
            );
            if (!upstream.ok) {
              await receipt.captureUsage({
                durationMs: Date.now() - startedAt,
                success: false,
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                costMicroCents: exactCost,
              });
              throw new CloudModelUpstreamError(
                upstream.status,
                payload.error?.message ?? "Provider request failed",
              );
            }
            const text =
              payload.content?.find((item) => item.type === "text")?.text ?? "";
            let spec: unknown;
            try {
              spec = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
            } catch {
              await receipt.captureUsage({
                durationMs: Date.now() - startedAt,
                success: false,
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                costMicroCents: exactCost,
              });
              throw new Error(
                "Cloud model returned invalid specification JSON",
              );
            }
            await receipt.captureUsage({
              durationMs: Date.now() - startedAt,
              success: true,
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              costMicroCents: exactCost,
            });
            return { payload, spec, inputTokens, outputTokens };
          },
        });
        return json({
          spec: result.spec,
          usage: {
            model: result.payload.model ?? CLOUD_APP_UPSTREAM_MODEL,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            estimatedCostUsd:
              result.inputTokens / 1_000_000 +
              (result.outputTokens * 5) / 1_000_000,
            durationMs: Date.now() - startedAt,
          },
        });
      } catch (error) {
        if (error instanceof CloudModelUpstreamError) {
          return json({ error: error.providerMessage }, error.status);
        }
        return dispatchGuard.signal.aborted || request.signal.aborted
          ? json({ error: "Owner data is unavailable" }, 409)
          : json({ error: "Provider request failed" }, 502);
      }
    }),
  });
}
