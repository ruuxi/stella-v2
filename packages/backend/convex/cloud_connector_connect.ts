/**
 * Inline connect cards for cloud orchestrator turns.
 *
 * The desktop shows a connect card over Electron IPC while the runtime
 * blocks on the answer. The cloud has no IPC, so the card is a pending
 * request row every signed-in client subscribes to (the same shape as
 * cloud browser interactions), and the waiting turn polls the row through
 * the `/api/cloud/connector-connect` route. Connecting mints the account's
 * Composio link exactly as the Store does; the connection then exists for
 * every surface, desktop included.
 */

import { ConvexError, v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  assertOwnerMigrationWriteAllowed,
  requireSensitiveConnectedUserIdentity,
  requireSensitiveConnectedUserIdentityAction,
} from "./auth";
import { assertOwnerDataAccessActive } from "./owner_lifecycle";
import { enforceActionRateLimit } from "./lib/rate_limits";
import { cloudConnectorConnectStateValidator } from "./schema/cloud_connector_connect";
import {
  composioFetch,
  composioLinkFromPayload,
  composioToolkitConnectedFromPayload,
  ensureComposioSession,
  loadComposioSessionId,
  loadPublicIntegration,
  readComposioConnector,
  requireComposioConfig,
} from "./http_routes/native_oauth";

/** Desktop keeps its card up about this long; the cloud row expires alike. */
export const CONNECT_REQUEST_TTL_MS = 5 * 60_000;
const MAX_PENDING_REQUESTS = 8;
const TERMINAL_STATES = new Set(["connected", "declined", "canceled", "expired"]);

export const connectRequestSummaryValidator = v.object({
  schemaVersion: v.literal(1),
  requestId: v.string(),
  conversationId: v.string(),
  turnId: v.string(),
  integrationId: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  iconUrl: v.optional(v.string()),
  category: v.optional(v.string()),
  reason: v.optional(v.string()),
  state: cloudConnectorConnectStateValidator,
  revision: v.number(),
  expiresAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export type ConnectRequestSummary = {
  schemaVersion: 1;
  requestId: string;
  conversationId: string;
  turnId: string;
  integrationId: string;
  name: string;
  description?: string;
  iconUrl?: string;
  category?: string;
  reason?: string;
  state: Doc<"cloud_connector_connect_requests">["state"];
  revision: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

const projectSummary = (
  row: Doc<"cloud_connector_connect_requests">,
): ConnectRequestSummary => ({
  schemaVersion: 1,
  requestId: row.requestId,
  conversationId: row.conversationId,
  turnId: row.turnId,
  integrationId: row.integrationId,
  name: row.name,
  ...(row.description ? { description: row.description } : {}),
  ...(row.iconUrl ? { iconUrl: row.iconUrl } : {}),
  ...(row.category ? { category: row.category } : {}),
  ...(row.reason ? { reason: row.reason } : {}),
  state: row.state,
  revision: row.revision,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const effectiveState = (
  row: Doc<"cloud_connector_connect_requests">,
  now: number,
): Doc<"cloud_connector_connect_requests">["state"] =>
  !TERMINAL_STATES.has(row.state) && row.expiresAt <= now
    ? "expired"
    : row.state;

const optionalText = (value: string | undefined, max: number) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

// ---------------------------------------------------------------------------
// Turn-side (control plane) surface
// ---------------------------------------------------------------------------

export const createConnectRequestInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    turnId: v.string(),
    integrationId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    iconUrl: v.optional(v.string()),
    category: v.optional(v.string()),
    reason: v.optional(v.string()),
    now: v.number(),
  },
  returns: connectRequestSummaryValidator,
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    // One live card per (turn, integration): a retried tool call after a
    // lost response finds the card it already showed.
    const existing = await ctx.db
      .query("cloud_connector_connect_requests")
      .withIndex("by_turnId_and_integrationId", (q) =>
        q.eq("turnId", args.turnId).eq("integrationId", args.integrationId),
      )
      .order("desc")
      .take(4);
    const live = existing.find(
      (row) =>
        row.ownerId === args.ownerId &&
        effectiveState(row, args.now) !== "expired" &&
        !TERMINAL_STATES.has(row.state),
    );
    if (live) return projectSummary(live);
    const row = {
      requestId: `cc-${crypto.randomUUID()}`,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      conversationId: args.conversationId,
      turnId: args.turnId,
      integrationId: args.integrationId.trim().toLowerCase(),
      name: args.name.trim().slice(0, 120),
      ...(optionalText(args.description, 500)
        ? { description: optionalText(args.description, 500) }
        : {}),
      ...(optionalText(args.iconUrl, 1_000)
        ? { iconUrl: optionalText(args.iconUrl, 1_000) }
        : {}),
      ...(optionalText(args.category, 80)
        ? { category: optionalText(args.category, 80) }
        : {}),
      ...(optionalText(args.reason, 300)
        ? { reason: optionalText(args.reason, 300) }
        : {}),
      state: "pending" as const,
      revision: 1,
      expiresAt: args.now + CONNECT_REQUEST_TTL_MS,
      createdAt: args.now,
      updatedAt: args.now,
    };
    const id = await ctx.db.insert("cloud_connector_connect_requests", row);
    return projectSummary({ ...row, _id: id, _creationTime: args.now });
  },
});

export const getConnectRequestInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    requestId: v.string(),
  },
  returns: v.union(v.null(), connectRequestSummaryValidator),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_connector_connect_requests")
      .withIndex("by_ownerId_and_requestId", (q) =>
        q.eq("ownerId", args.ownerId).eq("requestId", args.requestId),
      )
      .unique();
    if (!row || row.ownerGeneration !== args.ownerGeneration) return null;
    return projectSummary({ ...row, state: effectiveState(row, Date.now()) });
  },
});

