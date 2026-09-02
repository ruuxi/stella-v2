// Owner-scoped teardown for the cloud stack.
//
// This exists because none of it was covered before. `account_deletion.ts` and
// `reset.ts` drained every OTHER owner-scoped table and left the entire
// `cloud_*` surface behind. The DO-resident transcript makes that worse if it
// goes unaddressed: the bytes live in Durable Object SQLite and R2, where
// Convex cannot reach them except by asking the DO. So deletion is a handshake,
// and it is driven from here.
//
// Everything below is idempotent, batched, and resumable: each mutation is its
// own transaction, each drain loops until it reports done, and the whole action
// re-runs cleanly after a failure at any point. It never reports success it did
// not achieve — `remainingOwnerStoresInternal` re-reads every store at the end,
// and `strict` turns anything left into a thrown error that keeps account
// deletion's durable gate open.
//
// ─── THE REGISTRY ────────────────────────────────────────────────────────────
//
// `OWNER_STORES` below is the list this module walks. It is the list, not a
// comment about the list: the count switch in `remainingOwnerStoresInternal`
// is keyed on it and is exhaustive, and `SIMPLE_TABLES` is statically checked
// against it, so a store added to the registry without a drain and a check
// fails to compile. A store that belongs to an owner and is not in the
// registry is a store account deletion does not reach — which is the whole
// class of defect this module exists to prevent, so add it here first.
//
// Stores outside Convex are enumerated in the table above `OwnerPurgeRequest`
// in workers/cloud-builder/src/index.ts, because only the worker holds the
// credentials for them. The two lists meet at `POST /owners/purge`.

import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v, type VLiteral } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { recordConversationTombstone } from "./cloud_apps";
import { deleteGithubInstallationGrant } from "./cloud_projects";
import { assertOwnerPurgeOperation } from "./owner_lifecycle";
import { deleteComponentR2ObjectsRef } from "./lib/component_r2_deletion";

/** Rows per transaction. Conservative — several tables cascade. */
const BATCH = 100;
/** Turns per transaction; each one also drains its events and invocations. */
const TURN_BATCH = 10;
/** Apps per transaction; each one also drains its builds and storage. */
const APP_BATCH = 5;
/**
 * Ceiling on any single drain loop. A loop that hits it has not failed — it
 * has run out of budget with rows untouched, which is a re-run, not a partial
 * delete. Reporting success on a truncated drain is the failure this module
 * exists to prevent, so the ceiling always reports pending.
 */
const MAX_PASSES = 200;

const logPurge = (event: string, fields: Record<string, unknown>): void => {
  console.warn(
    JSON.stringify({ service: "convex-cloud-purge", event, ...fields }),
  );
};

/**
 * How a store is reached, which is the only thing that decides what its drain
 * has to look like.
 *
 *  simple       — an owner index and nothing hanging off it. Delete the rows.
 *  cascade      — an owner index, but children that are only reachable THROUGH
 *                 the row: children first, parent last, or the children become
 *                 unreachable garbage.
 *  handshake    — the rows are an index; the data is in a Durable Object. Only
 *                 the DO can say its storage is gone, so the row is tombstoned
 *                 first and deleted only on the DO's word.
 *  bytes        — every row names an R2 object. Object first, row last: the row
 *                 is the only name the object has.
 *  external-ref — an owner index, but the row names state in the builder worker
 *                 (a KV checkpoint descriptor, a hosted route). Same rule as
 *                 `bytes`: the worker purge runs before the row is deleted.
 *  stopped      — must stop DOING something before it is drained. Schedules
 *                 spend money on a timer; a drain that merely gets there
 *                 eventually is not a fix.
 *  child        — no owner index at all. Reachable only through a parent, which
 *                 means the parent's drain owns it and the completeness check
 *                 for the parent covers it.
 *  global       — not owner-scoped. Listed so its absence is a decision.
 */
type StoreStyle =
  | "simple"
  | "cascade"
  | "handshake"
  | "bytes"
  | "external-ref"
  | "stopped"
  | "leased"
  | "child"
  | "global";

const OWNER_STORES = {
  // Fork/Rewind control receipts. A fork receipt can be the only locator for
  // an unpublished target DO, so the target handshake must finish before the
  // receipt row is removed.
  cloud_conversation_edits: "handshake",
  // The conversation index. Content lives in the OrchestratorSession DO and
  // its R2 segments; `purgeConversationInternal` is the handshake.
  cloud_conversations: "handshake",
  // Turns plus their event stream. Events now carry their own rolling owner
  // attribution so parent loss cannot hide them from strict purge/readback.
  agent_turns: "cascade",
  agent_events: "simple",
  // Singleton cursor/lease for rolling legacy-event attribution repair. It
  // carries no owner content and must survive every individual owner purge.
  agent_event_ownership_maintenance: "global",
  // A rolling-schema agent event can be owner-less and reachable only through
  // `sessionId === threadId`. Those children must be scanned before the thread
  // row disappears or strict readback loses the only remaining owner locator.
  cloud_agent_threads: "cascade",
  // Browser profile/session bytes live in the Gateway. Keep the interaction
  // receipts until the owner-level `default` profile purge is confirmed.
  cloud_browser_interactions: "external-ref",
  // Memory/Skills metadata all names bytes under the owner-derived R2
  // `agent-home/<hash>/` prefix. That whole prefix is swept first; every row
  // below is retained as locator/control debt until the worker confirms it.
  cloud_memory_lifecycles: "simple",
  cloud_memory_wipe_jobs: "simple",
  cloud_agent_home_docs: "external-ref",
  cloud_agent_home_preferences: "simple",
  cloud_agent_home_doc_versions: "external-ref",
  cloud_agent_home_write_intents: "external-ref",
  cloud_skills: "external-ref",
  cloud_skill_versions: "external-ref",
  cloud_skill_write_intents: "external-ref",
  cloud_skill_files: "external-ref",
  // Dual principal: an account may be a user of another owner's app. The
  // drain and completeness check cover both ownerId and userId indexes.
  cloud_app_storage: "simple",
  // Mini apps: build rows and the operation manifest cascade from the app, and
  // the app additionally names a hosted KV route and R2 build artifacts.
  cloud_apps: "external-ref",
  // Builds have their own owner index and name R2 artifact prefixes; this is
  // required to catch builds whose parent app row was lost. Operations and
  // invocations are owner-indexed too, so parent loss must not orphan them.
  cloud_app_builds: "external-ref",
  cloud_app_operations: "simple",
  cloud_app_op_invocations: "simple",
  // Per-owner Stella interior routing plus immutable candidates. Both name
  // R2 build prefixes, and the deployable also implies the owner's `stella`
  // sandbox checkpoint. External bytes go before either row.
  cloud_interior_deployables: "external-ref",
  cloud_interior_builds: "external-ref",
  // Recurring and one-shot turns. Stopped before anything else is touched.
  cloud_scheduled_turns: "stopped",
  // Same-transaction replay receipts for Schedule mutations. These are owner
  // data too: retaining one across reset would let a request from the old
  // generation appear to replay successfully against the new account state.
  cloud_schedule_receipts: "simple",
  // Exact-replay receipts for Code-safe connected reads. A current dispatch
  // lease means provider I/O is still in flight, so reset/delete waits for the
  // bounded lease instead of destroying the only ambiguity locator.
  cloud_integration_call_receipts: "leased",
  // The per-user drive. Bytes are in the bucket bound to the Convex R2
  // component — the builder worker has no binding for it, so unlike every
  // other R2 store this one is deleted from here.
  cloud_drive_files: "bytes",
  cloud_drive_uploads: "bytes",
  cloud_drive_usage: "simple",
  cloud_drive_deletions: "simple",
  // Encrypted OAuth tokens for the owner's own Claude/ChatGPT subscription,
  // plus the pending connect flows that carry a PKCE verifier.
  cloud_llm_credentials: "simple",
  cloud_engine_connects: "simple",
  cloud_engine_settings: "simple",
  // Read-only projection of the owner gate's dispatch rows. The gate owns
  // placement; deleting the projection removes nothing an executor observes.
  cloud_dispatches: "simple",
  // Cloud projects. Each names a sandbox checkpoint in the worker's KV whose
  // key hashes `<owner>:project:<slug>` and cannot be derived without the row.
  cloud_projects: "external-ref",
  cloud_github_installations: "external-ref",
  cloud_github_install_states: "external-ref",
  cloud_github_installation_deletions: "external-ref",
  // Deployment-wide failure windows, with no owner on them. Deliberately not
  // purged: deleting an account must not erase the operational record that the
  // deployment was failing.
  cloud_failure_alerts: "global",
  // The resurrection fence this module WRITES, in the same transaction that
  // deletes each index row. Deliberately not purged, and not owner-scoped: a
  // row is a random conversation UUID and the instant its DO confirmed its
  // storage was gone, with no owner, title, preview or text on it and — once
  // the index row above is deleted — nothing left in the deployment that maps
  // the id to a person. Deleting it here would delete the only thing stopping a
  // still-in-flight flush from re-creating what this module just removed.
  // `sweepConversationTombstonesInternal` retires it on its own clock.
  cloud_conversation_tombstones: "global",
} as const satisfies Record<string, StoreStyle>;

