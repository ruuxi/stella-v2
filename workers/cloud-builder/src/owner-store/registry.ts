/**
 * What a backend domain contributes: SQLite migrations for the owner's
 * database, calls, views and background jobs. Domains register here; the
 * owner object (`OwnerStore`) and the worker's RPC route read the result.
 *
 * Calls and views are typed against `@stella/contracts/backend/api`, so the
 * registry cannot drift from what clients call.
 */

import type {
  CallArgs,
  CallName,
  CallResult,
  ViewArgs,
  ViewName,
  ViewResult,
} from "@stella/contracts/backend/api";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import type { MemoryPolicyChange } from "@stella/contracts/turn-plane/memory-policy";
import type { Parser } from "./args.js";

/** The verified user behind a request. `null` for jobs and internal calls. */
export type OwnerCaller = {
  ownerId: string;
  subject: string;
  sessionId: string;
  isAnonymous: boolean;
  expiresAtMs: number;
  /** The identity ladder rung the token claims (0 anonymous, 1 email, 2 social). */
  identityLevel?: import("@stella/contracts/gateway/api").IdentityLevel;
  /** The token's `iat`, for session revocation. */
  issuedAtMs?: number;
};

export type SqlValue = string | number | null | ArrayBuffer;

export type OwnerDbReader = {
  all<T extends Record<string, SqlValue>>(query: string, ...params: SqlValue[]): T[];
  one<T extends Record<string, SqlValue>>(query: string, ...params: SqlValue[]): T | null;
};

export type OwnerDb = OwnerDbReader & {
  /** A write. Marks the owner's views for a recompute. */
  run(query: string, ...params: SqlValue[]): void;
};

export type OwnerJobs = {
  /**
   * Run `kind` at `runAt`. With `id`, scheduling replaces any pending job
   * with that id, so one logical job never runs twice.
   */
  schedule(kind: string, runAt: number, payload?: unknown, options?: { id?: string }): string;
  cancel(id: string): void;
};

/**
 * What the owner object offers domains beyond its database. Grows as domains
 * move in; the snapshot shrinks as its fields become local tables.
 */
export type OwnerHost = {
  /** The owner's control-plane snapshot (plan, generation, devices). */
  snapshot(): Promise<OwnerSnapshot>;
  /**
   * Start an agent attempt the domain already recorded, on its BuildSession.
   * Throws on refusal; `retryable` says whether trying again can help.
   */
  dispatchAgentTurn(input: AgentTurnDispatch): Promise<void>;
  /** The owner's devices as execution destinations, with live presence. */
  deviceDestinations(): Promise<import("@stella/contracts/turn-plane/placement").DeviceDestination[]>;
  /**
   * Offer one recorded agent attempt to a named device through the gate's
   * dispatch. Throws `DispatchError` when the device cannot take it.
   */
  dispatchDeviceAgentTurn(input: DeviceAgentTurnDispatch): Promise<{ dispatchId: string }>;
  /**
   * New input, or a framed message from another agent, for a cloud agent's
   * running attempt; false when none is running. Refused, retryably, while
   * a container agent is starting up or finishing.
   */
  steerAgentTurn(input: {
    threadId: string;
    conversationId: string;
    ownerGeneration: string;
    messageId: string;
    text: string;
  }): Promise<boolean>;
  /** New input for a device attempt that is running. */
  steerDeviceAgentTurn(input: {
    dispatchId: string;
    messageId: string;
    text: string;
  }): Promise<{ delivered: boolean; reason?: "not_running" | "unreachable" }>;
  /**
   * A framed message for an agent a device runs locally (started by its own
   * Stella, so there is no dispatch). `unreachable` means no live socket;
   * `timeout` that no answer came, so it may still have landed.
   */
  messageLocalAgent(input: LocalAgentMessage): Promise<{
    outcome: import("@stella/contracts/turn-plane/placement").AgentMessageDeviceOutcome | "unreachable" | "timeout";
  }>;
  /** Stop a device attempt's dispatch. Idempotent per `cancelRequestId`. */
  cancelDeviceAgentTurn(input: {
    dispatchId: string;
    cancelRequestId: string;
    reason: string;
  }): Promise<void>;
  /**
   * Hand a finished thread's report to the cloud agent or conversation that
   * spawned it. Desktop requesters read their own `forDevice` delivery.
   */
  deliverAgentCompletion(input: AgentCompletionDelivery): Promise<void>;
  /** Stop one exact running attempt. `changed` means it is no longer that attempt. */
  cancelAgentTurn(input: {
    threadId: string;
    conversationId: string;
    turnId: string;
    attemptGeneration: number;
    ownerGeneration: string;
    cancelRequestId: string;
  }): Promise<"canceled" | "changed">;
  /** Append a card to a conversation's journal. Best effort. */
  postConversationCard(input: {
    conversationId: string;
    ownerGeneration: string;
    sourceTurnId: string;
    card: unknown;
  }): Promise<void>;
  /**
   * The owner's cloud home content moved to `revision` under
   * `ownerGeneration`, so cached home context must be rebuilt.
   */
  homeChanged(ownerGeneration: string, revision: number): Promise<void>;
  /**
   * Change the memory switch or start a wipe through the gate's memory
   * policy, which closes model grants first. Throws `RpcError` on refusal.
   */
  changeMemoryPolicy(change: MemoryPolicyChange): Promise<void>;
  /**
   * Queue an agent's framed message as a hidden wake turn on a cloud
   * conversation's Stella. Idempotent per `clientMsgId`; throws `RpcError`
   * when the conversation refuses it.
   */
  startAgentMessageTurn(input: {
    ownerGeneration: string;
    conversationId: string;
    clientMsgId: string;
    prompt: string;
  }): Promise<void>;
  /** Start a scheduled prompt as a turn, in a cloud chat or on a named desktop. */
  startScheduledTurn(input: ScheduledTurnStart): Promise<void>;
  /**
   * One pass of a reset or deletion across every store (src/owner-purge.ts),
   * rejoining the fence `requestId` opened. Returns the stores still pending.
   */
  purgeOwner(mode: OwnerPurgeMode, requestId: string): Promise<{ pending: string[] }>;
};

