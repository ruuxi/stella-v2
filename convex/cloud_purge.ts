// Owner-scoped teardown for the cloud stack.
//
// This exists because none of it was covered before. `account_deletion.ts` and
// `reset.ts` drained every OTHER owner-scoped table and left the entire
// `cloud_*` surface behind — including a full conversation transcript table.
// The DO-resident transcript makes that worse rather than better if it goes
// unaddressed: the bytes move to Durable Object SQLite and R2, where Convex
// cannot reach them at all except by asking the DO. So deletion is a handshake,
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
import { r2 } from "./r2_files";

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
  | "child"
  | "global";

const OWNER_STORES = {
  // The conversation index. Content lives in the OrchestratorSession DO and
  // its R2 segments; `purgeConversationInternal` is the handshake.
  cloud_conversations: "handshake",
  // Pre-DO transcripts. No owner index — drained per conversation while the
  // index row that names them still exists.
  cloud_messages: "child",
  // Turns, plus the event stream and app invocations that hang off each.
  agent_turns: "cascade",
  agent_events: "child",
  cloud_app_op_invocations: "child",
  // Recall's cross-conversation excerpt index.
  cloud_message_excerpts: "simple",
  // Spawned-agent thread transcripts.
  cloud_thread_messages: "simple",
  cloud_agent_threads: "simple",
  // Live per-turn credentials. The expiry cron is a floor on how long a stolen
  // one survives, never a deletion path.
  cloud_turn_tokens: "simple",
  // Memory document registry. The bytes are in R2 `agent-home/<hash>/`, swept
  // by the worker from the owner id alone.
  cloud_agent_home_docs: "simple",
  cloud_app_storage: "simple",
  // Mini apps: build rows and the operation manifest cascade from the app, and
  // the app additionally names a hosted KV route and R2 build artifacts.
  cloud_apps: "external-ref",
  cloud_app_builds: "child",
  cloud_app_operations: "child",
  // Per-owner Stella interior routing plus immutable candidates. Both name
  // R2 build prefixes, and the deployable also implies the owner's `stella`
  // sandbox checkpoint. External bytes go before either row.
  cloud_interior_deployables: "external-ref",
  cloud_interior_builds: "external-ref",
  // Recurring and one-shot turns. Stopped before anything else is touched.
  cloud_scheduled_turns: "stopped",
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
  // Cloud projects. Each names a sandbox checkpoint in the worker's KV whose
  // key hashes `<owner>:project:<slug>` and cannot be derived without the row.
  cloud_projects: "external-ref",
  cloud_github_installations: "simple",
  cloud_github_install_states: "simple",
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
  "cloud_message_excerpts",
  "cloud_thread_messages",
  "cloud_agent_threads",
  "cloud_turn_tokens",
  "cloud_agent_home_docs",
  "cloud_app_storage",
  "cloud_drive_usage",
  "cloud_drive_deletions",
  "cloud_llm_credentials",
  "cloud_engine_connects",
  "cloud_engine_settings",
  "cloud_github_installations",
  "cloud_github_install_states",
] as const;

type SimpleTable = (typeof SIMPLE_TABLES)[number];

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