type OwnerStore = keyof typeof OWNER_STORES;
type StoresWithStyle<S extends StoreStyle> = {
  [K in OwnerStore]: (typeof OWNER_STORES)[K] extends S ? K : never;
}[OwnerStore];

/**
 * Tables reachable by a single owner index, with no children to cascade
 * through and no bytes outside Convex. Everything harder gets its own drain.
 */
const SIMPLE_TABLES = [
  "agent_events",
  "cloud_memory_lifecycles",
  "cloud_memory_wipe_jobs",
  "cloud_agent_home_preferences",
  "cloud_app_storage",
  "cloud_app_operations",
  "cloud_app_op_invocations",
  "cloud_schedule_receipts",
  "cloud_drive_usage",
  "cloud_drive_deletions",
  "cloud_llm_credentials",
  "cloud_engine_connects",
  "cloud_engine_settings",
  "cloud_dispatches",
] as const;

const LEASED_TABLES = ["cloud_integration_call_receipts"] as const;

const OWNER_INDEXED_TABLES = [...SIMPLE_TABLES, ...LEASED_TABLES] as const;

const AGENT_HOME_TABLES = [
  "cloud_agent_home_docs",
  "cloud_agent_home_doc_versions",
  "cloud_agent_home_write_intents",
  "cloud_skills",
  "cloud_skill_versions",
  "cloud_skill_write_intents",
  "cloud_skill_files",
] as const;

type AgentHomeTable = (typeof AGENT_HOME_TABLES)[number];

const purgeOperationArgs = {
  ownerId: v.string(),
  operationId: v.string(),
  generation: v.string(),
} as const;

type SimpleTable = (typeof SIMPLE_TABLES)[number];
type LeasedTable = (typeof LEASED_TABLES)[number];
type OwnerIndexedTable = (typeof OWNER_INDEXED_TABLES)[number];

// Static guard, in both directions: a store registered as "simple" that is not
// in `SIMPLE_TABLES` (or vice versa) stops this file type-checking. Without it
// the registry could claim coverage the drain does not have.
type _SimpleTablesMatchRegistry =
  SimpleTable extends StoresWithStyle<"simple">
    ? StoresWithStyle<"simple"> extends SimpleTable
      ? true
      : never
    : never;
const _simpleTablesInSync: _SimpleTablesMatchRegistry = true;
void _simpleTablesInSync;

type _LeasedTablesMatchRegistry =
  LeasedTable extends StoresWithStyle<"leased">
    ? StoresWithStyle<"leased"> extends LeasedTable
      ? true
      : never
    : never;
const _leasedTablesInSync: _LeasedTablesMatchRegistry = true;
void _leasedTablesInSync;