export type LocalAgentMessage = {
  deviceId: string;
  threadId: string;
  ownerGeneration: string;
  /** Stable across redeliveries; the device dedupes on it. */
  messageId: string;
  text: string;
};

export type ScheduledTurnStart = {
  ownerGeneration: string;
  conversationId: string;
  /** `schedule:<fireId>`, so a retried fire starts the same turn. */
  clientMsgId: string;
  prompt: string;
  title: string;
  /** Run on this desktop; absent runs in the cloud. */
  targetDeviceId?: string;
};

export type AgentTurnDispatch = {
  ownerGeneration: string;
  conversationId: string;
  threadId: string;
  turnId: string;
  attemptGeneration: number;
  clientMsgId: string;
  description: string;
  prompt: string;
  execution: import("@stella/contracts/agent-engine").CloudExecutionSelection;
  originDeviceId?: string;
  originConversationId?: string;
  /** The cloud agent that started the thread, which its report returns to. */
  parentThreadId?: string;
  /** Resume a hosted-browser wait with this answer. */
  browserResume?: import("@stella/contracts/cloud-browser").CloudBrowserResumeReceipt;
};

export type DeviceAgentTurnDispatch = {
  ownerGeneration: string;
  conversationId: string;
  threadId: string;
  turnId: string;
  description: string;
  prompt: string;
  targetDeviceId: string;
  /** The desktop that asked, if any; absent for a cloud requester. */
  requestingDeviceId?: string;
  /** The requester's `spawn_agent` model the device runs the agent on. */
  model?: string;
  /**
   * Drive paths of the spawning turn's attachments. The device resolves these
   * to signed GETs and materializes them into its own attachment cache, so the
   * agent is handed an absolute local path rather than a drive path it has no
   * way to interpret.
   */
  attachments?: readonly string[];
  requeue?: number;
};

export type AgentCompletionDelivery = {
  ownerGeneration: string;
  conversationId: string;
  threadId: string;
  attemptGeneration: number;
  description: string;
  status: "completed" | "failed" | "canceled";
  resultJson?: string;
  errorMessage?: string;
  threadUpdatedAt: number;
};

export class DispatchError extends Error {
  readonly retryable: boolean;
  readonly code: string | undefined;
  constructor(message: string, retryable: boolean, code?: string) {
    super(message);
    this.name = "DispatchError";
    this.retryable = retryable;
    this.code = code;
  }
}

export type OwnerContext = {
  ownerId: string;
  host: OwnerHost;
  caller: OwnerCaller | null;
  db: OwnerDb;
  jobs: OwnerJobs;
  env: Cloudflare.Env;
  storage: DurableObjectStorage;
  now: number;
};

export type OwnerViewContext = {
  ownerId: string;
  caller: OwnerCaller | null;
  db: OwnerDbReader;
  env: Cloudflare.Env;
  now: number;
};

export type GlobalContext = {
  caller: OwnerCaller;
  env: Cloudflare.Env;
  now: number;
};

type Access = {
  /** Refuse anonymous callers. */
  requireAccount?: boolean;
};

