"use node";

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import {
  ComposioUpstreamHttpError,
  composioFetch,
  composioSessionUserIdFromPayload,
  composioToolsApiBaseUrl,
  requireComposioConfig,
} from "./http_routes/native_oauth";

const MAX_PURGE_BATCH = 4;
const MAX_CONNECTED_ACCOUNT_PAGES = 4;
const MAX_CONNECTED_ACCOUNTS = 200;
const MAX_PENDING_DETAILS = 24;
const MAX_CURSOR_LENGTH = 512;
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/u;

type PurgeFence = {
  ownerId: string;
  operationId: string;
  generation: string;
  leaseId: string;
};

type PurgeLocator = {
  id: Id<"user_integrations">;
  provider: string;
  toolkit: string;
  sessionId?: string;
  composioUserId?: string;
  composioUserIds: string[];
  updatedAt: number;
};

const getBatchRef = makeFunctionReference<
  "query",
  { ownerId: string },
  PurgeLocator[]
>("composio_purge_store:getOwnerComposioPurgeBatchInternal");
const acknowledgeRef = makeFunctionReference<
  "mutation",
  PurgeFence & {
    id: Id<"user_integrations">;
    provider: string;
    sessionId: string;
    updatedAt: number;
  },
  null
>("composio_purge_store:acknowledgeOwnerComposioSessionDeletedInternal");
const recordResolvedPrincipalRef = makeFunctionReference<
  "mutation",
  PurgeFence & {
    id: Id<"user_integrations">;
    provider: string;
    sessionId: string;
    updatedAt: number;
    composioUserId: string;
    now: number;
  },
  number
>("composio_purge_store:recordOwnerComposioResolvedPrincipalInternal");
const remainingRef = makeFunctionReference<
  "query",
  { ownerId: string },
  string[]
>("composio_purge_store:remainingOwnerComposioSessionRowsInternal");

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const safeString = (value: unknown, pattern = SAFE_EXTERNAL_ID) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : null;
};

const providerFromConnectedAccount = (item: Record<string, unknown>) => {
  const toolkit = isObject(item.toolkit) ? item.toolkit : null;
  return safeString(toolkit?.slug, SAFE_PROVIDER);
};

/** Strictly extract only account rows bound to the requested provider/user. */
export const connectedAccountIdsFromPayload = (
  payload: Record<string, unknown>,
  expected: { provider: string; composioUserId: string },
): { ids: string[]; nextCursor: string | null } => {
  if (!Array.isArray(payload.items)) {
    throw new Error("Composio connected-account response is malformed.");
  }
  const ids: string[] = [];
  for (const raw of payload.items) {
    if (!isObject(raw)) {
      throw new Error("Composio connected-account row is malformed.");
    }
    const id = safeString(raw.id);
    const provider = providerFromConnectedAccount(raw);
    const userId = safeString(raw.user_id);
    if (
      !id ||
      provider !== expected.provider ||
      userId !== expected.composioUserId
    ) {
      throw new Error("Composio connected-account identity did not match.");
    }
    ids.push(id);
  }
  const rawCursor = payload.next_cursor;
  const nextCursor =
    rawCursor === null || rawCursor === undefined || rawCursor === ""
      ? null
      : typeof rawCursor === "string" &&
          rawCursor.length <= MAX_CURSOR_LENGTH &&
          /^[A-Za-z0-9+/=_-]+$/u.test(rawCursor)
        ? rawCursor
        : (() => {
            throw new Error("Composio connected-account cursor is invalid.");
          })();
  return { ids, nextCursor };
};

/** Strict readback for the synchronous connected-account revoke endpoint. */
export const connectedAccountRevokedFromPayload = (
  payload: Record<string, unknown>,
  expected: {
    id: string;
    provider: string;
    composioUserId: string;
  },
): boolean => {
  const candidate = isObject(payload.data)
    ? payload.data
    : isObject(payload.connected_account)
      ? payload.connected_account
      : payload;
  const id = safeString(candidate.id);
  const provider = providerFromConnectedAccount(candidate);
  const userId = safeString(candidate.user_id);
  const status = safeString(
    candidate.status,
    /^[A-Za-z_]{1,64}$/u,
  )?.toUpperCase();
  if (
    id !== expected.id ||
    provider !== expected.provider ||
    userId !== expected.composioUserId
  ) {
    throw new Error("Composio connected-account revoke identity changed.");
  }
  return status === "REVOKED";
};

