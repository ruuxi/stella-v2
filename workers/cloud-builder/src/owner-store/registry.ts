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
import type { Parser } from "./args.js";

/** The verified user behind a request. `null` for jobs and internal calls. */
export type OwnerCaller = {
  ownerId: string;
  subject: string;
  sessionId: string;
  isAnonymous: boolean;
  expiresAtMs: number;
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

export type OwnerContext = {
  ownerId: string;
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

export type OwnerDomain = {
  name: string;
  migrations?: Migration[];
  calls?: { [K in CallName]?: CallDef<K> };
  views?: { [K in ViewName]?: ViewDef<K> };
  jobs?: Record<string, JobDef>;
};

export type OwnerRegistry = {
  migrations: Migration[];
  calls: Map<string, CallDef<CallName>>;
  views: Map<string, ViewDef<ViewName>>;
  jobs: Map<string, JobDef>;
};

export const createOwnerRegistry = (domains: OwnerDomain[]): OwnerRegistry => {
  const registry: OwnerRegistry = {
    migrations: [],
    calls: new Map(),
    views: new Map(),
    jobs: new Map(),
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
  }
  return registry;
};