export const settleConnectRequestInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    requestId: v.string(),
    state: cloudConnectorConnectStateValidator,
    /** Only move a row that is still in one of these states. */
    fromStates: v.array(cloudConnectorConnectStateValidator),
    decisionRequestId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.union(v.null(), connectRequestSummaryValidator),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const row = await ctx.db
      .query("cloud_connector_connect_requests")
      .withIndex("by_ownerId_and_requestId", (q) =>
        q.eq("ownerId", args.ownerId).eq("requestId", args.requestId),
      )
      .unique();
    if (!row || row.ownerGeneration !== args.ownerGeneration) return null;
    const current = effectiveState(row, args.now);
    if (!args.fromStates.includes(current)) {
      return projectSummary({ ...row, state: current });
    }
    const patch = {
      state: args.state,
      revision: row.revision + 1,
      updatedAt: args.now,
      ...(args.decisionRequestId
        ? { decisionRequestId: args.decisionRequestId }
        : {}),
      ...(TERMINAL_STATES.has(args.state) ? { completedAt: args.now } : {}),
    };
    await ctx.db.patch(row._id, patch);
    return projectSummary({ ...row, ...patch });
  },
});

// ---------------------------------------------------------------------------
// Client surface
// ---------------------------------------------------------------------------

export const listMyPendingConnectRequests = query({
  args: {},
  returns: v.array(connectRequestSummaryValidator),
  handler: async (ctx) => {
    const now = Date.now();
    const identity = await requireSensitiveConnectedUserIdentity(ctx);
    const ownerId = identity.tokenIdentifier;
    const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
    const pages = await Promise.all(
      (["pending", "connecting"] as const).map((state) =>
        ctx.db
          .query("cloud_connector_connect_requests")
          .withIndex("by_ownerId_and_state_and_createdAt", (q) =>
            q.eq("ownerId", ownerId).eq("state", state),
          )
          .order("desc")
          .take(MAX_PENDING_REQUESTS),
      ),
    );
    return pages
      .flat()
      .filter((row) => row.ownerGeneration === generation && row.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_PENDING_REQUESTS)
      .map(projectSummary);
  },
});

const requireActionOwner = async (ctx: ActionCtx) => {
  const identity = await requireSensitiveConnectedUserIdentityAction(ctx);
  const ownerId = identity.tokenIdentifier;
  const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
  return { ownerId, ownerGeneration: generation };
};

/**
 * The user's answer to the card. `connect` mints the account's Composio
 * link (the same flow the Store runs) and returns it for the client to
 * open; the waiting turn observes the connection through its poll.
 * `decline` settles the card and the turn persists a decline so the offer
 * is never repeated in that conversation.
 */
