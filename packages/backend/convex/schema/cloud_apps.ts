import { defineTable } from "convex/server";
import { v } from "convex/values";
import { cloudBrowserResumeReceiptValidator } from "./cloud_browser";
import { cloudExecutionSelectionValidator } from "../lib/cloud_execution";

export const cloudAppsSchema = {
  // The conversation INDEX, not the conversation. Message content lives in the
  // OrchestratorSession Durable Object's SQLite and nowhere else; this table
  // exists because a per-conversation DO cannot answer "list my conversations".
  //
  // The rule: everything below the marker is a DO-owned projection. Nothing in
  // Convex may read a DO-owned field and act on it as truth — they exist to
  // order and label a sidebar row, and a stale one costs a stale label.
  // `upsertConversationIndexInternal` is the ordinary projection writer,
  // fenced on (epoch, lastSeq). The one control-plane exception is the atomic
  // publish/rewind commit in `cloud_conversation_edits`: a fork identity is
  // inserted only after its target journal is complete, and rewind advances
  // the epoch before stale flushes can be accepted.
  //
  // Honest limit: conversation IDENTITY is not rebuildable from the DO tier —
  // Cloudflare has no "list the DOs in a namespace" API. So
  // {conversationId, ownerId, createdAt} is Convex-authoritative and mirrored
  // into the DO's `meta` on first contact; a total loss of this table is
  // recoverable only from a Convex backup, not from the DOs.
  cloud_conversations: defineTable({
    conversationId: v.string(),
    ownerId: v.string(),
    /**
     * Client-minted idempotency key for creating a conversation before its
     * first turn. Scoped by owner so two devices/accounts may use the same
     * opaque key without sharing an identity.
     */
    clientCreateId: v.optional(v.string()),
    /**
     * True for an intentionally empty conversation created from a New chat
     * action. The orphan sweep only owns failed turn-dispatch rows; it must not
     * reap a valid empty conversation before the user types into it.
     */
    allowEmpty: v.optional(v.boolean()),
    /**
     * Durable model route for every turn in this conversation. Optional only
     * for rows created before execution snapshots existed; the next turn
     * resolves and backfills it before dispatch.
     */
    execution: v.optional(cloudExecutionSelectionValidator),
    title: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    // ---- DO-owned below. Convex code must never patch these. ----
    /** Highest journal seq the DO has flushed. Absent until the first flush. */
    lastSeq: v.optional(v.number()),
    lastPreview: v.optional(v.string()),
    lastRole: v.optional(v.string()),
    /** "idle" | "running" — sidebar affordance only, never a lifecycle fact. */
    activity: v.optional(v.string()),
    /** Bumped when a DO's storage is reset; older flushes are stale. */
    epoch: v.optional(v.number()),
    /**
     * Purge tombstone. Set before the DO is asked to purge, so a failed purge
     * retries instead of orphaning R2 segments. A tombstoned conversation is
     * invisible and unwritable, and its title/preview are cleared on the spot.
     */
    deletedAt: v.optional(v.number()),
    /**
     * When the DO confirmed its storage and segments were gone. The row stays
     * after a per-conversation delete so the sweep can tell a finished purge
     * from an unfinished one.
     *
     * It is NOT the resurrection fence. That is
     * `cloud_conversation_tombstones` below, which outlives this row —
     * account deletion has to delete this one (it carries `ownerId`), and the
     * fence has to survive that.
     */
    purgedAt: v.optional(v.number()),
  })
    .index("by_conversationId", ["conversationId"])
    .index("by_ownerId_and_clientCreateId", ["ownerId", "clientCreateId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_deletedAt_and_updatedAt", [
      "ownerId",
      "deletedAt",
      "updatedAt",
    ])
    // Frozen history walks use a declared stable tie-break rather than the
    // database's implicit creation-time suffix. `conversationId` is immutable,
    // unique, and already part of every projected list item.
    .index("by_ownerId_and_deletedAt_and_updatedAt_and_conversationId", [
      "ownerId",
      "deletedAt",
      "updatedAt",
      "conversationId",
    ])
    // Tombstones still awaiting a purge. Missing fields index as `undefined`,
    // which sorts below every number, so `eq(purgedAt, undefined)` selects
    // exactly the unfinished ones and `gte(deletedAt, 1)` skips live rows.
    .index("by_purgedAt_and_deletedAt", ["purgedAt", "deletedAt"])
    // Orphan sweep: rows the DO never flushed (`lastSeq` undefined) group at
    // the front of this index, ordered by age.
    .index("by_lastSeq_and_createdAt", ["lastSeq", "createdAt"])
    // The sweep may address only dispatch-created rows. Legacy rows and
    // ordinary dispatch rows have `allowEmpty` undefined; intentional empty
    // conversations carry true and are excluded by the indexed equality.
    .index("by_allowEmpty_and_lastSeq_and_createdAt", [
      "allowEmpty",
      "lastSeq",
      "createdAt",
    ]),

  // The resurrection fence, and nothing else.
  //
  // A purged conversation's index row cannot do this job. It is the entry the
  // user sees and it carries `ownerId`, so account deletion must delete it —
  // and deleting it is precisely what re-opens `upsertConversationIndexInternal`'s
  // `!row` self-heal branch to an index flush that a still-resident DO started
  // before the purge and retried after it, re-inserting the deleted owner's
  // conversation row and their transcript excerpts. So the fence lives here,
  // with its own lifetime: written in the same transaction that deletes the
  // index row (and at `finishConversationPurgeInternal` for the ordinary
  // per-conversation delete), read by the self-heal branch before it inserts.
  //
  // What it retains, exhaustively: a randomly minted conversation UUID and the
  // instant the DO confirmed its storage was gone. No owner, no title, no
  // preview, no text, nothing derived from any of them. Once the index row is
  // deleted there is no row anywhere in this deployment that maps the id back
  // to a person, which is what makes retaining it defensible for an account
  // that no longer exists — it is a "this id is dead" marker, not a record of
  // anyone. Swept after `CONVERSATION_TOMBSTONE_RETENTION_MS`.
  cloud_conversation_tombstones: defineTable({
    conversationId: v.string(),
    purgedAt: v.number(),
  })
    .index("by_conversationId", ["conversationId"])
    .index("by_purgedAt", ["purgedAt"]),

  cloud_apps: defineTable({
    appId: v.string(),
    ownerId: v.string(),
    slug: v.string(),
    title: v.string(),
    status: v.string(),
    activeBuildId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_appId", ["appId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_slug", ["slug"]),

  cloud_app_builds: defineTable({
    buildId: v.string(),
    appId: v.string(),
    ownerId: v.string(),
    // The builder turn that produced this immutable artifact. Optional only
    // for rows written before callback fencing was deployed.
    turnId: v.optional(v.string()),
    status: v.string(),
    artifactPrefix: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    slug: v.optional(v.string()),
    metricsJson: v.optional(v.string()),
    // Immutable callback field used to distinguish an exact delivery replay
    // from a second payload reusing the same build id.
    callbackTitle: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_buildId", ["buildId"])
    .index("by_turnId", ["turnId"])
    .index("by_appId_and_createdAt", ["appId", "createdAt"])
    .index("by_ownerId_and_appId_and_createdAt", [
      "ownerId",
      "appId",
      "createdAt",
    ]),

  // Stella's web interior is a per-owner deployable. Build rows below are
  // immutable candidates; this small row is the only mutable routing state.
  // `routeRevision` is a compare-and-swap fence used by every promotion and
  // rollback so two clients can never silently overwrite each other.
  cloud_interior_deployables: defineTable({
    deployableId: v.string(),
    ownerId: v.string(),
    /**
     * Migration-only artifact namespace from the first routing design. It is
     * deliberately never returned to clients or accepted as a route key.
     */
    ownerHash: v.optional(v.string()),
    /**
     * Opaque capability for the owner's stable web URL. Optional while rows
     * created by the pre-capability schema are lazily backfilled.
     */
    stableRouteId: v.optional(v.string()),
    kind: v.literal("stella-interior"),
    activeBuildId: v.optional(v.string()),
    previousBuildId: v.optional(v.string()),
    routeRevision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_deployableId", ["deployableId"])
    .index("by_ownerId", ["ownerId"])
    .index("by_stableRouteId", ["stableRouteId"]),

  // Immutable build candidates for an owner's Stella interior. Activation is
  // represented exclusively by `cloud_interior_deployables`; a candidate is
  // never patched after insertion, even when it becomes active or previous.
  cloud_interior_builds: defineTable({
    buildId: v.string(),
    deployableId: v.string(),
    ownerId: v.string(),
    turnId: v.string(),
    threadId: v.string(),
    // Source revisions can be absent for the initial unversioned seed.
    sourceRevision: v.optional(v.string()),
    baseRevision: v.optional(v.string()),
    artifactPrefix: v.string(),
    artifactManifestJson: v.string(),
    // SHA-256 of the exact UTF-8 manifest JSON, independently recomputed by
    // Convex when the candidate is recorded.
    manifestSha256: v.string(),
    artifactDigest: v.string(),
    artifactSizeBytes: v.number(),
    bridgeAbi: v.number(),
    minShellVersion: v.string(),
    createdAt: v.number(),
  })
    .index("by_buildId", ["buildId"])
    .index("by_deployableId_and_createdAt", ["deployableId", "createdAt"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_ownerId_and_sourceRevision", ["ownerId", "sourceRevision"])
    .index("by_turnId", ["turnId"])
    .index("by_threadId_and_createdAt", ["threadId", "createdAt"]),

  agent_turns: defineTable({
    turnId: v.string(),
    sessionId: v.string(),
    ownerId: v.string(),
    conversationId: v.optional(v.string()),
    // Absent for plain-chat and spawned-agent turns; required only when the
    // turn targets a mini app (build/operation lanes).
    appId: v.optional(v.string()),
    prompt: v.string(),
    status: v.string(),
    lane: v.optional(v.string()),
    terminalKind: v.optional(v.string()),
    // Exact current capability that committed the terminal event. Persisting
    // its hash lets the durable terminal outbox replay after token expiry
    // without accepting a rotated/stale executor.
    terminalTokenHash: v.optional(v.string()),
    // Current physical executor capability, copied here as a durable receipt
    // when token rows rotate. Only exact service-auth terminal recovery may
    // use it after the short-lived token row expires.
    activeTokenHash: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    resultJson: v.optional(v.string()),
    // "chat" (orchestrator in the DO), "build" (legacy app build), or
    // "agent" (spawned general agent in a sandbox). Absent on legacy rows.
    kind: v.optional(v.string()),
    agentType: v.optional(v.string()),
    // Spawn placement for kind "agent" turns: cloud | app:<slug> |
    // project:<name> | stella | computer.
    workspace: v.optional(v.string()),
    threadId: v.optional(v.string()),
    /** Immutable generation of this concrete spawned-agent attempt. */
    attemptGeneration: v.optional(v.number()),
    parentTurnId: v.optional(v.string()),
    // Wake/lifecycle turns the UI must not render as user messages.
    hidden: v.optional(v.boolean()),
    // Who started this turn: "schedule" | "desktop" | "agent-thread" |
    // "probe". Absent for the signed-in composer.
    source: v.optional(v.string()),
    // Client-minted id for the message that started this turn. Threads through
    // to the DO so an optimistic bubble can be resolved against the journal
    // row, and makes a retried start idempotent instead of double-charged.
    clientMsgId: v.optional(v.string()),
    // Exact lifecycle authority for replay-fenced chat/build client ids. Old
    // rows are intentionally absent and therefore fail closed on dedupe.
    ownerGeneration: v.optional(v.string()),
    // Versioned SHA-256 of every semantic chat/composer input, including the
    // originally requested conversation authority. A client id may replay only
    // when this and ownerGeneration match exactly.
    chatIntentFingerprint: v.optional(v.string()),
    // Versioned SHA-256 of every semantic spawn-agent input. Legacy rows are
    // deliberately missing this field and therefore cannot be replayed: the
    // old partial comparison did not cover description, execution, or origin.
    spawnIntentFingerprint: v.optional(v.string()),
    /**
     * Immutable effective model route for this exact turn. This is what retry,
     * restart, token authorization, and executor dispatch consume.
     */
    execution: v.optional(cloudExecutionSelectionValidator),
    // Idempotency fence for a desktop pause control. A retry of the same
    // tool call must not stop a successor turn on this long-lived thread.
    cancelRequestId: v.optional(v.string()),
    /** Secret-free receipt for a fresh physical browser-resume attempt. */
    browserResume: v.optional(cloudBrowserResumeReceiptValidator),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_turnId", ["turnId"])
    .index("by_clientMsgId", ["clientMsgId"])
    .index("by_ownerId_and_clientMsgId", ["ownerId", "clientMsgId"])
    .index("by_sessionId_and_createdAt", ["sessionId", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    // Quota gates count per-lane: chat rows outnumber build rows by up to
    // 20x, so a mixed-lane window can't bound a per-lane count.
    .index("by_ownerId_and_lane_and_createdAt", [
      "ownerId",
      "lane",
      "createdAt",
    ])
    .index("by_conversationId_and_createdAt", ["conversationId", "createdAt"])
    .index("by_conversationId_and_ownerId_and_createdAt", [
      "conversationId",
      "ownerId",
      "createdAt",
    ])
    .index("by_threadId_and_createdAt", ["threadId", "createdAt"])
    .index("by_threadId_ownerGeneration_createdAt", [
      "threadId",
      "ownerGeneration",
      "createdAt",
    ])
    .index("by_threadId_ownerGeneration_cancelRequestId", [
      "threadId",
      "ownerGeneration",
      "cancelRequestId",
    ]),

  // Spawned-agent THREAD transcripts — private job state, never conversation
  // content. One row per AgentMessage produced inside a sandbox turn, keyed by
  // `conversationId = threadId`, and read back only to continue that thread
  // (`send_input`). The user-facing conversation transcript is not here: it
  // lives in the OrchestratorSession DO (see cloud_conversations above).
  //
  // The invariant this table's NAME now carries, and which
  // `appendThreadMessagesInternal` enforces: a spawned agent's turn token can
  // only ever write its own thread. It must never reach the parent user
  // conversation, where a hijacked sandbox could forge history the
  // orchestrator would reload as genuine context.
  cloud_thread_messages: defineTable({
    conversationId: v.string(),
    ownerId: v.string(),
    seq: v.number(),
    // Stable position inside one executor turn. Retries after a lost HTTP
    // response reuse this ordinal, so the append mutation can prove an exact
    // replay instead of duplicating durable history.
    ordinal: v.optional(v.number()),
    role: v.string(),
    payloadJson: v.string(),
    turnId: v.string(),
    createdAt: v.number(),
  })
    .index("by_conversationId_and_seq", ["conversationId", "seq"])
    .index("by_conversationId_and_ownerId_and_seq", [
      "conversationId",
      "ownerId",
      "seq",
    ])
    .index("by_turnId", ["turnId"])
    .index("by_turnId_and_ordinal", ["turnId", "ordinal"])
    // Account deletion drains by owner; without this the table could only be
    // reached through its threads, and a thread row lost to an earlier partial
    // purge would strand transcript rows forever.
    .index("by_ownerId", ["ownerId"]),

  // LEGACY, write-never, read-only by `drainLegacyCloudMessagesInternal`.
  //
  // This is the pre-DO conversation transcript. It is declared solely so its
  // rows stay typed and reachable long enough to be deleted: an undeclared
  // table keeps its documents, and abandoning user transcripts in a table no
  // code can name is exactly the failure this migration exists to stop.
  // Delete the table, the drain mutation, and its cron once every deployment
  // reports zero remaining rows.
  cloud_messages: defineTable({
    conversationId: v.string(),
    ownerId: v.string(),
    seq: v.number(),
    role: v.string(),
    payloadJson: v.string(),
    turnId: v.string(),
    hidden: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_conversationId_and_seq", ["conversationId", "seq"])
    .index("by_ownerId_and_seq", ["ownerId", "seq"])
    .index("by_conversationId_and_ownerId_and_seq", [
      "conversationId",
      "ownerId",
      "seq",
    ])
    .index("by_turnId", ["turnId"]),

  // Recall's cross-conversation index: one compact, searchable excerpt per
  // turn. Derived from the DO's journal and regenerable from it
  // (POST /conversations/:id/reindex) — never a second copy of truth, and
  // never read back into model context as history.
  cloud_message_excerpts: defineTable({
    ownerId: v.string(),
    conversationId: v.string(),
    turnId: v.string(),
    seqStart: v.number(),
    seqEnd: v.number(),
    searchText: v.string(),
    createdAt: v.number(),
  })
    .index("by_turnId", ["turnId"])
    .index("by_conversationId_and_seqStart", ["conversationId", "seqStart"])
    .index("by_conversationId_and_ownerId_and_seqStart", [
      "conversationId",
      "ownerId",
      "seqStart",
    ])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    // `filterFields: ["ownerId"]` IS the authorization: the owner equality is
    // applied inside the search predicate, so there is no code path that can
    // rank or return another owner's excerpts.
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["ownerId"],
    }),

  // Short-lived per-turn credentials. Only the SHA-256 hash is stored; the
  // raw token travels to the executor and authenticates relay model calls
  // and event/message callbacks for exactly one turn.
  cloud_turn_tokens: defineTable({
    tokenHash: v.string(),
    ownerId: v.string(),
    /** Owner-data generation captured when this capability was minted. */
    ownerGeneration: v.optional(v.string()),
    turnId: v.string(),
    agentType: v.string(),
    /**
     * The only model route this capability authorizes. Optional solely for
     * tokens minted by a rolling deployment before route binding existed.
     */
    execution: v.optional(cloudExecutionSelectionValidator),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_turnId_and_ownerId", ["turnId", "ownerId"])
    // Deleting an account must not leave live credentials behind for up to the
    // token TTL; the expiry cron is a floor, not a deletion path.
    .index("by_ownerId", ["ownerId"]),

  // Durable spawned-agent threads (cloud analog of the desktop runtime's
  // agent threads). One row per spawn_agent call from the cloud orchestrator.
  cloud_agent_threads: defineTable({
    threadId: v.string(),
    ownerId: v.string(),
    /** Exact owner-data epoch that admitted this thread. */
    ownerGeneration: v.optional(v.string()),
    conversationId: v.string(),
    // Absent when the desktop dispatched the agent: there is no cloud turn
    // above it, only the local chat that asked for it.
    parentTurnId: v.optional(v.string()),
    // Durable origin metadata for desktop-dispatched threads. Optional for
    // rolling compatibility with rows and installed clients from before local
    // completion recovery existed.
    originDeviceId: v.optional(v.string()),
    originConversationId: v.optional(v.string()),
    // Set only after the originating desktop has durably persisted the
    // terminal lifecycle result. Until then the thread stays in that device's
    // reactive recovery query across disconnects and process restarts.
    originDeliveryAckAt: v.optional(v.number()),
    description: v.string(),
    workspace: v.string(),
    agentType: v.string(),
    /**
     * Thread-level inheritance snapshot. Continuations keep this exact route;
     * a deliberate per-spawn override replaces it for that new turn.
     */
    execution: v.optional(cloudExecutionSelectionValidator),
    /**
     * Desktop-computer attempts reuse one thread row across follow-ups. The
     * generation fences late completion/cancel mutations from an older local
     * attempt after a newer attempt has made the row running again.
     */
    attemptGeneration: v.optional(v.number()),
    /**
     * Expiring admission lease for a real cloud sandbox. Desktop-computer rows
     * store the explicit marker `0`; missing is reserved for rolling-deploy
     * rows created before lease-backed admission existed.
     */
    sandboxLeaseExpiresAt: v.optional(v.number()),
    /**
     * Restart-safe cursor for the rolling-schema owner-less event cascade.
     * The purge operation/generation scope prevents a later reset/delete job
     * from trusting an opaque cursor captured by an older lifecycle fence.
     */
    legacyEventPurgeCursor: v.optional(v.string()),
    legacyEventPurgeOperationId: v.optional(v.string()),
    legacyEventPurgeGeneration: v.optional(v.string()),
    status: v.string(),
    resultJson: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_threadId", ["threadId"])
    .index("by_conversationId_and_updatedAt", ["conversationId", "updatedAt"])
    .index("by_conversationId_and_ownerId_and_updatedAt", [
      "conversationId",
      "ownerId",
      "updatedAt",
    ])
    .index("by_conversationId_and_ownerId_and_status_and_updatedAt", [
      "conversationId",
      "ownerId",
      "status",
      "updatedAt",
    ])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_ownerGeneration_originDeviceId_ackAt_updatedAt", [
      "ownerId",
      "ownerGeneration",
      "originDeviceId",
      "originDeliveryAckAt",
      "updatedAt",
    ])
    .index("by_ownerId_and_workspace_and_status", [
      "ownerId",
      "workspace",
      "status",
    ])
    .index("by_owner_status_lease_updatedAt", [
      "ownerId",
      "status",
      "sandboxLeaseExpiresAt",
      "updatedAt",
    ])
    .index("by_ownerId_and_originDeviceId_and_updatedAt", [
      "ownerId",
      "originDeviceId",
      "updatedAt",
    ])
    .index("by_ownerId_originDeviceId_ackAt_updatedAt", [
      "ownerId",
      "originDeviceId",
      "originDeliveryAckAt",
      "updatedAt",
    ]),

  agent_events: defineTable({
    /**
     * Rolling-migration field. Every current writer supplies the owning turn's
     * ownerId; legacy rows are repaired by `agent_event_ownership` before this
     * becomes required in a follow-up schema push.
     */
    ownerId: v.optional(v.string()),
    turnId: v.string(),
    sessionId: v.string(),
    seq: v.number(),
    kind: v.string(),
    payloadJson: v.string(),
    createdAt: v.number(),
  })
    .index("by_turnId_and_seq", ["turnId", "seq"])
    .index("by_turnId_and_ownerId_and_seq", ["turnId", "ownerId", "seq"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_sessionId_and_createdAt", ["sessionId", "createdAt"])
    // Reset/delete must be able to drain rolling-schema events whose only
    // surviving owner locator is a spawned-agent thread. Keeping ownerId in
    // the index lets the purge walk exactly legacy owner-less rows without
    // touching a foreign owner's current event stream that happens to carry a
    // conflicting legacy session id.
    .index("by_sessionId_and_ownerId_and_createdAt", [
      "sessionId",
      "ownerId",
      "createdAt",
    ]),

  /**
   * Singleton cursor/lease for bounded legacy agent-event ownership repair.
   * Persisting the cursor prevents permanently unresolved rows at the front of
   * the owner-less index from starving later repairable rows across cron runs.
   */
  agent_event_ownership_maintenance: defineTable({
    key: v.string(),
    phase: v.union(v.literal("repair"), v.literal("gc")),
    cursor: v.optional(v.string()),
    leaseId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  cloud_app_storage: defineTable({
    appId: v.string(),
    ownerId: v.string(),
    userId: v.string(),
    key: v.string(),
    valueJson: v.string(),
    sizeBytes: v.number(),
    updatedAt: v.number(),
  })
    .index("by_appId_and_userId_and_key", ["appId", "userId", "key"])
    .index("by_appId_and_userId", ["appId", "userId"])
    .index("by_userId_and_updatedAt", ["userId", "updatedAt"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_appId_and_updatedAt", [
      "ownerId",
      "appId",
      "updatedAt",
    ]),

  cloud_app_operations: defineTable({
    appId: v.string(),
    ownerId: v.string(),
    manifestJson: v.string(),
    sizeBytes: v.number(),
    updatedAt: v.number(),
  })
    .index("by_appId", ["appId"])
    .index("by_ownerId_and_appId", ["ownerId", "appId"]),

  cloud_app_op_invocations: defineTable({
    invocationId: v.string(),
    appId: v.string(),
    ownerId: v.string(),
    turnId: v.string(),
    name: v.string(),
    argsJson: v.string(),
    status: v.string(),
    resultJson: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_invocationId", ["invocationId"])
    .index("by_appId_and_status_and_createdAt", [
      "appId",
      "status",
      "createdAt",
    ])
    .index("by_ownerId_and_appId_and_status_and_createdAt", [
      "ownerId",
      "appId",
      "status",
      "createdAt",
    ])
    .index("by_turnId", ["turnId"])
    .index("by_ownerId_and_appId_and_createdAt", [
      "ownerId",
      "appId",
      "createdAt",
    ])
    .index("by_ownerId_and_turnId_and_createdAt", [
      "ownerId",
      "turnId",
      "createdAt",
    ]),

  cloud_failure_alerts: defineTable({
    windowStartedAt: v.number(),
    windowEndedAt: v.number(),
    failureCount: v.number(),
    threshold: v.number(),
    status: v.union(v.literal("open"), v.literal("resolved")),
    summary: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_status_and_createdAt", ["status", "createdAt"])
    .index("by_createdAt", ["createdAt"]),
};