const drainOwnerIndexedTable = async (
  ctx: MutationCtx,
  ownerId: string,
  table: OwnerIndexedTable,
): Promise<number> => {
  let ids: Id<OwnerIndexedTable>[] = [];
  switch (table) {
    case "agent_events": {
      const rows = await ctx.db
        .query("agent_events")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_memory_lifecycles": {
      const rows = await ctx.db
        .query("cloud_memory_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_memory_wipe_jobs": {
      const rows = await ctx.db
        .query("cloud_memory_wipe_jobs")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_agent_home_preferences": {
      const rows = await ctx.db
        .query("cloud_agent_home_preferences")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_app_storage": {
      const owned = await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      const used = await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_userId_and_updatedAt", (q) => q.eq("userId", ownerId))
        .take(BATCH);
      ids = [
        ...new Map([...owned, ...used].map((row) => [row._id, row])).values(),
      ]
        .slice(0, BATCH)
        .map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_app_operations": {
      const rows = await ctx.db
        .query("cloud_app_operations")
        .withIndex("by_ownerId_and_appId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_app_op_invocations": {
      const rows = await ctx.db
        .query("cloud_app_op_invocations")
        .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_schedule_receipts": {
      const rows = await ctx.db
        .query("cloud_schedule_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_integration_call_receipts": {
      const now = Date.now();
      const rows = await ctx.db
        .query("cloud_integration_call_receipts")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      // Defense in depth: the orchestrator performs an indexed preflight, but
      // this mutation itself must never erase a still-live ambiguity locator.
      ids = rows
        .filter(
          (row) =>
            row.state !== "dispatching" ||
            (row.leaseExpiresAt !== undefined && row.leaseExpiresAt <= now),
        )
        .map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_drive_usage": {
      const rows = await ctx.db
        .query("cloud_drive_usage")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_drive_deletions": {
      const rows = await ctx.db
        .query("cloud_drive_deletions")
        .withIndex("by_ownerId_and_deletedAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_llm_credentials": {
      // Encrypted refresh tokens for the owner's own model subscription. They
      // outlive the access token by design, so nothing but this deletes them.
      const rows = await ctx.db
        .query("cloud_llm_credentials")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_engine_connects": {
      const rows = await ctx.db
        .query("cloud_engine_connects")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_engine_settings": {
      const rows = await ctx.db
        .query("cloud_engine_settings")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    case "cloud_dispatches": {
      const rows = await ctx.db
        .query("cloud_dispatches")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<OwnerIndexedTable>[];
      break;
    }
    default: {
      const exhaustive: never = table;
      throw new Error(`Unhandled cloud table: ${String(exhaustive)}`);
    }
  }
  await Promise.all(ids.map((id) => ctx.db.delete(id)));
  return ids.length;
};

export const deleteOwnerCloudBatch = internalMutation({
  args: {
    ...purgeOperationArgs,
    table: v.union(
      ...(OWNER_INDEXED_TABLES.map((table) => v.literal(table)) as [
        VLiteral<OwnerIndexedTable>,
        VLiteral<OwnerIndexedTable>,
        ...VLiteral<OwnerIndexedTable>[],
      ]),
    ),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const deleted = await drainOwnerIndexedTable(ctx, args.ownerId, args.table);
    return { hasMore: deleted === BATCH };
  },
});

export const deleteOwnerBrowserInteractionBatchInternal = internalMutation({
  args: purgeOperationArgs,
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const rows = await ctx.db
      .query("cloud_browser_interactions")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    return { hasMore: rows.length === BATCH };
  },
});

/**
 * Cascades rolling-schema agent events before deleting their last owner
 * locator, the spawned-agent thread.
 *
 * Current events carry ownerId and the ordinary owner-indexed drain owns them.
 * A legacy event may not. When its exact turn is already gone, the migration
 * contract attributes `sessionId === threadId` to the durable thread. This
 * paginated mutation applies the same rule during reset/delete and deletes the
 * thread only in the transaction that observes the final page. A legacy row
 * with a surviving mismatched/foreign turn is protected: that exact turn, not
 * a coincidental session id, remains authoritative for its lifecycle.
 */
export const deleteOwnerAgentThreadCascadeBatchInternal = internalMutation({
  args: {
    ...purgeOperationArgs,
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    hasThread: v.boolean(),
    completedThread: v.boolean(),
    deletedEvents: v.number(),
    protectedEvents: v.number(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .first();
    if (!thread) {
      return {
        hasThread: false,
        completedThread: false,
        deletedEvents: 0,
        protectedEvents: 0,
        cursor: null,
      };
    }

    const persistedCursorMatchesFence =
      thread.legacyEventPurgeOperationId === args.operationId &&
      thread.legacyEventPurgeGeneration === args.generation;
    const effectiveCursor = persistedCursorMatchesFence
      ? (thread.legacyEventPurgeCursor ?? args.cursor)
      : args.cursor;
    const page = await ctx.db
      .query("agent_events")
      .withIndex("by_sessionId_and_ownerId_and_createdAt", (q) =>
        q.eq("sessionId", thread.threadId).eq("ownerId", undefined),
      )
      .paginate({ cursor: effectiveCursor, numItems: BATCH });
    let deletedEvents = 0;
    let protectedEvents = 0;
    for (const event of page.page) {
      const exactTurn = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", event.turnId))
        .unique();
      if (
        !exactTurn ||
        (exactTurn.ownerId === args.ownerId &&
          exactTurn.sessionId === event.sessionId)
      ) {
        await ctx.db.delete(event._id);
        deletedEvents += 1;
      } else {
        protectedEvents += 1;
      }
    }

    if (page.isDone) {
      // Reset the persisted continuation explicitly before retiring its
      // parent. The delete is the durable end-of-scan marker; the clear makes
      // the lifecycle transition unambiguous if this code is later split.
      await ctx.db.patch(thread._id, {
        legacyEventPurgeCursor: undefined,
        legacyEventPurgeOperationId: undefined,
        legacyEventPurgeGeneration: undefined,
      });
      await ctx.db.delete(thread._id);
      return {
        hasThread: true,
        completedThread: true,
        deletedEvents,
        protectedEvents,
        cursor: null,
      };
    }
    await ctx.db.patch(thread._id, {
      legacyEventPurgeCursor: page.continueCursor,
      legacyEventPurgeOperationId: args.operationId,
      legacyEventPurgeGeneration: args.generation,
    });
    return {
      hasThread: true,
      completedThread: false,
      deletedEvents,
      protectedEvents,
      cursor: page.continueCursor,
    };
  },
});

/**
 * Indexed, bounded quiescence check for Code-safe connected-tool calls.
 * Claims are lifecycle/generation fenced when created, so once the purge fence
 * is visible no new receipt can enter dispatching. Missing lease metadata is
 * malformed durable debt and therefore fails closed instead of being erased.
 */
export const getOwnerIntegrationCallQuiescenceInternal = internalQuery({
  args: { ownerId: v.string(), now: v.number() },
  returns: v.object({
    ready: v.boolean(),
    nextCheckAt: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const [missingLease, liveLease] = await Promise.all([
      ctx.db
        .query("cloud_integration_call_receipts")
        .withIndex("by_ownerId_state_leaseExpiresAt", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("state", "dispatching")
            .eq("leaseExpiresAt", undefined),
        )
        .first(),
      ctx.db
        .query("cloud_integration_call_receipts")
        .withIndex("by_ownerId_state_leaseExpiresAt", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("state", "dispatching")
            .gt("leaseExpiresAt", args.now),
        )
        .first(),
    ]);
    if (missingLease) return { ready: false };
    if (liveLease) {
      return { ready: false, nextCheckAt: liveLease.leaseExpiresAt };
    }
    return { ready: true };
  },
});

export const quiesceOwnerIntegrationCalls = async (
  ctx: ActionCtx,
  ownerId: string,
): Promise<{ ready: boolean; nextCheckAt?: number }> => {
  const result: { ready: boolean; nextCheckAt?: number } = await ctx.runQuery(
    internal.cloud_purge.getOwnerIntegrationCallQuiescenceInternal,
    { ownerId, now: Date.now() },
  );
  return result;
};

const drainAgentHomeTable = async (
  ctx: MutationCtx,
  ownerId: string,
  table: AgentHomeTable,
): Promise<number> => {
  let ids: Id<AgentHomeTable>[] = [];
  switch (table) {
    case "cloud_agent_home_docs":
      ids = (
        await ctx.db
          .query(table)
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(BATCH)
      ).map((row) => row._id) as Id<AgentHomeTable>[];
      break;
    case "cloud_agent_home_doc_versions":
    case "cloud_skill_versions":
      ids = (
        await ctx.db
          .query(table)
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(BATCH)
      ).map((row) => row._id) as Id<AgentHomeTable>[];
      break;
    case "cloud_agent_home_write_intents":
    case "cloud_skill_write_intents":
      ids = (
        await ctx.db
          .query(table)
          .withIndex("by_ownerId_and_idempotencyKey", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(BATCH)
      ).map((row) => row._id) as Id<AgentHomeTable>[];
      break;
    case "cloud_skills":
      ids = (
        await ctx.db
          .query(table)
          .withIndex("by_ownerId_and_name", (q) => q.eq("ownerId", ownerId))
          .take(BATCH)
      ).map((row) => row._id) as Id<AgentHomeTable>[];
      break;
    case "cloud_skill_files":
      ids = (
        await ctx.db
          .query(table)
          .withIndex("by_ownerId_and_skillId", (q) => q.eq("ownerId", ownerId))
          .take(BATCH)
      ).map((row) => row._id) as Id<AgentHomeTable>[];
      break;
    default: {
      const exhaustive: never = table;
      throw new Error(`Unhandled agent-home table: ${String(exhaustive)}`);
    }
  }
  await Promise.all(ids.map((id) => ctx.db.delete(id)));
  return ids.length;
};

export const deleteOwnerAgentHomeBatch = internalMutation({
  args: {
    ...purgeOperationArgs,
    table: v.union(
      ...(AGENT_HOME_TABLES.map((table) => v.literal(table)) as [
        VLiteral<AgentHomeTable>,
        VLiteral<AgentHomeTable>,
        ...VLiteral<AgentHomeTable>[],
      ]),
    ),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const deleted = await drainAgentHomeTable(ctx, args.ownerId, args.table);
    return { hasMore: deleted === BATCH };
  },
});

// ─── Fork/Rewind control receipts ──────────────────────────────────────────

const conversationEditPurgeRef = v.object({
  id: v.id("cloud_conversation_edits"),
  editOperationId: v.string(),
  targetConversationId: v.optional(v.string()),
});

export const listOwnerConversationEditPurgeBatchInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(conversationEditPurgeRef),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_conversation_edits")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(BATCH);
    return rows.map((row) => ({
      id: row._id,
      editOperationId: row.operationId,
      ...(row.targetConversationId
        ? { targetConversationId: row.targetConversationId }
        : {}),
    }));
  },
});

/** Deletes only the exact receipt whose target was just confirmed purged. */
export const deleteConfirmedConversationEditInternal = internalMutation({
  args: {
    ...purgeOperationArgs,
    ref: conversationEditPurgeRef,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const row = await ctx.db.get(args.ref.id);
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.operationId !== args.ref.editOperationId ||
      row.targetConversationId !== args.ref.targetConversationId
    ) {
      return false;
    }
    await ctx.db.delete(row._id);
    return true;
  },
});

/**
 * Turns cascade: each carries its event stream and any app-operation
 * invocations it created. Children go first, and the turn row is only retired
 * once its last child is gone — an orphaned event row can never be found
 * again, because every index into it starts at the turn.
 */
export const deleteOwnerTurnBatch = internalMutation({
  args: purgeOperationArgs,
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const turns = await ctx.db
      .query("agent_turns")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(TURN_BATCH);
    if (turns.length === 0) return { hasMore: false };
    for (const turn of turns) {
      const events = await ctx.db
        .query("agent_events")
        .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", turn.turnId))
        .take(BATCH);
      for (const event of events) await ctx.db.delete(event._id);
      if (events.length === BATCH) return { hasMore: true };

      const invocations = await ctx.db
        .query("cloud_app_op_invocations")
        .withIndex("by_turnId", (q) => q.eq("turnId", turn.turnId))
        .take(BATCH);
      for (const invocation of invocations) await ctx.db.delete(invocation._id);
      if (invocations.length === BATCH) return { hasMore: true };

      await ctx.db.delete(turn._id);
    }
    return { hasMore: true };
  },
});

// ─── Mini apps ───────────────────────────────────────────────────────────────

/**
 * What the builder worker must delete before these app rows may go: the hosted
 * route that still serves the app, and the R2 prefix holding its built code.
 * Neither is addressable from the owner id — the route is keyed by slug and
 * the artifacts by build id — so the rows are read first and deleted last.
 */
export const listOwnerAppPurgeManifestInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.object({
    hasRows: v.boolean(),
    slugs: v.array(v.string()),
    buildPrefixes: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const apps = await ctx.db
      .query("cloud_apps")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(APP_BATCH);
    // Query by owner, not only through the app rows: build callbacks written
    // before an app-row failure can otherwise leave an orphan artifact prefix.
    const builds = await ctx.db
      .query("cloud_app_builds")
      .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(BATCH);
    const buildPrefixes = builds.flatMap((build) =>
      build.artifactPrefix ? [build.artifactPrefix] : [],
    );
    return {
      hasRows: apps.length > 0 || builds.length > 0,
      slugs: apps.map((app) => app.slug),
      buildPrefixes,
    };
  },
});

/** Deletes owner-indexed build locators only after their exact prefix is gone. */
export const deleteOwnerAppBuildBatch = internalMutation({
  args: {
    ...purgeOperationArgs,
    purgedPrefixes: v.array(v.string()),
  },
  returns: v.object({ hasMore: v.boolean(), deleted: v.number() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const purged = new Set(args.purgedPrefixes);
    const builds = await ctx.db
      .query("cloud_app_builds")
      .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(BATCH);
    let deleted = 0;
    for (const build of builds) {
      if (build.artifactPrefix && !purged.has(build.artifactPrefix)) continue;
      await ctx.db.delete(build._id);
      deleted += 1;
    }
    return {
      hasMore: builds.length === BATCH || deleted !== builds.length,
      deleted,
    };
  },
});

/**
 * One app and everything hanging off it.
 *
 * `purgedPrefixes` is the set the worker just confirmed gone, and a build row
 * is only deleted if its artifacts were in it. Without that check a build that
 * finished between the manifest read and this call would have its row deleted
 * with its code still in R2 and nothing left naming it.
 */
export const deleteOwnerAppBatch = internalMutation({
  args: {
    ...purgeOperationArgs,
    purgedPrefixes: v.array(v.string()),
  },
  returns: v.object({ hasMore: v.boolean(), deleted: v.number() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const purged = new Set(args.purgedPrefixes);
    const apps = await ctx.db
      .query("cloud_apps")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(APP_BATCH);
    if (apps.length === 0) return { hasMore: false, deleted: 0 };
    let deleted = 0;
    for (const app of apps) {
      const builds = await ctx.db
        .query("cloud_app_builds")
        .withIndex("by_appId_and_createdAt", (q) => q.eq("appId", app.appId))
        .take(BATCH);
      let heldBack = 0;
      for (const build of builds) {
        if (build.artifactPrefix && !purged.has(build.artifactPrefix)) {
          heldBack += 1;
          continue;
        }
        await ctx.db.delete(build._id);
        deleted += 1;
      }
      // Stop here rather than deleting the app row: the next pass re-reads the
      // manifest, so the artifact prefixes of the builds still below — and of
      // any build that landed since — are purged from R2 before their rows go.
      if (builds.length === BATCH || heldBack > 0) {
        return { hasMore: true, deleted };
      }

      const manifest = await ctx.db
        .query("cloud_app_operations")
        .withIndex("by_appId", (q) => q.eq("appId", app.appId))
        .unique();
      if (manifest) {
        await ctx.db.delete(manifest._id);
        deleted += 1;
      }

      const invocations = await ctx.db
        .query("cloud_app_op_invocations")
        .withIndex("by_appId_and_status_and_createdAt", (q) =>
          q.eq("appId", app.appId),
        )
        .take(BATCH);
      for (const invocation of invocations) await ctx.db.delete(invocation._id);
      deleted += invocations.length;
      if (invocations.length === BATCH) return { hasMore: true, deleted };

      const storage = await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_appId_and_userId", (q) => q.eq("appId", app.appId))
        .take(BATCH);
      for (const row of storage) await ctx.db.delete(row._id);
      deleted += storage.length;
      if (storage.length === BATCH) return { hasMore: true, deleted };

      await ctx.db.delete(app._id);
      deleted += 1;
    }
    return { hasMore: true, deleted };
  },
});

// ─── Stella interior deployments ────────────────────────────────────────────

/**
 * The exact external state named by one owner's interior deployment. Build
 * prefixes are read from their immutable rows. The owner-level purge later in
 * this action independently removes the owner's world checkpoint, which holds
 * the interior source.
 */
export const listOwnerInteriorPurgeManifestInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.object({
    hasRows: v.boolean(),
    buildPrefixes: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const deployment = await ctx.db
      .query("cloud_interior_deployables")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    const builds = await ctx.db
      .query("cloud_interior_builds")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(BATCH);
    const hasRows = Boolean(deployment) || builds.length > 0;
    return {
      hasRows,
      buildPrefixes: [...new Set(builds.map((build) => build.artifactPrefix))],
    };
  },
});

/**
 * Deletes only candidates whose artifact prefixes the builder just confirmed
 * gone. A candidate inserted after the manifest read is held for the next
 * pass, preserving the same row-last fencing used by mini-app builds.
 */
export const deleteOwnerInteriorDeploymentBatch = internalMutation({
  args: {
    ...purgeOperationArgs,
    purgedPrefixes: v.array(v.string()),
  },
  returns: v.object({ hasMore: v.boolean(), deleted: v.number() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const purged = new Set(args.purgedPrefixes);
    const builds = await ctx.db
      .query("cloud_interior_builds")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(BATCH);
    let deleted = 0;
    let heldBack = 0;
    for (const build of builds) {
      if (!purged.has(build.artifactPrefix)) {
        heldBack += 1;
        continue;
      }
      await ctx.db.delete(build._id);
      deleted += 1;
    }
    if (builds.length === BATCH || heldBack > 0) {
      return { hasMore: true, deleted };
    }
    const remainingBuild = await ctx.db
      .query("cloud_interior_builds")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(1);
    if (remainingBuild.length > 0) {
      return { hasMore: true, deleted };
    }
    const deployment = await ctx.db
      .query("cloud_interior_deployables")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (deployment) {
      await ctx.db.delete(deployment._id);
      deleted += 1;
    }
    return { hasMore: false, deleted };
  },
});

// ─── Projects ────────────────────────────────────────────────────────────────

/**
 * A project checkout lives in the owner's one world checkpoint, which the
 * owner-level step at the end of this action drops whole. Nothing external is
 * keyed by the slug any more, so these rows are ordinary owner-indexed rows.
 */
export const deleteOwnerProjectBatch = internalMutation({
  args: purgeOperationArgs,
  returns: v.object({ hasMore: v.boolean(), deleted: v.number() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const rows = await ctx.db
      .query("cloud_projects")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(BATCH);
    let deleted = 0;
    for (const row of rows) {
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    return { hasMore: rows.length === BATCH, deleted };
  },
});

// ─── GitHub App installations ───────────────────────────────────────────────

export const listOwnerGithubPurgeManifestInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.object({
    hasRows: v.boolean(),
    installationIds: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const [installations, states, debts, projects] = await Promise.all([
      ctx.db
        .query("cloud_github_installations")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .take(BATCH),
      ctx.db
        .query("cloud_github_install_states")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .take(BATCH),
      ctx.db
        .query("cloud_github_installation_deletions")
        .withIndex("by_ownerId_and_nextRetryAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .take(BATCH),
      ctx.db
        .query("cloud_projects")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .take(BATCH),
    ]);
    const installationIds = new Set<string>();
    for (const row of installations) installationIds.add(row.installationId);
    for (const row of states) {
      if (row.installationId) installationIds.add(row.installationId);
    }
    for (const row of debts) installationIds.add(row.installationId);
    for (const row of projects) {
      if (row.installationId) installationIds.add(row.installationId);
    }
    return {
      hasRows:
        installations.length > 0 || states.length > 0 || debts.length > 0,
      installationIds: [...installationIds],
    };
  },
});

/** Publish durable remote-deletion debt before making the GitHub API call. */
export const stageOwnerGithubInstallationDeletionsInternal = internalMutation({
  args: {
    ...purgeOperationArgs,
    installationIds: v.array(v.string()),
    now: v.number(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const staged: string[] = [];
    for (const installationId of [...new Set(args.installationIds)]) {
      if (!/^[0-9]{1,20}$/.test(installationId)) continue;
      const existing = await ctx.db
        .query("cloud_github_installation_deletions")
        .withIndex("by_installationId", (q) =>
          q.eq("installationId", installationId),
        )
        .unique();
      if (existing) {
        if (existing.ownerId !== args.ownerId) {
          throw new Error("GitHub deletion debt belongs to another owner.");
        }
        await ctx.db.patch(existing._id, {
          operationId: args.operationId,
          generation: args.generation,
          attempts: existing.attempts + 1,
          nextRetryAt: args.now,
          lastError: undefined,
          updatedAt: args.now,
        });
      } else {
        await ctx.db.insert("cloud_github_installation_deletions", {
          ownerId: args.ownerId,
          installationId,
          operationId: args.operationId,
          generation: args.generation,
          attempts: 1,
          nextRetryAt: args.now,
          createdAt: args.now,
          updatedAt: args.now,
        });
      }
      staged.push(installationId);
    }
    return staged;
  },
});

/** Row-last acknowledgement after GitHub returned terminal 204/404. */
export const finishOwnerGithubInstallationDeletionInternal = internalMutation({
  args: {
    ...purgeOperationArgs,
    installationId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const debt = await ctx.db
      .query("cloud_github_installation_deletions")
      .withIndex("by_installationId", (q) =>
        q.eq("installationId", args.installationId),
      )
      .unique();
    if (
      !debt ||
      debt.ownerId !== args.ownerId ||
      debt.operationId !== args.operationId ||
      debt.generation !== args.generation
    ) {
      throw new Error("GitHub installation deletion was not durably staged.");
    }

    const installation = await ctx.db
      .query("cloud_github_installations")
      .withIndex("by_installationId", (q) =>
        q.eq("installationId", args.installationId),
      )
      .unique();
    if (installation?.ownerId === args.ownerId) {
      await ctx.db.delete(installation._id);
    }
    const states = await ctx.db
      .query("cloud_github_install_states")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .take(BATCH);
    for (const state of states) {
      if (state.installationId === args.installationId) {
        await ctx.db.delete(state._id);
      }
    }
    await ctx.db.delete(debt._id);
    return null;
  },
});

/** Pending install states without an installation handle have no remote grant. */
export const deleteOwnerGithubHandlelessStatesInternal = internalMutation({
  args: purgeOperationArgs,
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const states = await ctx.db
      .query("cloud_github_install_states")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .take(BATCH);
    let deleted = 0;
    for (const state of states) {
      if (state.installationId && /^[0-9]{1,20}$/.test(state.installationId)) {
        continue;
      }
      await ctx.db.delete(state._id);
      deleted += 1;
    }
    return { hasMore: states.length === BATCH || deleted !== states.length };
  },
});

// ─── Drive ───────────────────────────────────────────────────────────────────

const driveObjectRow = v.union(
  v.object({
    kind: v.literal("file"),
    id: v.id("cloud_drive_files"),
    r2Key: v.string(),
  }),
  v.object({
    kind: v.literal("upload"),
    id: v.id("cloud_drive_uploads"),
    r2Key: v.string(),
    expiresAt: v.number(),
  }),
);

/**
 * The drive is the one R2 store the builder worker cannot reach: its bucket is
 * bound to the Convex R2 component, not to the worker. So it is drained here,
 * row by row, object first — the row is the only record of the key, exactly as
 * with other component-owned R2 objects.
 *
 * Pending uploads are included: a presigned PUT that landed and was never
 * finalized has bytes in the bucket with only this row naming them.
 */
export const listOwnerDriveObjectsInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(driveObjectRow),
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("cloud_drive_files")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(BATCH);
    if (files.length > 0) {
      return files.map((row) => ({
        kind: "file" as const,
        id: row._id,
        r2Key: row.r2Key,
      }));
    }
    const uploads = await ctx.db
      .query("cloud_drive_uploads")
      .withIndex("by_ownerId_and_path", (q) => q.eq("ownerId", args.ownerId))
      .take(BATCH);
    return uploads.map((row) => ({
      kind: "upload" as const,
      id: row._id,
      r2Key: row.r2Key,
      expiresAt: row.expiresAt,
    }));
  },
});

export const deleteDriveRowsInternal = internalMutation({
  args: {
    ...purgeOperationArgs,
    rows: v.array(driveObjectRow),
    now: v.number(),
  },
  returns: v.object({ deleted: v.number(), deferred: v.number() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    let deleted = 0;
    let deferred = 0;
    for (const candidate of args.rows) {
      if (candidate.kind === "file") {
        const current = await ctx.db.get(candidate.id);
        if (
          current?.ownerId === args.ownerId &&
          current.r2Key === candidate.r2Key
        ) {
          await ctx.db.delete(current._id);
          deleted += 1;
        }
        continue;
      }
      const current = await ctx.db.get(candidate.id);
      if (
        current?.ownerId !== args.ownerId ||
        current.r2Key !== candidate.r2Key
      ) {
        continue;
      }
      // A signed PUT cannot be revoked. Keep its locator and repeat object
      // deletion until the URL has expired; deleting the row earlier would
      // let a late PUT recreate bytes that no database row can name.
      if (current.expiresAt > args.now) {
        deferred += 1;
        continue;
      }
      await ctx.db.delete(current._id);
      deleted += 1;
    }
    return { deleted, deferred };
  },
});

// ─── Conversations ───────────────────────────────────────────────────────────

/** Conversation index rows, including tombstones the DO already purged. */
export const listOwnerConversationsInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(
    v.object({ conversationId: v.string(), purged: v.boolean() }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(25);
    return rows.map((row) => ({
      conversationId: row.conversationId,
      purged: row.purgedAt !== undefined,
    }));
  },
});

/**
 * The index row carries `ownerId`, so account deletion has to delete it — the
 * per-conversation delete's habit of keeping a stripped row is not available
 * here. But that row is also what made a late index flush from a DO that was
 * resident at purge time hit `upsertConversationIndexInternal`'s "already
 * tombstoned" refusal instead of its `!row` self-heal INSERT.
 *
 * So the fence moves to `cloud_conversation_tombstones` in the SAME
 * transaction. Two separate mutations would leave a window in which neither
 * record exists, and that window is precisely when a retried flush lands. It
 * would re-insert the deleted owner's conversation row under an owner id that
 * no longer exists.
 */
export const deleteConversationIndexRowInternal = internalMutation({
  args: { ...purgeOperationArgs, conversationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    await recordConversationTombstone(ctx, args.conversationId, Date.now());
    const row = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
    if (row?.ownerId === args.ownerId) await ctx.db.delete(row._id);
    return null;
  },
});

// ─── Completeness ────────────────────────────────────────────────────────────

/**
 * Re-reads every owner-scoped Convex store and names the ones that still hold
 * rows. This is what makes "deletion finished" a checked claim rather than the
 * absence of a thrown error: a drain that was truncated, a row written by a
 * turn that raced the purge, or a store someone forgot to drain all show up
 * here, and `strict` turns that into a refusal to finish the deletion.
 *
 * The switch is exhaustive over the registry, so a new store cannot be added
 * without deciding how its completeness is checked.
 */
export const remainingOwnerStoresInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const { ownerId } = args;
    const remaining: string[] = [];
    const check = async (
      store: OwnerStore,
      any: () => Promise<{ length: number }>,
    ): Promise<void> => {
      if ((await any()).length > 0) remaining.push(store);
    };
    for (const store of Object.keys(OWNER_STORES) as OwnerStore[]) {
      switch (store) {
        case "cloud_conversation_edits":
          await check(store, () =>
            ctx.db
              .query("cloud_conversation_edits")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_conversations":
          await check(store, () =>
            ctx.db
              .query("cloud_conversations")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "agent_turns":
          await check(store, () =>
            ctx.db
              .query("agent_turns")
              .withIndex("by_ownerId_and_createdAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_agent_threads":
          await check(store, () =>
            ctx.db
              .query("cloud_agent_threads")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_browser_interactions":
          await check(store, () =>
            ctx.db
              .query("cloud_browser_interactions")
              .withIndex("by_ownerId_and_createdAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_memory_lifecycles":
          await check(store, () =>
            ctx.db
              .query("cloud_memory_lifecycles")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
              .take(1),
          );
          break;
        case "cloud_memory_wipe_jobs":
          await check(store, () =>
            ctx.db
              .query("cloud_memory_wipe_jobs")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
              .take(1),
          );
          break;
        case "cloud_agent_home_preferences":
          await check(store, () =>
            ctx.db
              .query("cloud_agent_home_preferences")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
              .take(1),
          );
          break;
        case "cloud_agent_home_docs":
          await check(store, () =>
            ctx.db
              .query("cloud_agent_home_docs")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_agent_home_doc_versions":
          await check(store, () =>
            ctx.db
              .query("cloud_agent_home_doc_versions")
              .withIndex("by_ownerId_and_createdAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_agent_home_write_intents":
          await check(store, () =>
            ctx.db
              .query("cloud_agent_home_write_intents")
              .withIndex("by_ownerId_and_idempotencyKey", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_skills":
          await check(store, () =>
            ctx.db
              .query("cloud_skills")
              .withIndex("by_ownerId_and_name", (q) => q.eq("ownerId", ownerId))
              .take(1),
          );
          break;
        case "cloud_skill_versions":
          await check(store, () =>
            ctx.db
              .query("cloud_skill_versions")
              .withIndex("by_ownerId_and_createdAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_skill_write_intents":
          await check(store, () =>
            ctx.db
              .query("cloud_skill_write_intents")
              .withIndex("by_ownerId_and_idempotencyKey", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_skill_files":
          await check(store, () =>
            ctx.db
              .query("cloud_skill_files")
              .withIndex("by_ownerId_and_skillId", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_app_storage": {
          const [owned, used] = await Promise.all([
            ctx.db
              .query("cloud_app_storage")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
            ctx.db
              .query("cloud_app_storage")
              .withIndex("by_userId_and_updatedAt", (q) =>
                q.eq("userId", ownerId),
              )
              .take(1),
          ]);
          if (owned.length > 0 || used.length > 0) remaining.push(store);
          break;
        }
        case "cloud_apps":
          await check(store, () =>
            ctx.db
              .query("cloud_apps")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_app_builds":
          await check(store, () =>
            ctx.db
              .query("cloud_app_builds")
              .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_app_operations":
          await check(store, () =>
            ctx.db
              .query("cloud_app_operations")
              .withIndex("by_ownerId_and_appId", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_app_op_invocations":
          await check(store, () =>
            ctx.db
              .query("cloud_app_op_invocations")
              .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_interior_deployables":
          await check(store, () =>
            ctx.db
              .query("cloud_interior_deployables")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
              .take(1),
          );
          break;
        case "cloud_interior_builds":
          await check(store, () =>
            ctx.db
              .query("cloud_interior_builds")
              .withIndex("by_ownerId_and_createdAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_scheduled_turns":
          await check(store, () =>
            ctx.db
              .query("cloud_scheduled_turns")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_schedule_receipts":
          await check(store, () =>
            ctx.db
              .query("cloud_schedule_receipts")
              .withIndex("by_ownerId_and_createdAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_integration_call_receipts":
          await check(store, () =>
            ctx.db
              .query("cloud_integration_call_receipts")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_drive_files":
          await check(store, () =>
            ctx.db
              .query("cloud_drive_files")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_drive_uploads":
          await check(store, () =>
            ctx.db
              .query("cloud_drive_uploads")
              .withIndex("by_ownerId_and_path", (q) => q.eq("ownerId", ownerId))
              .take(1),
          );
          break;
        case "cloud_drive_usage":
          await check(store, () =>
            ctx.db
              .query("cloud_drive_usage")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
              .take(1),
          );
          break;
        case "cloud_drive_deletions":
          await check(store, () =>
            ctx.db
              .query("cloud_drive_deletions")
              .withIndex("by_ownerId_and_deletedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_llm_credentials":
          await check(store, () =>
            ctx.db
              .query("cloud_llm_credentials")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
              .take(1),
          );
          break;
        case "cloud_engine_connects":
          await check(store, () =>
            ctx.db
              .query("cloud_engine_connects")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
              .take(1),
          );
          break;
        case "cloud_engine_settings":
          await check(store, () =>
            ctx.db
              .query("cloud_engine_settings")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
              .take(1),
          );
          break;
        case "cloud_dispatches":
          await check(store, () =>
            ctx.db
              .query("cloud_dispatches")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_projects":
          await check(store, () =>
            ctx.db
              .query("cloud_projects")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_github_installations":
          await check(store, () =>
            ctx.db
              .query("cloud_github_installations")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_github_install_states":
          await check(store, () =>
            ctx.db
              .query("cloud_github_install_states")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
              .take(1),
          );
          break;
        case "cloud_github_installation_deletions":
          await check(store, () =>
            ctx.db
              .query("cloud_github_installation_deletions")
              .withIndex("by_ownerId_and_nextRetryAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "agent_events":
          await check(store, () =>
            ctx.db
              .query("agent_events")
              .withIndex("by_ownerId_and_createdAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "agent_event_ownership_maintenance":
        // Deployment-wide, with no owner on the row.
        case "cloud_failure_alerts":
        // Owner-free by construction, and written BY this purge. Checking it
        // for remaining rows would report every conversation this owner ever
        // deleted as an unfinished drain.
        case "cloud_conversation_tombstones":
          break;
        default: {
          const exhaustive: never = store;
          throw new Error(`Unchecked owner store: ${String(exhaustive)}`);
        }
      }
    }
    return remaining;
  },
});

// ─── The builder worker ──────────────────────────────────────────────────────

type BuilderEndpoint = { url: string; secret: string };

const builderEndpoint = (): BuilderEndpoint | null => {
  const url = process.env.CLOUD_BUILDER_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return url && secret ? { url, secret } : null;
};

type ExternalPurgeRequest = {
  appSlugs?: string[];
  buildPrefixes?: string[];
  browserProfiles?: string[];
};

const requireBuilderEndpoint = (): BuilderEndpoint => {
  const builder = builderEndpoint();
  if (!builder) {
    throw new Error(
      "Cloud owner purge cannot be verified because CLOUD_BUILDER_URL or BUILDER_SERVICE_SECRET is missing.",
    );
  }
  return builder;
};

export const beginExternalOwnerPurge = async (
  ownerId: string,
  mode: "temporary" | "permanent",
  requestId: string,
  expectedGeneration?: string,
): Promise<{ generation: string; rejoined: boolean }> => {
  const builder = requireBuilderEndpoint();
  const response = await fetch(`${builder.url}/owners/purge/begin`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${builder.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ownerId,
      mode,
      requestId,
      ...(expectedGeneration ? { expectedGeneration } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const verdict = (await response.json().catch(() => null)) as {
    generation?: string;
    rejoined?: boolean;
  } | null;
  if (!response.ok || !verdict?.generation) {
    throw new Error(
      `Cloud owner activity could not be quiesced before purge (${response.status}).`,
    );
  }
  return {
    generation: verdict.generation,
    rejoined: verdict.rejoined === true,
  };
};

/**
 * Idempotently open/rejoin the worker fence and durably bind its generation to
 * the Convex purge job before any long-running drain starts.
 */
export const ensureExternalOwnerPurge = async (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    operationId: string;
    generation: string;
    mode: "reset" | "delete";
  },
): Promise<string> => {
  const job: { externalGeneration?: string } | null = await ctx.runQuery(
    internal.owner_lifecycle.getOwnerPurgeJobInternal,
    { ownerId: args.ownerId, operationId: args.operationId },
  );
  if (job?.externalGeneration) {
    // Always rejoin. A reset can crash after the worker release response but
    // before lifecycle completion; the durable job still carries the released
    // generation. The worker accepts that exact replay and returns a new fence
    // generation with `rejoined:true`. Delete also uses this call to upgrade a
    // temporary reset fence to permanent.
    const joined = await beginExternalOwnerPurge(
      args.ownerId,
      args.mode === "delete" ? "permanent" : "temporary",
      args.operationId,
      job.externalGeneration,
    );
    if (joined.generation === job.externalGeneration) {
      return job.externalGeneration;
    }
    if (!joined.rejoined) {
      throw new Error(
        "Cloud owner fence changed outside this purge operation.",
      );
    }
    const reboundGeneration: string = await ctx.runMutation(
      internal.owner_lifecycle.rebindOwnerExternalPurgeGenerationInternal,
      {
        ownerId: args.ownerId,
        operationId: args.operationId,
        generation: args.generation,
        previousExternalGeneration: job.externalGeneration,
        externalGeneration: joined.generation,
        now: Date.now(),
      },
    );
    if (args.mode === "delete") {
      // A released-generation rejoin deliberately creates a temporary fence,
      // even when the rejoining request asked for permanent mode. Upgrade the
      // exact replacement generation before deletion proceeds; otherwise a
      // crash between the CAS above and a later retry could leave delete under
      // a releasable reset fence.
      const permanent = await beginExternalOwnerPurge(
        args.ownerId,
        "permanent",
        args.operationId,
        reboundGeneration,
      );
      if (permanent.generation !== reboundGeneration || permanent.rejoined) {
        throw new Error(
          "Cloud owner delete fence could not be upgraded to permanent.",
        );
      }
    }
    return reboundGeneration;
  }
  const external = await beginExternalOwnerPurge(
    args.ownerId,
    args.mode === "delete" ? "permanent" : "temporary",
    args.operationId,
  );
  return await ctx.runMutation(
    internal.owner_lifecycle.recordOwnerExternalPurgeGenerationInternal,
    {
      ownerId: args.ownerId,
      operationId: args.operationId,
      generation: args.generation,
      externalGeneration: external.generation,
      now: Date.now(),
    },
  );
};

const releaseExternalOwnerPurge = async (
  ownerId: string,
  purgeGeneration: string,
): Promise<void> => {
  const builder = requireBuilderEndpoint();
  const response = await fetch(`${builder.url}/owners/purge/release`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${builder.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ownerId, purgeGeneration }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Cloud owner activity remained fenced after reset (${response.status}).`,
    );
  }
};

/**
 * One pass of the worker-side purge. `pending` non-empty means the worker
 * could not finish, and the caller must keep the rows that name those bytes.
 *
 * Missing builder configuration is fail-closed. This action cannot prove that
 * an older deployment never wrote external state, so absence of credentials
 * is never evidence that the external tier is empty.
 */
const purgeExternalStores = async (
  ownerId: string,
  ownerGeneration: string,
  request: ExternalPurgeRequest,
  purgeGeneration: string,
): Promise<{ pending: string[] }> => {
  const builder = requireBuilderEndpoint();
  try {
    const response = await fetch(`${builder.url}/owners/purge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${builder.secret}`,
        "content-type": "application/json",
      },
      // `ownerGeneration` is Convex's current lifecycle generation. It is a
      // separate authority from the Builder's external `purgeGeneration` and
      // must never be substituted with that worker-fence value.
      body: JSON.stringify({
        ownerId,
        ownerGeneration,
        purgeGeneration,
        ...request,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      logPurge("owner_storage_purge_unavailable", { status: response.status });
      return { pending: ["builder-storage"] };
    }
    const verdict = (await response.json().catch(() => null)) as {
      pending?: string[];
    } | null;
    // A body that cannot be read is not a purge that succeeded. Treating an
    // unreadable answer as done is how bytes are stranded with the rows that
    // named them already deleted.
    if (!verdict || !Array.isArray(verdict.pending)) {
      logPurge("owner_storage_purge_unreadable", { status: response.status });
      return { pending: ["builder-storage"] };
    }
    return { pending: verdict.pending };
  } catch (error) {
    logPurge("owner_storage_purge_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return { pending: ["builder-storage"] };
  }
};

// ─── Schedules ───────────────────────────────────────────────────────────────

/**
 * Stop this owner's schedules. Exported as a plain helper because it has to
 * run at the TOP of every teardown, before the conversation drain that can
 * take minutes — a schedule fires every minute, spends model tokens, and
 * recreates conversations for the account being deleted, so "the sweep gets
 * there eventually" is not a fix. Idempotent; a retried purge runs it again.
 */
export const stopOwnerSchedules = async (
  ctx: ActionCtx,
  args: { ownerId: string; operationId: string; generation: string },
): Promise<void> => {
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const result: { stopped: number; hasMore: boolean } = await ctx.runMutation(
      internal.cloud_schedule.stopOwnerSchedulesInternal,
      { ...args, now: Date.now() },
    );
    if (!result.hasMore) return;
  }
  logPurge("owner_schedule_stop_truncated", { passes: MAX_PASSES });
  throw new Error("Owner schedule stop exceeded its bounded drain budget.");
};

// ─── The whole cloud stack ───────────────────────────────────────────────────

/**
 * The whole cloud stack for one owner.
 *
 * Order is not incidental:
 *  1. Schedules stop first — they are the only store that keeps ACTING while
 *     the rest is being deleted.
 *  2. Conversations next, and they are the step that can refuse to finish:
 *     their transcript lives in a Durable Object and their history in R2, and
 *     the only honest way to know that data is gone is for the DO to say so. A
 *     conversation whose DO cannot be reached keeps its tombstone (identity
 *     only — no title, no preview, no content) and is retried by the sweep
 *     cron, rather than having its index row deleted and its bytes stranded
 *     with no record of where they are.
 *  3. Every store that names bytes outside Convex has those bytes purged
 *     BEFORE its row is deleted, because the row is the only name they have.
 *  4. Everything else drains by owner index.
 *  5. A completeness check re-reads all of it.
 *
 * Reset and deletion share the same checked purge. Their durable lifecycle job
 * supplies the mode; both retain every fence and retry until strict
 * completeness succeeds.
 */
export const purgeOwnerCloudStack = internalAction({
  args: purgeOperationArgs,
  returns: v.object({ pending: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const { ownerId } = args;
    const fence = {
      ownerId,
      operationId: args.operationId,
      generation: args.generation,
    };
    const leaseId = crypto.randomUUID();
    const claim: {
      claimed: boolean;
      complete: boolean;
      mode: "reset" | "delete";
    } = await ctx.runMutation(
      internal.owner_lifecycle.claimOwnerPurgeStageInternal,
      {
        ...fence,
        stage: "cloud",
        leaseId,
        now: Date.now(),
      },
    );
    if (claim.complete) return { pending: [] };
    if (!claim.claimed) {
      throw new Error("Owner cloud purge is already leased or not ready.");
    }
    const pending: string[] = [];
    try {
      // The worker fence was normally opened by the core stage. Rejoin it by
      // its durable generation on retry; opening here is the crash-safe fallback.
      const purgeGeneration = await ensureExternalOwnerPurge(ctx, {
        ...fence,
        mode: claim.mode,
      });
      const assertCloudLease = async (): Promise<void> => {
        await ctx.runMutation(
          internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
          {
            ...fence,
            stage: "cloud",
            leaseId,
            mode: claim.mode,
            now: Date.now(),
          },
        );
      };
      const purgeExternalStoresFenced = async (
        request: ExternalPurgeRequest,
      ): Promise<{ pending: string[] }> => {
        await assertCloudLease();
        return await purgeExternalStores(
          ownerId,
          args.generation,
          request,
          purgeGeneration,
        );
      };

      await stopOwnerSchedules(ctx, fence);
      const integrationQuiescence = await quiesceOwnerIntegrationCalls(
        ctx,
        ownerId,
      );
      if (!integrationQuiescence.ready) {
        pending.push("cloud_integration_call_receipts");
      }

      // 1. Fork/Rewind receipts. A fork target may have been created in its DO
      // before the ordinary conversation index was published, so the receipt
      // is the only durable locator for that external state. Purge that exact
      // target first and retire the receipt only after the handshake succeeds.
      let editPass = 0;
      for (; editPass < MAX_PASSES; editPass += 1) {
        const edits: Array<{
          id: Id<"cloud_conversation_edits">;
          editOperationId: string;
          targetConversationId?: string;
        }> = await ctx.runQuery(
          internal.cloud_purge.listOwnerConversationEditPurgeBatchInternal,
          { ownerId },
        );
        if (edits.length === 0) break;
        let progressed = false;
        for (const edit of edits) {
          if (edit.targetConversationId) {
            await assertCloudLease();
            const result: { purged: boolean } = await ctx.runAction(
              internal.cloud_conversation_edits
                .purgeConversationEditTargetInternal,
              {
                ...fence,
                editOperationId: edit.editOperationId,
                targetConversationId: edit.targetConversationId,
              },
            );
            if (!result.purged) continue;
          }
          const deleted: boolean = await ctx.runMutation(
            internal.cloud_purge.deleteConfirmedConversationEditInternal,
            { ...fence, ref: edit },
          );
          progressed ||= deleted;
        }
        if (!progressed) {
          pending.push("cloud_conversation_edits");
          break;
        }
      }
      if (editPass === MAX_PASSES) {
        pending.push("cloud_conversation_edits");
        logPurge("owner_conversation_edit_drain_truncated", {
          passes: MAX_PASSES,
        });
      }

      // 2. Conversations. Each is a handshake with its DO.
      let pass = 0;
      for (; pass < MAX_PASSES; pass += 1) {
        const rows: Array<{ conversationId: string; purged: boolean }> =
          await ctx.runQuery(
            internal.cloud_purge.listOwnerConversationsInternal,
            { ownerId },
          );
        if (rows.length === 0) break;
        let progressed = false;
        for (const row of rows) {
          if (!row.purged) {
            await assertCloudLease();
            const result: { purged: boolean } = await ctx.runAction(
              internal.cloud_apps.purgeConversationInternal,
              { conversationId: row.conversationId, ...fence },
            );
            if (!result.purged) continue;
          }
          await ctx.runMutation(
            internal.cloud_purge.deleteConversationIndexRowInternal,
            { ...fence, conversationId: row.conversationId },
          );
          progressed = true;
        }
        if (!progressed) {
          pending.push("cloud_conversations");
          break;
        }
      }
      if (pass === MAX_PASSES) {
        // Still making progress but out of budget. The remaining conversations
        // are untouched — live, not half-deleted — so a re-run finishes them.
        pending.push("cloud_conversations");
        logPurge("owner_conversation_drain_truncated", { passes: MAX_PASSES });
      }

      // 2. Mini apps. The hosted route and the built artifacts are dropped by
      //    the worker first; only then may the rows that name them go.
      //
      //    A pass that deletes nothing is not automatically a stall: a build or
      //    project that landed after the manifest was read is deliberately held
      //    back for one pass so its bytes go first. Two in a row is a stall.
      let barrenAppPasses = 0;
      for (let appPass = 0; appPass < MAX_PASSES; appPass += 1) {
        const manifest: {
          hasRows: boolean;
          slugs: string[];
          buildPrefixes: string[];
        } = await ctx.runQuery(
          internal.cloud_purge.listOwnerAppPurgeManifestInternal,
          { ownerId: fence.ownerId },
        );
        if (!manifest.hasRows) break;
        const external = await purgeExternalStoresFenced({
          appSlugs: manifest.slugs,
          buildPrefixes: manifest.buildPrefixes,
        });
        if (external.pending.length > 0) {
          pending.push("cloud_apps");
          break;
        }
        const buildDrain: { hasMore: boolean; deleted: number } =
          await ctx.runMutation(internal.cloud_purge.deleteOwnerAppBuildBatch, {
            ...fence,
            purgedPrefixes: manifest.buildPrefixes,
          });
        const appDrain: { hasMore: boolean; deleted: number } =
          await ctx.runMutation(internal.cloud_purge.deleteOwnerAppBatch, {
            ...fence,
            purgedPrefixes: manifest.buildPrefixes,
          });
        if (!buildDrain.hasMore && !appDrain.hasMore) break;
        const deleted = buildDrain.deleted + appDrain.deleted;
        barrenAppPasses = deleted === 0 ? barrenAppPasses + 1 : 0;
        if (barrenAppPasses >= 2) {
          pending.push("cloud_apps");
          logPurge("owner_app_drain_stalled", { ownerId });
          break;
        }
      }

      // 3. Stella interior builds. Their immutable rows are the only names of
      //    their R2 prefixes, so the worker confirms each prefix gone first.
      let barrenInteriorPasses = 0;
      for (let interiorPass = 0; interiorPass < MAX_PASSES; interiorPass += 1) {
        const manifest: { hasRows: boolean; buildPrefixes: string[] } =
          await ctx.runQuery(
            internal.cloud_purge.listOwnerInteriorPurgeManifestInternal,
            { ownerId },
          );
        if (!manifest.hasRows) break;
        const external =
          manifest.buildPrefixes.length === 0
            ? { pending: [] }
            : await purgeExternalStoresFenced({
                buildPrefixes: manifest.buildPrefixes,
              });
        if (external.pending.length > 0) {
          pending.push("cloud_interior_deployables");
          break;
        }
        const drained: { hasMore: boolean; deleted: number } =
          await ctx.runMutation(
            internal.cloud_purge.deleteOwnerInteriorDeploymentBatch,
            {
              ...fence,
              purgedPrefixes: manifest.buildPrefixes,
            },
          );
        if (!drained.hasMore) break;
        barrenInteriorPasses =
          drained.deleted === 0 ? barrenInteriorPasses + 1 : 0;
        if (barrenInteriorPasses >= 2) {
          pending.push("cloud_interior_deployables");
          logPurge("owner_interior_drain_stalled", { ownerId });
          break;
        }
      }

      // 4. GitHub App grants. Deletion debt is committed before the remote call;
      //    every locator row remains on any non-terminal GitHub response.
      for (let githubPass = 0; githubPass < MAX_PASSES; githubPass += 1) {
        const manifest: { hasRows: boolean; installationIds: string[] } =
          await ctx.runQuery(
            internal.cloud_purge.listOwnerGithubPurgeManifestInternal,
            { ownerId },
          );
        if (manifest.installationIds.length > 0) {
          const staged: string[] = await ctx.runMutation(
            internal.cloud_purge.stageOwnerGithubInstallationDeletionsInternal,
            {
              ...fence,
              installationIds: manifest.installationIds,
              now: Date.now(),
            },
          );
          for (const installationId of staged) {
            await assertCloudLease();
            await deleteGithubInstallationGrant(installationId);
            await ctx.runMutation(
              internal.cloud_purge
                .finishOwnerGithubInstallationDeletionInternal,
              { ...fence, installationId },
            );
          }
        }
        const handleless: { hasMore: boolean } = await ctx.runMutation(
          internal.cloud_purge.deleteOwnerGithubHandlelessStatesInternal,
          fence,
        );
        if (!manifest.hasRows && !handleless.hasMore) break;
      }

      // 5. Projects. The checkout itself is inside the owner's world
      //    checkpoint, dropped whole by the owner-level step below.
      let barrenProjectPasses = 0;
      for (let projectPass = 0; projectPass < MAX_PASSES; projectPass += 1) {
        const drained: { hasMore: boolean; deleted: number } =
          await ctx.runMutation(
            internal.cloud_purge.deleteOwnerProjectBatch,
            fence,
          );
        if (!drained.hasMore) break;
        barrenProjectPasses =
          drained.deleted === 0 ? barrenProjectPasses + 1 : 0;
        if (barrenProjectPasses >= 2) {
          pending.push("cloud_projects");
          logPurge("owner_project_drain_stalled", { ownerId });
          break;
        }
      }

      // 6. The drive: object first, row last. Failed object deletions retain the
      //    exact locator row; live presigned uploads are retained through expiry.
      for (let drivePass = 0; drivePass < MAX_PASSES; drivePass += 1) {
        const rows: Array<
          | { kind: "file"; id: Id<"cloud_drive_files">; r2Key: string }
          | {
              kind: "upload";
              id: Id<"cloud_drive_uploads">;
              r2Key: string;
              expiresAt: number;
            }
        > = await ctx.runQuery(
          internal.cloud_purge.listOwnerDriveObjectsInternal,
          { ownerId },
        );
        if (rows.length === 0) break;
        const deleteStartedAt = Date.now();
        const eligibleRows = rows.filter(
          (row) => row.kind === "file" || row.expiresAt <= deleteStartedAt,
        );
        // A signed PUT cannot be revoked. Deleting current bytes before its
        // full expiry would let a stale client recreate the object after the
        // action had acknowledged absence. Keep the exact upload locator and
        // retry the whole physical-delete/readback sequence after the barrier.
        if (eligibleRows.length === 0) {
          pending.push("cloud_drive_objects");
          break;
        }
        await assertCloudLease();
        const deletion = await ctx.runAction(deleteComponentR2ObjectsRef, {
          objects: eligibleRows.map((row) => ({
            locatorId: String(row.id),
            r2Key: row.r2Key,
          })),
        });
        const confirmedIds = new Set(deletion.confirmedLocatorIds);
        const confirmed = eligibleRows.filter((row) =>
          confirmedIds.has(String(row.id)),
        );
        if (deletion.failedLocatorIds.length > 0) {
          logPurge("drive_object_delete_failed", {
            failedCount: deletion.failedLocatorIds.length,
          });
        }
        const rowDrain: { deleted: number; deferred: number } =
          await ctx.runMutation(internal.cloud_purge.deleteDriveRowsInternal, {
            ...fence,
            rows: confirmed,
            now: deleteStartedAt,
          });
        if (
          eligibleRows.length !== rows.length ||
          confirmed.length !== eligibleRows.length ||
          rowDrain.deferred > 0
        ) {
          pending.push("cloud_drive_objects");
          break;
        }
      }

      // 7. Spawned-agent threads first: a rolling-schema event can be
      //    owner-less and reachable only through `sessionId === threadId`.
      //    The cascade keeps each parent until its paginated legacy-event scan
      //    is complete, so a crash merely restarts from the still-present
      //    thread and can never turn private payload into invisible residue.
      let agentThreadsDrained = false;
      let agentThreadCursor: string | null = null;
      for (let p = 0; p < MAX_PASSES; p += 1) {
        const result: {
          hasThread: boolean;
          completedThread: boolean;
          deletedEvents: number;
          protectedEvents: number;
          cursor: string | null;
        } = await ctx.runMutation(
          internal.cloud_purge.deleteOwnerAgentThreadCascadeBatchInternal,
          { ...fence, cursor: agentThreadCursor },
        );
        if (!result.hasThread) {
          agentThreadsDrained = true;
          break;
        }
        agentThreadCursor = result.completedThread ? null : result.cursor;
      }
      if (!agentThreadsDrained) {
        pending.push("cloud_agent_threads");
        logPurge("owner_agent_thread_cascade_truncated", { ownerId });
      }

      // 8. Owner-indexed tables with nothing hanging off them. Independent —
      //    drain them concurrently.
      await Promise.all(
        SIMPLE_TABLES.map(async (table) => {
          // A Schedule replay receipt can embed the schedule row. Retain it
          // until the stopped schedule itself has been drained below.
          if (table === "cloud_schedule_receipts") return;
          for (let p = 0; p < MAX_PASSES; p += 1) {
            const result: { hasMore: boolean } = await ctx.runMutation(
              internal.cloud_purge.deleteOwnerCloudBatch,
              { ...fence, table },
            );
            if (!result.hasMore) return;
          }
          logPurge("owner_table_drain_truncated", { table });
        }),
      );

      // Connected-tool receipts are ordinary owner rows only after every
      // read-only provider dispatch is terminal or its 90-second lease has
      // expired. The row-level mutation repeats this defense and retains
      // malformed dispatch debt with no lease deadline.
      if (integrationQuiescence.ready) {
        for (const table of LEASED_TABLES) {
          for (let p = 0; p < MAX_PASSES; p += 1) {
            const result: { hasMore: boolean } = await ctx.runMutation(
              internal.cloud_purge.deleteOwnerCloudBatch,
              { ...fence, table },
            );
            if (!result.hasMore) break;
            if (p === MAX_PASSES - 1) {
              pending.push(table);
              logPurge("owner_leased_table_drain_truncated", { table });
            }
          }
        }
      }

      // 9. Turns and their cascade.
      for (let turnPass = 0; turnPass < MAX_PASSES; turnPass += 1) {
        const result: { hasMore: boolean } = await ctx.runMutation(
          internal.cloud_purge.deleteOwnerTurnBatch,
          fence,
        );
        if (!result.hasMore) break;
      }

      // 10. Schedules: stopped in step 0, drained now that nothing can re-arm one.
      let schedulesDrained = false;
      for (let schedulePass = 0; schedulePass < MAX_PASSES; schedulePass += 1) {
        const result: { deleted: number; hasMore: boolean } =
          await ctx.runMutation(
            internal.cloud_schedule.deleteOwnerSchedulesInternal,
            fence,
          );
        if (!result.hasMore) {
          schedulesDrained = true;
          break;
        }
      }
      if (!schedulesDrained) {
        pending.push("cloud_scheduled_turns");
      } else {
        // Only after the authoritative schedule rows are gone may their exact
        // replay results be retired.
        for (let p = 0; p < MAX_PASSES; p += 1) {
          const result: { hasMore: boolean } = await ctx.runMutation(
            internal.cloud_purge.deleteOwnerCloudBatch,
            { ...fence, table: "cloud_schedule_receipts" },
          );
          if (!result.hasMore) break;
          if (p === MAX_PASSES - 1) {
            pending.push("cloud_schedule_receipts");
            logPurge("owner_schedule_receipt_drain_truncated", { ownerId });
          }
        }
      }

      // 11. Owner-level object storage the per-row steps cannot see: the
      //    agent-home memory prefix, any archive segment whose conversation row
      //    was already gone, and the owner's world checkpoint, which exists
      //    without a row anywhere naming it.
      const external = await purgeExternalStoresFenced({
        browserProfiles: ["default"],
      });
      if (external.pending.length > 0) {
        pending.push(...external.pending.map((store) => `builder:${store}`));
      }

      // Memory/Skills rows are external locators/control receipts. The
      // owner-derived agent-home prefix must be confirmed empty before any of
      // them is retired; otherwise a failed R2 sweep would strand private bytes
      // with no database record left to force a retry.
      if (!external.pending.includes("agent-home")) {
        const headTables = new Set<AgentHomeTable>([
          "cloud_agent_home_docs",
          "cloud_skills",
        ]);
        const phases: AgentHomeTable[][] = [
          AGENT_HOME_TABLES.filter((table) => !headTables.has(table)),
          AGENT_HOME_TABLES.filter((table) => headTables.has(table)),
        ];
        for (const phase of phases) {
          await Promise.all(
            phase.map(async (table) => {
              for (let p = 0; p < MAX_PASSES; p += 1) {
                const result: { hasMore: boolean } = await ctx.runMutation(
                  internal.cloud_purge.deleteOwnerAgentHomeBatch,
                  { ...fence, table },
                );
                if (!result.hasMore) return;
              }
              logPurge("owner_agent_home_table_drain_truncated", { table });
            }),
          );
        }
      }

      // Interaction rows are secret-free, but they are the durable debt that
      // forces owner deletion/reset to retry the Browser Gateway sweep. Retire
      // them only after the full final external pass confirms success.
      if (external.pending.length === 0) {
        for (let p = 0; p < MAX_PASSES; p += 1) {
          const result: { hasMore: boolean } = await ctx.runMutation(
            internal.cloud_purge.deleteOwnerBrowserInteractionBatchInternal,
            fence,
          );
          if (!result.hasMore) break;
          if (p === MAX_PASSES - 1) {
            pending.push("cloud_browser_interactions");
          }
        }
      }

      // 11. The claim, checked. Everything above reports what it believes; this
      //    reads the database back and says what is actually left.
      const remaining: string[] = await ctx.runQuery(
        internal.cloud_purge.remainingOwnerStoresInternal,
        { ownerId },
      );
      const unfinished = Array.from(new Set([...pending, ...remaining]));

      if (unfinished.length > 0) {
        logPurge("owner_cloud_purge_incomplete", { stores: unfinished });
      }
      if (unfinished.length > 0) {
        throw new Error(
          `Cloud deletion is waiting for storage to be purged (${unfinished.join(", ")}); the owner activity fence remains active.`,
        );
      }
      if (claim.mode === "reset") {
        await ctx.runMutation(
          internal.owner_lifecycle.assertOwnerPurgeLeaseInternal,
          {
            ...fence,
            stage: "cloud",
            leaseId,
            mode: "reset",
          },
        );
        await releaseExternalOwnerPurge(ownerId, purgeGeneration);
      }
      const finished: boolean = await ctx.runMutation(
        internal.owner_lifecycle.finishOwnerCloudPurgeInternal,
        {
          ...fence,
          leaseId,
          nextGeneration: crypto.randomUUID(),
          now: Date.now(),
        },
      );
      if (!finished) {
        throw new Error("Owner lifecycle changed before purge completion.");
      }
      return { pending: unfinished };
    } catch (error) {
      await ctx.runMutation(
        internal.owner_lifecycle.scheduleOwnerPurgeRetryInternal,
        {
          ...fence,
          stage: "cloud",
          leaseId,
          error: error instanceof Error ? error.message : String(error),
          now: Date.now(),
        },
      );
      throw error;
    }
  },
});