export const decideMyConnectRequest = action({
  args: {
    requestId: v.string(),
    expectedRevision: v.number(),
    decisionRequestId: v.string(),
    decision: v.union(v.literal("connect"), v.literal("decline")),
  },
  returns: v.object({
    request: connectRequestSummaryValidator,
    url: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const owner = await requireActionOwner(ctx);
    const requestId = args.requestId.trim();
    if (!requestId || requestId.length > 128) {
      throw new ConvexError("requestId is required.");
    }
    await enforceActionRateLimit(
      ctx,
      "cloud_connector_connect_decision",
      owner.ownerId,
      { rate: 30, periodMs: 10 * 60_000 },
      "Too many connect decisions. Wait a moment and try again.",
    );
    const current = (await ctx.runQuery(
      internal.cloud_connector_connect.getConnectRequestInternal,
      { ...owner, requestId },
    )) as ConnectRequestSummary | null;
    if (!current) throw new ConvexError("Connect request not found.");
    if (
      current.revision !== args.expectedRevision ||
      !["pending", "connecting"].includes(current.state)
    ) {
      throw new ConvexError(
        "This connect request changed. Refresh it and try again.",
      );
    }
    if (args.decision === "decline") {
      const settled = (await ctx.runMutation(
        internal.cloud_connector_connect.settleConnectRequestInternal,
        {
          ...owner,
          requestId,
          state: "declined",
          fromStates: ["pending", "connecting"],
          decisionRequestId: args.decisionRequestId,
          now: Date.now(),
        },
      )) as ConnectRequestSummary | null;
      return { request: settled ?? current };
    }
    const integration = await loadPublicIntegration(ctx, current.integrationId);
    const connector = integration ? readComposioConnector(integration) : null;
    if (!connector) {
      throw new ConvexError("This integration cannot be connected here.");
    }
    const composio = requireComposioConfig();
    if (!composio.config) {
      throw new ConvexError("Integrations are not configured on this server.");
    }
    const sessionId = await ensureComposioSession(ctx, {
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration,
      integrationId: connector.id,
      toolkit: connector.toolkit,
      config: composio.config,
    });
    await ctx.runMutation(
      internal.data.integrations.assertUserIntegrationDispatchAllowedInternal,
      { ownerId: owner.ownerId, ownerGeneration: owner.ownerGeneration },
    );
    const payload = await composioFetch(
      `/session/${encodeURIComponent(sessionId)}/link`,
      {
        method: "POST",
        body: JSON.stringify({ toolkit: connector.toolkit }),
      },
      composio.config,
    );
    const url = composioLinkFromPayload(payload);
    if (!url) throw new ConvexError("Composio did not return a connect link.");
    const settled = (await ctx.runMutation(
      internal.cloud_connector_connect.settleConnectRequestInternal,
      {
        ...owner,
        requestId,
        state: "connecting",
        fromStates: ["pending", "connecting"],
        decisionRequestId: args.decisionRequestId,
        now: Date.now(),
      },
    )) as ConnectRequestSummary | null;
    return { request: settled ?? current, url };
  },
});

/**
 * Whether the account's Composio session for an integration is connected
 * right now. Shared by the turn's poll (which settles a `connecting` card
 * once the OAuth hop finished) and the client's own status refresh.
 */
export const checkIntegrationConnected = async (
  ctx: ActionCtx,
  ownerId: string,
  integrationId: string,
): Promise<boolean> => {
  const integration = await loadPublicIntegration(ctx, integrationId);
  const connector = integration ? readComposioConnector(integration) : null;
  if (!connector) return false;
  const composio = requireComposioConfig();
  if (!composio.config) return false;
  const sessionId = await loadComposioSessionId(ctx, ownerId, connector.id);
  if (!sessionId) return false;
  try {
    const payload = await composioFetch(
      `/session/${encodeURIComponent(sessionId)}/toolkits`,
      { method: "GET" },
      composio.config,
    );
    return composioToolkitConnectedFromPayload(payload, connector.toolkit);
  } catch {
    return false;
  }
};