export type OwnerCallDef<K extends CallName> = Access & {
  scope: "owner";
  /** Largest request body this call accepts. Default 1 MiB. */
  maxBodyBytes?: number;
  parse: Parser<CallArgs<K>>;
  handler: (ctx: OwnerContext, args: CallArgs<K>) => CallResult<K> | Promise<CallResult<K>>;
};

/** Runs in the Worker, for functions over global data (D1, catalogs). */
export type GlobalCallDef<K extends CallName> = Access & {
  scope: "global";
  parse: Parser<CallArgs<K>>;
  handler: (ctx: GlobalContext, args: CallArgs<K>) => CallResult<K> | Promise<CallResult<K>>;
};

export type CallDef<K extends CallName> = OwnerCallDef<K> | GlobalCallDef<K>;

export type ViewDef<K extends ViewName> = Access & {
  parse: Parser<ViewArgs<K>>;
  /** Synchronous: a view is a read of the owner's database. */
  read: (ctx: OwnerViewContext, args: ViewArgs<K>) => ViewResult<K>;
};

export type JobDef = {
  run: (ctx: OwnerContext, payload: unknown) => void | Promise<void>;
  /** Attempts before the job is dropped and logged. Default 20. */
  maxAttempts?: number;
};

export type Migration = {
  /** Stable, unique across domains: `<domain>.<n>-<what>`. */
  id: string;
  statements: string[];
};

/**
 * A server-internal operation: called by this Worker's own code (agent tools,
 * Worker routes, the turn broker) through `OwnerGate.ownerInternal`, never by
 * clients. Runs with a null caller; parse `args` before trusting them.
 */
export type InternalDef = (ctx: OwnerContext, args: unknown) => unknown;

/** How an owner object is called from the rest of the Worker. */
export type OwnerInternalCall = (name: string, args: unknown) => Promise<unknown>;

export type OwnerPurgeMode = "reset" | "delete";

/**
 * Delete this domain's data for a reset or account deletion. Idempotent;
 * `pending` asks to be called again (for example, an R2 sweep that stopped
 * at its batch limit).
 */
export type PurgeDef = (
  ctx: OwnerContext,
  mode: OwnerPurgeMode,
) => { pending: boolean } | Promise<{ pending: boolean }>;

export type OwnerDomain = {
  name: string;
  migrations?: Migration[];
  calls?: { [K in CallName]?: CallDef<K> };
  views?: { [K in ViewName]?: ViewDef<K> };
  jobs?: Record<string, JobDef>;
  internal?: Record<string, InternalDef>;
  purge?: PurgeDef;
};

export type OwnerRegistry = {
  migrations: Migration[];
  calls: Map<string, CallDef<CallName>>;
  views: Map<string, ViewDef<ViewName>>;
  jobs: Map<string, JobDef>;
  internal: Map<string, InternalDef>;
  /** Purge hooks by domain name, in registration order. */
  purges: Map<string, PurgeDef>;
};

export const createOwnerRegistry = (domains: OwnerDomain[]): OwnerRegistry => {
  const registry: OwnerRegistry = {
    migrations: [],
    calls: new Map(),
    views: new Map(),
    jobs: new Map(),
    internal: new Map(),
    purges: new Map(),
  };
  const migrationIds = new Set<string>();
  for (const domain of domains) {
    for (const migration of domain.migrations ?? []) {
      if (migrationIds.has(migration.id)) {
        throw new Error(`Duplicate owner migration ${migration.id}.`);
      }
      migrationIds.add(migration.id);
      registry.migrations.push(migration);
    }
    for (const [name, def] of Object.entries(domain.calls ?? {})) {
      if (!def) continue;
      if (registry.calls.has(name)) throw new Error(`Duplicate call ${name}.`);
      registry.calls.set(name, def as CallDef<CallName>);
    }
    for (const [name, def] of Object.entries(domain.views ?? {})) {
      if (!def) continue;
      if (registry.views.has(name)) throw new Error(`Duplicate view ${name}.`);
      registry.views.set(name, def as ViewDef<ViewName>);
    }
    for (const [kind, def] of Object.entries(domain.jobs ?? {})) {
      if (registry.jobs.has(kind)) throw new Error(`Duplicate job ${kind}.`);
      registry.jobs.set(kind, def);
    }
    for (const [name, def] of Object.entries(domain.internal ?? {})) {
      if (registry.internal.has(name)) throw new Error(`Duplicate internal operation ${name}.`);
      registry.internal.set(name, def);
    }
    if (domain.purge) {
      if (registry.purges.has(domain.name)) throw new Error(`Duplicate purge for ${domain.name}.`);
      registry.purges.set(domain.name, domain.purge);
    }
  }
  return registry;
};