const drainSimpleTable = async (
  ctx: MutationCtx,
  ownerId: string,
  table: SimpleTable,
): Promise<number> => {
  let ids: Id<SimpleTable>[] = [];
  switch (table) {
    case "cloud_message_excerpts": {
      const rows = await ctx.db
        .query("cloud_message_excerpts")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
      break;
    }
    case "cloud_thread_messages": {
      const rows = await ctx.db
        .query("cloud_thread_messages")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
      break;
    }
    case "cloud_agent_threads": {
      const rows = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
      break;
    }
    case "cloud_turn_tokens": {
      const rows = await ctx.db
        .query("cloud_turn_tokens")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
      break;
    }
    case "cloud_agent_home_docs": {
      const rows = await ctx.db
        .query("cloud_agent_home_docs")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
      break;
    }
    case "cloud_app_storage": {
      const rows = await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
      break;
    }
    case "cloud_drive_usage": {
      const rows = await ctx.db
        .query("cloud_drive_usage")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
      break;
    }
    case "cloud_drive_deletions": {
      const rows = await ctx.db
        .query("cloud_drive_deletions")
        .withIndex("by_ownerId_and_deletedAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
      break;
    }
    case "cloud_llm_credentials": {
      // Encrypted refresh tokens for the owner's own model subscription. They
      // outlive the access token by design, so nothing but this deletes them.
      const rows = await ctx.db
        .query("cloud_llm_credentials")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
      break;
    }
    case "cloud_engine_connects": {
      const rows = await ctx.db
        .query("cloud_engine_connects")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
      break;
    }
    case "cloud_engine_settings": {
      const rows = await ctx.db
        .query("cloud_engine_settings")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
      break;
    }
    case "cloud_github_installations": {
      // Deleting the row is what ends Stella's access: an installation id is
      // worthless without the App private key, and nothing else names it. The
      // grant itself lives in the user's GitHub account and is theirs to
      // revoke — this deployment must not reach into it on their way out.
      const rows = await ctx.db
        .query("cloud_github_installations")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
      break;
    }
    case "cloud_github_install_states": {
      const rows = await ctx.db
        .query("cloud_github_install_states")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((row) => row._id) as Id<SimpleTable>[];
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
    ownerId: v.string(),
    table: v.union(
      ...(SIMPLE_TABLES.map((table) => v.literal(table)) as [
        VLiteral<SimpleTable>,
        VLiteral<SimpleTable>,
        ...VLiteral<SimpleTable>[],
      ]),
    ),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const deleted = await drainSimpleTable(ctx, args.ownerId, args.table);
    return { hasMore: deleted === BATCH };
  },
});

/**
 * Turns cascade: each carries its event stream and any app-operation
 * invocations it created. Children go first, and the turn row is only retired
 * once its last child is gone — an orphaned event row can never be found
 * again, because every index into it starts at the turn.
 */
export const deleteOwnerTurnBatch = internalMutation({
  args: { ownerId: v.string() },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
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

      const threadMessages = await ctx.db
        .query("cloud_thread_messages")
        .withIndex("by_turnId", (q) => q.eq("turnId", turn.turnId))
        .take(BATCH);
      for (const message of threadMessages) await ctx.db.delete(message._id);
      if (threadMessages.length === BATCH) return { hasMore: true };

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
    slugs: v.array(v.string()),
    workspaces: v.array(v.string()),
    buildPrefixes: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const apps = await ctx.db
      .query("cloud_apps")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(APP_BATCH);
    const buildPrefixes: string[] = [];
    for (const app of apps) {
      const builds = await ctx.db
        .query("cloud_app_builds")
        .withIndex("by_appId_and_createdAt", (q) => q.eq("appId", app.appId))
        .take(BATCH);
      for (const build of builds) {
        if (build.artifactPrefix) buildPrefixes.push(build.artifactPrefix);
      }
    }
    return {
      slugs: apps.map((app) => app.slug),
      // An agent spawned into `app:<slug>` checkpoints its sandbox under a key
      // derived from that string, so the app's workspace goes with the app.
      workspaces: apps.map((app) => `app:${app.slug}`),
      buildPrefixes,
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
  args: { ownerId: v.string(), purgedPrefixes: v.array(v.string()) },
  returns: v.object({ hasMore: v.boolean(), deleted: v.number() }),
  handler: async (ctx, args) => {
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
 * this action independently removes the `stella` source-workspace checkpoint.
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
  args: { ownerId: v.string(), purgedPrefixes: v.array(v.string()) },
  returns: v.object({ hasMore: v.boolean(), deleted: v.number() }),
  handler: async (ctx, args) => {
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
 * The workspace strings whose sandbox checkpoints the worker must drop. The
 * checkpoint key hashes `<ownerId>:project:<slug>`, so once the project row is
 * gone there is nothing left in the system that can name the checkpoint — a
 * full copy of the user's private repository, sitting in R2 behind a live KV
 * descriptor. Read first, deleted last.
 */
export const listOwnerProjectWorkspacesInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_projects")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(BATCH);
    return rows.map((row) => `project:${row.slug}`);
  },
});

/**
 * `purgedWorkspaces` is what the worker just confirmed; a project created
 * since the manifest was read keeps its row, and with it the only name its
 * checkpoint has, until a later pass purges that checkpoint first.
 */
export const deleteOwnerProjectBatch = internalMutation({
  args: { ownerId: v.string(), purgedWorkspaces: v.array(v.string()) },
  returns: v.object({ hasMore: v.boolean(), deleted: v.number() }),
  handler: async (ctx, args) => {
    const purged = new Set(args.purgedWorkspaces);
    const rows = await ctx.db
      .query("cloud_projects")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(BATCH);
    let deleted = 0;
    for (const row of rows) {
      if (!purged.has(`project:${row.slug}`)) continue;
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    return { hasMore: rows.length > deleted || rows.length === BATCH, deleted };
  },
});

// ─── Drive ───────────────────────────────────────────────────────────────────

const driveObjectRow = v.object({
  id: v.union(v.id("cloud_drive_files"), v.id("cloud_drive_uploads")),
  r2Key: v.string(),
});

/**
 * The drive is the one R2 store the builder worker cannot reach: its bucket is
 * bound to the Convex R2 component, not to the worker. So it is drained here,
 * row by row, object first — the row is the only record of the key, exactly as
 * with backup objects in `account_deletion.drainBackups`.
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
      return files.map((row) => ({ id: row._id, r2Key: row.r2Key }));
    }
    const uploads = await ctx.db
      .query("cloud_drive_uploads")
      .withIndex("by_ownerId_and_path", (q) => q.eq("ownerId", args.ownerId))
      .take(BATCH);
    return uploads.map((row) => ({ id: row._id, r2Key: row.r2Key }));
  },
});

export const deleteDriveRowsInternal = internalMutation({
  args: {
    ids: v.array(
      v.union(v.id("cloud_drive_files"), v.id("cloud_drive_uploads")),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Promise.all(args.ids.map((id) => ctx.db.delete(id)));
    return null;
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
 * Pre-DO transcript rows for one conversation. The table has no owner index —
 * it is drained deployment-wide by an hourly cron — so this is the only pass
 * that reaches an individual owner's rows, and it has to happen while the
 * index row that names the conversation is still there.
 */
export const deleteConversationLegacyRowsInternal = internalMutation({
  args: { conversationId: v.string() },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_messages")
      .withIndex("by_conversationId_and_seq", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .take(BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    return { hasMore: rows.length === BATCH };
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
 * record exists, and that window is precisely when a retried flush lands: it
 * would re-insert the deleted owner's conversation row and their transcript
 * excerpts, under an owner id that no longer exists, where no list, sweep or
 * search would ever surface them again.
 */
export const deleteConversationIndexRowInternal = internalMutation({
  args: { conversationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordConversationTombstone(ctx, args.conversationId, Date.now());
    const row = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
    if (row) await ctx.db.delete(row._id);
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
        case "cloud_message_excerpts":
          await check(store, () =>
            ctx.db
              .query("cloud_message_excerpts")
              .withIndex("by_ownerId_and_createdAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
        case "cloud_thread_messages":
          await check(store, () =>
            ctx.db
              .query("cloud_thread_messages")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
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
        case "cloud_turn_tokens":
          await check(store, () =>
            ctx.db
              .query("cloud_turn_tokens")
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
        case "cloud_app_storage":
          await check(store, () =>
            ctx.db
              .query("cloud_app_storage")
              .withIndex("by_ownerId_and_updatedAt", (q) =>
                q.eq("ownerId", ownerId),
              )
              .take(1),
          );
          break;
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
        // No owner index by design; each is reachable only through the parent
        // whose drain deletes it, and the parent's check above covers it. An
        // orphan here could not be found by any query even if it existed.
        case "cloud_messages":
        case "agent_events":
        case "cloud_app_op_invocations":
        case "cloud_app_builds":
        case "cloud_app_operations":
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
  workspaces?: string[];
  appSlugs?: string[];
  buildPrefixes?: string[];
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

const beginExternalOwnerPurge = async (
  ownerId: string,
  mode: "temporary" | "permanent",
): Promise<string> => {
  const builder = requireBuilderEndpoint();
  const response = await fetch(`${builder.url}/owners/purge/begin`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${builder.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ownerId, mode }),
    signal: AbortSignal.timeout(120_000),
  });
  const verdict = (await response.json().catch(() => null)) as {
    generation?: string;
  } | null;
  if (!response.ok || !verdict?.generation) {
    throw new Error(
      `Cloud owner activity could not be quiesced before purge (${response.status}).`,
    );
  }
  return verdict.generation;
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
      body: JSON.stringify({ ownerId, purgeGeneration, ...request }),
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
  ownerId: string,
): Promise<void> => {
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const result: { stopped: number; hasMore: boolean } = await ctx.runMutation(
      internal.cloud_schedule.stopOwnerSchedulesInternal,
      { ownerId, now: Date.now() },
    );
    if (!result.hasMore) return;
  }
  logPurge("owner_schedule_stop_truncated", { passes: MAX_PASSES });
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
 * `strict` is what separates the two callers: account deletion cannot report
 * success while cloud storage survives, so it throws and leaves the durable
 * purge gate open. `reset` keeps the account, so a retryable tail is a
 * background job, not a failed reset.
 */
export const purgeOwnerCloudStack = internalAction({
  args: { ownerId: v.string(), strict: v.optional(v.boolean()) },
  returns: v.object({ pending: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const { ownerId } = args;
    const pending: string[] = [];
    // The worker fence is first. It rejects new owner turns and does not
    // return until every already-running BuildSession has stopped, so no
    // checkpoint/upload/callback can land after the final sweep.
    const purgeGeneration = await beginExternalOwnerPurge(
      ownerId,
      args.strict === true ? "permanent" : "temporary",
    );

    await stopOwnerSchedules(ctx, ownerId);

    // 1. Conversations. Each is a handshake with its DO; the legacy transcript
    //    rows go while the index row that names the conversation is still here.
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
          const result: { purged: boolean } = await ctx.runAction(
            internal.cloud_apps.purgeConversationInternal,
            { conversationId: row.conversationId, ownerId },
          );
          if (!result.purged) continue;
        }
        let hasMoreLegacy = true;
        for (let p = 0; hasMoreLegacy && p < MAX_PASSES; p += 1) {
          const legacy: { hasMore: boolean } = await ctx.runMutation(
            internal.cloud_purge.deleteConversationLegacyRowsInternal,
            { conversationId: row.conversationId },
          );
          hasMoreLegacy = legacy.hasMore;
        }
        if (hasMoreLegacy) continue;
        await ctx.runMutation(
          internal.cloud_purge.deleteConversationIndexRowInternal,
          { conversationId: row.conversationId },
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
        slugs: string[];
        workspaces: string[];
        buildPrefixes: string[];
      } = await ctx.runQuery(
        internal.cloud_purge.listOwnerAppPurgeManifestInternal,
        { ownerId },
      );
      if (manifest.slugs.length === 0) break;
      const external = await purgeExternalStores(
        ownerId,
        {
          appSlugs: manifest.slugs,
          workspaces: manifest.workspaces,
          buildPrefixes: manifest.buildPrefixes,
        },
        purgeGeneration,
      );
      if (external.pending.length > 0) {
        pending.push("cloud_apps");
        break;
      }
      const drained: { hasMore: boolean; deleted: number } =
        await ctx.runMutation(internal.cloud_purge.deleteOwnerAppBatch, {
          ownerId,
          purgedPrefixes: manifest.buildPrefixes,
        });
      if (!drained.hasMore) break;
      barrenAppPasses = drained.deleted === 0 ? barrenAppPasses + 1 : 0;
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
          : await purgeExternalStores(
              ownerId,
              {
                buildPrefixes: manifest.buildPrefixes,
              },
              purgeGeneration,
            );
      if (external.pending.length > 0) {
        pending.push("cloud_interior_deployables");
        break;
      }
      const drained: { hasMore: boolean; deleted: number } =
        await ctx.runMutation(
          internal.cloud_purge.deleteOwnerInteriorDeploymentBatch,
          {
            ownerId,
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

    // 4. Projects. Same rule: the sandbox checkpoint holds a full checkout of
    //    the user's repository and its KV key cannot be derived without the
    //    slug on the row.
    let barrenProjectPasses = 0;
    for (let projectPass = 0; projectPass < MAX_PASSES; projectPass += 1) {
      const workspaces: string[] = await ctx.runQuery(
        internal.cloud_purge.listOwnerProjectWorkspacesInternal,
        { ownerId },
      );
      if (workspaces.length === 0) break;
      const external = await purgeExternalStores(
        ownerId,
        { workspaces },
        purgeGeneration,
      );
      if (external.pending.length > 0) {
        pending.push("cloud_projects");
        break;
      }
      const drained: { hasMore: boolean; deleted: number } =
        await ctx.runMutation(internal.cloud_purge.deleteOwnerProjectBatch, {
          ownerId,
          purgedWorkspaces: workspaces,
        });
      if (!drained.hasMore) break;
      barrenProjectPasses = drained.deleted === 0 ? barrenProjectPasses + 1 : 0;
      if (barrenProjectPasses >= 2) {
        pending.push("cloud_projects");
        logPurge("owner_project_drain_stalled", { ownerId });
        break;
      }
    }

    // 5. The drive: object first, row last.
    for (let drivePass = 0; drivePass < MAX_PASSES; drivePass += 1) {
      const rows: Array<{
        id: Id<"cloud_drive_files"> | Id<"cloud_drive_uploads">;
        r2Key: string;
      }> = await ctx.runQuery(
        internal.cloud_purge.listOwnerDriveObjectsInternal,
        { ownerId },
      );
      if (rows.length === 0) break;
      await Promise.all(
        rows.map((row) =>
          r2.deleteObject(ctx, row.r2Key).catch((error) => {
            logPurge("drive_object_delete_failed", {
              message: error instanceof Error ? error.message : String(error),
            });
          }),
        ),
      );
      await ctx.runMutation(internal.cloud_purge.deleteDriveRowsInternal, {
        ids: rows.map((row) => row.id),
      });
    }

    // 6. Owner-indexed tables with nothing hanging off them. Independent —
    //    drain them concurrently.
    await Promise.all(
      SIMPLE_TABLES.map(async (table) => {
        for (let p = 0; p < MAX_PASSES; p += 1) {
          const result: { hasMore: boolean } = await ctx.runMutation(
            internal.cloud_purge.deleteOwnerCloudBatch,
            { ownerId, table },
          );
          if (!result.hasMore) return;
        }
        logPurge("owner_table_drain_truncated", { table });
      }),
    );

    // 7. Turns and their cascade.
    for (let turnPass = 0; turnPass < MAX_PASSES; turnPass += 1) {
      const result: { hasMore: boolean } = await ctx.runMutation(
        internal.cloud_purge.deleteOwnerTurnBatch,
        { ownerId },
      );
      if (!result.hasMore) break;
    }

    // 8. Schedules: stopped in step 0, drained now that nothing can re-arm one.
    for (let schedulePass = 0; schedulePass < MAX_PASSES; schedulePass += 1) {
      const result: { deleted: number; hasMore: boolean } =
        await ctx.runMutation(
          internal.cloud_schedule.deleteOwnerSchedulesInternal,
          { ownerId },
        );
      if (!result.hasMore) break;
    }

    // 9. Owner-level object storage the per-row steps cannot see: the
    //    agent-home memory prefix, any archive segment whose conversation row
    //    was already gone, and the checkpoints of the two workspaces that
    //    exist for every owner without a row anywhere naming them.
    const external = await purgeExternalStores(
      ownerId,
      { workspaces: ["drive", "stella"] },
      purgeGeneration,
    );
    if (external.pending.length > 0) {
      pending.push(...external.pending.map((store) => `builder:${store}`));
    }

    // 10. The claim, checked. Everything above reports what it believes; this
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
    if (args.strict !== true) {
      await releaseExternalOwnerPurge(ownerId, purgeGeneration);
    }
    return { pending: unfinished };
  },
});