const isNotFound = (error: unknown) =>
  error instanceof ComposioUpstreamHttpError && error.status === 404;
const isAlreadyTerminalRevokeCandidate = (error: unknown) =>
  error instanceof ComposioUpstreamHttpError && error.status === 409;

const renewPurgeLease = async (ctx: ActionCtx, fence: PurgeFence) => {
  await ctx.runMutation(internal.owner_lifecycle.renewOwnerPurgeLeaseInternal, {
    ...fence,
    stage: "core",
    mode: "delete",
    now: Date.now(),
  });
};

const providerCall = async <T>(
  ctx: ActionCtx,
  fence: PurgeFence | null,
  call: () => Promise<T>,
): Promise<T> => {
  if (fence) await renewPurgeLease(ctx, fence);
  return await call();
};

const resolveSessionUsers = async (
  ctx: ActionCtx,
  fence: PurgeFence | null,
  locator: {
    sessionId: string;
    composioUserId?: string;
    composioUserIds?: readonly string[];
  },
  config: { apiKey: string; baseUrl: string },
): Promise<string[]> => {
  let remote: Record<string, unknown> | null = null;
  try {
    remote = await providerCall(ctx, fence, () =>
      composioFetch(
        `/session/${encodeURIComponent(locator.sessionId)}`,
        { method: "GET" },
        config,
        { maxResponseBytes: 64 * 1024 },
      ),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const remoteUser = remote ? composioSessionUserIdFromPayload(remote) : null;
  const candidates = Array.from(
    new Set(
      [locator.composioUserId, ...(locator.composioUserIds ?? [])].filter(
        (value): value is string =>
          typeof value === "string" && SAFE_EXTERNAL_ID.test(value),
      ),
    ),
  );
  if (
    locator.composioUserId &&
    remoteUser &&
    locator.composioUserId !== remoteUser
  ) {
    throw new Error("Composio session principal changed.");
  }
  if (remoteUser) {
    if (
      !SAFE_EXTERNAL_ID.test(remoteUser) ||
      (candidates.length > 0 && !candidates.includes(remoteUser))
    ) {
      throw new Error("Composio session principal changed.");
    }
    return [remoteUser];
  }
  if (candidates.length === 0) {
    throw new Error("Composio session principal is unavailable.");
  }
  return candidates;
};

const listConnectedAccountIds = async (
  ctx: ActionCtx,
  fence: PurgeFence | null,
  expected: { provider: string; composioUserId: string },
  config: { apiKey: string; baseUrl: string },
): Promise<string[]> => {
  const apiConfig = {
    ...config,
    baseUrl: composioToolsApiBaseUrl(config.baseUrl),
  };
  const ids = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    const params = new URLSearchParams({
      toolkit_slugs: expected.provider,
      user_ids: expected.composioUserId,
      limit: "50",
    });
    if (cursor) params.set("cursor", cursor);
    const payload = await providerCall(ctx, fence, () =>
      composioFetch(
        `/connected_accounts?${params.toString()}`,
        { method: "GET" },
        apiConfig,
        { maxResponseBytes: 512 * 1024 },
      ),
    );
    const parsed = connectedAccountIdsFromPayload(payload, expected);
    for (const id of parsed.ids) {
      ids.add(id);
      if (ids.size > MAX_CONNECTED_ACCOUNTS) {
        throw new Error(
          "Composio connected-account result exceeded its bound.",
        );
      }
    }
    if (!parsed.nextCursor) return [...ids];
    if (seenCursors.has(parsed.nextCursor)) {
      throw new Error("Composio repeated a connected-account cursor.");
    }
    seenCursors.add(parsed.nextCursor);
    cursor = parsed.nextCursor;
  }
  throw new Error("Composio connected-account pagination exceeded its bound.");
};

const deleteAndConfirm = async (
  ctx: ActionCtx,
  fence: PurgeFence | null,
  args: {
    path: string;
    confirmPath: string;
    config: { apiKey: string; baseUrl: string };
  },
) => {
  try {
    await providerCall(ctx, fence, () =>
      composioFetch(args.path, { method: "DELETE" }, args.config, {
        maxResponseBytes: 64 * 1024,
      }),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await providerCall(ctx, fence, () =>
      composioFetch(args.confirmPath, { method: "GET" }, args.config, {
        maxResponseBytes: 64 * 1024,
      }),
    );
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new Error("Composio deletion was not confirmed.");
};

const revokeDeleteAndConfirmConnectedAccount = async (
  ctx: ActionCtx,
  fence: PurgeFence | null,
  args: {
    accountId: string;
    provider: string;
    composioUserId: string;
    config: { apiKey: string; baseUrl: string };
  },
) => {
  const encoded = encodeURIComponent(args.accountId);
  const accountPath = `/connected_accounts/${encoded}`;
  try {
    // DELETE is a provider soft-delete and revoke_on_delete only queues a
    // background job. Synchronously revoke first, then prove REVOKED before
    // removing the account row.
    await providerCall(ctx, fence, () =>
      composioFetch(
        `${accountPath}/revoke`,
        { method: "POST", body: "{}" },
        args.config,
        { maxResponseBytes: 64 * 1024 },
      ),
    );
  } catch (error) {
    // A retry after a lost successful revoke response can return 409 because
    // the account is no longer revokable. Only the exact GET status readback
    // below may turn that into success; every other 409 remains fail-closed.
    if (!isNotFound(error) && !isAlreadyTerminalRevokeCandidate(error)) {
      throw error;
    }
  }

  try {
    const revoked = await providerCall(ctx, fence, () =>
      composioFetch(accountPath, { method: "GET" }, args.config, {
        maxResponseBytes: 64 * 1024,
      }),
    );
    if (
      !connectedAccountRevokedFromPayload(revoked, {
        id: args.accountId,
        provider: args.provider,
        composioUserId: args.composioUserId,
      })
    ) {
      throw new Error("Composio connected-account revoke was not confirmed.");
    }
  } catch (error) {
    // A row already absent after the synchronous revoke is terminal too.
    if (isNotFound(error)) return;
    throw error;
  }

  await deleteAndConfirm(ctx, fence, {
    path: `${accountPath}?revoke_on_delete=true`,
    confirmPath: accountPath,
    config: args.config,
  });
};

export const purgeComposioSessionAndConnectedAccounts = async (
  ctx: ActionCtx,
  fence: PurgeFence | null,
  locator: {
    provider: string;
    toolkit: string;
    sessionId?: string;
    composioUserId?: string;
    composioUserIds?: readonly string[];
  },
  config: { apiKey: string; baseUrl: string },
  beforeSessionDelete?: (composioUserId: string) => Promise<void>,
) => {
  if (
    !SAFE_PROVIDER.test(locator.provider) ||
    !SAFE_PROVIDER.test(locator.toolkit) ||
    !locator.sessionId ||
    !SAFE_EXTERNAL_ID.test(locator.sessionId)
  ) {
    throw new Error("Composio integration has no valid session locator.");
  }
  const composioUserIds = await resolveSessionUsers(
    ctx,
    fence,
    { ...locator, sessionId: locator.sessionId },
    config,
  );
  if (beforeSessionDelete && composioUserIds.length === 1) {
    await beforeSessionDelete(composioUserIds[0]!);
  }
  const apiConfig = {
    ...config,
    baseUrl: composioToolsApiBaseUrl(config.baseUrl),
  };
  // Invalidate every outstanding connect link and execution handle first. If
  // accounts were listed before session deletion, a user could complete an
  // already-issued link between the list and DELETE and leave an untracked
  // connected account behind.
  const sessionPath = `/session/${encodeURIComponent(locator.sessionId)}`;
  await deleteAndConfirm(ctx, fence, {
    path: sessionPath,
    confirmPath: sessionPath,
    config,
  });
  for (const composioUserId of composioUserIds) {
    const accountIds = await listConnectedAccountIds(
      ctx,
      fence,
      { provider: locator.toolkit, composioUserId },
      config,
    );
    for (const accountId of accountIds) {
      await revokeDeleteAndConfirmConnectedAccount(ctx, fence, {
        accountId,
        provider: locator.toolkit,
        composioUserId,
        config: apiConfig,
      });
    }
    const remainingAccountIds = await listConnectedAccountIds(
      ctx,
      fence,
      { provider: locator.toolkit, composioUserId },
      config,
    );
    if (remainingAccountIds.length > 0) {
      throw new Error("Composio connected-account deletion was not complete.");
    }
  }
};

/**
 * Roll back an unbound provisioning session without touching account-wide
 * user/toolkit credentials. Connected accounts are not session-attributable:
 * another valid session may intentionally share the same principal/toolkit.
 */
export const purgeComposioSessionOnly = async (
  ctx: ActionCtx,
  locator: {
    provider: string;
    toolkit: string;
    sessionId: string;
    composioUserId: string;
  },
  config: { apiKey: string; baseUrl: string },
) => {
  if (
    !SAFE_PROVIDER.test(locator.provider) ||
    !SAFE_PROVIDER.test(locator.toolkit) ||
    !SAFE_EXTERNAL_ID.test(locator.sessionId) ||
    !SAFE_EXTERNAL_ID.test(locator.composioUserId)
  ) {
    throw new Error("Composio provisioning cleanup locator is invalid.");
  }
  await resolveSessionUsers(ctx, null, locator, config);
  const sessionPath = `/session/${encodeURIComponent(locator.sessionId)}`;
  await deleteAndConfirm(ctx, null, {
    path: sessionPath,
    confirmPath: sessionPath,
    config,
  });
};

const purgeLocator = async (
  ctx: ActionCtx,
  fence: PurgeFence,
  locator: PurgeLocator,
  config: { apiKey: string; baseUrl: string },
) => {
  if (!locator.sessionId) {
    throw new Error("Composio integration has no valid session locator.");
  }
  let updatedAt = locator.updatedAt;
  await purgeComposioSessionAndConnectedAccounts(
    ctx,
    fence,
    locator,
    config,
    async (composioUserId) => {
      updatedAt = await ctx.runMutation(recordResolvedPrincipalRef, {
        ...fence,
        id: locator.id,
        provider: locator.provider,
        sessionId: locator.sessionId!,
        updatedAt,
        composioUserId,
        now: Date.now(),
      });
    },
  );
  await ctx.runMutation(acknowledgeRef, {
    ...fence,
    id: locator.id,
    provider: locator.provider,
    sessionId: locator.sessionId,
    updatedAt,
  });
};

/**
 * One bounded account-deletion pass. Reset intentionally preserves connected
 * integrations. Any ambiguous provider outcome retains the local locator so a
 * later pass can confirm 404 and safely finish.
 */
export const purgeOwnerComposioSessionsInternal = internalAction({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
  },
  returns: v.object({ ready: v.boolean(), pending: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const locators = (
      await ctx.runQuery(getBatchRef, {
        ownerId: args.ownerId,
      })
    ).slice(0, MAX_PURGE_BATCH);
    if (locators.length === 0) {
      const remaining = await ctx.runQuery(remainingRef, {
        ownerId: args.ownerId,
      });
      return { ready: remaining.length === 0, pending: remaining };
    }
    const configured = requireComposioConfig();
    if (!configured.config) {
      return {
        ready: false,
        pending: ["composio:provider_configuration_unavailable"],
      };
    }
    const pending: string[] = [];
    for (const locator of locators) {
      try {
        await purgeLocator(ctx, args, locator, configured.config);
      } catch {
        if (pending.length < MAX_PENDING_DETAILS) {
          pending.push(`composio:${locator.provider}:external_cleanup_pending`);
        }
      }
    }
    const remaining = await ctx.runQuery(remainingRef, {
      ownerId: args.ownerId,
    });
    for (const entry of remaining) {
      if (pending.length >= MAX_PENDING_DETAILS) break;
      if (!pending.includes(entry)) pending.push(entry);
    }
    return { ready: pending.length === 0, pending };
  },
});

/** Final strict readback for account deletion. */
export const remainingOwnerComposioSessionsInternal = internalAction({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args): Promise<string[]> =>
    await ctx.runQuery(remainingRef, args),
});
