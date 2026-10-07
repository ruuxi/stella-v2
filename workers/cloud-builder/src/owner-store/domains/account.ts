/**
 * The owner's account state, of which this object is the authority:
 *
 * - **Generation.** `owner_state.generation` names the owner's current data.
 *   `account.reset` rotates it, closes the owner to writes and runs the
 *   `account.purge` job, which purges every store (src/owner-purge.ts) and
 *   reopens the owner when nothing is pending.
 * - **Closed.** Account deletion (`OwnerGate.closeOwner`) closes the owner for
 *   good and runs the same job in delete mode.
 * - **Identity.** The owner's identity level, as the caller's last verified
 *   token said.
 * - **Session revocation.** `account.sessionsRevoked` records a floor; tokens
 *   issued before it are refused (their 15-minute expiry bounds the rest).
 */

import type { IdentityLevel } from "@stella/contracts/gateway/api";
import { empty } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerCaller, OwnerContext, OwnerDb, OwnerDomain, OwnerPurgeMode } from "../registry.js";
import { SCHEDULE_FIRE_JOB } from "./schedules.js";

export const ACCOUNT_PURGE_JOB = "account.purge";
const ACCOUNT_PURGE_JOB_ID = "account.purge";

const ACCOUNT_MIGRATION = {
  id: "account.1-owner-state",
  statements: [
    `CREATE TABLE owner_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       generation TEXT NOT NULL,
       writable INTEGER NOT NULL,
       closed INTEGER NOT NULL,
       is_anonymous INTEGER NOT NULL,
       identity_level INTEGER NOT NULL,
       min_iat_ms INTEGER NOT NULL,
       purge_request_id TEXT,
       purge_mode TEXT
     )`,
  ],
};

export type OwnerState = {
  generation: string;
  writable: boolean;
  closed: boolean;
  identityLevel: IdentityLevel;
  minIatMs: number;
  purge: { requestId: string; mode: OwnerPurgeMode } | null;
};

type OwnerStateRow = {
  generation: string;
  writable: number;
  closed: number;
  is_anonymous: number;
  identity_level: number;
  min_iat_ms: number;
  purge_request_id: string | null;
  purge_mode: string | null;
};

const toIdentityLevel = (value: unknown): IdentityLevel =>
  value === 1 || value === 2 || value === 3 ? value : 0;

/** The owner's state, created on first read: a fresh generation, writable. */
export const readOwnerState = (db: OwnerDb): OwnerState => {
  let row = db.one<OwnerStateRow>("SELECT * FROM owner_state WHERE id = 1");
  if (!row) {
    db.run(
      `INSERT INTO owner_state (id, generation, writable, closed, is_anonymous, identity_level, min_iat_ms)
       VALUES (1, ?, 1, 0, 0, 0, 0)`,
      crypto.randomUUID(),
    );
    row = db.one<OwnerStateRow>("SELECT * FROM owner_state WHERE id = 1")!;
  }
  return {
    generation: row.generation,
    writable: row.writable === 1,
    closed: row.closed === 1,
    identityLevel: toIdentityLevel(row.identity_level),
    minIatMs: row.min_iat_ms,
    purge:
      row.purge_request_id && (row.purge_mode === "reset" || row.purge_mode === "delete")
        ? { requestId: row.purge_request_id, mode: row.purge_mode }
        : null,
  };
};

/** Record who the caller's verified token says the owner is. */
export const noteCallerIdentity = (
  db: OwnerDb,
  caller: { identityLevel?: IdentityLevel },
): void => {
  const state = readOwnerState(db);
  const identityLevel = caller.identityLevel ?? Math.max(1, state.identityLevel);
  if (state.identityLevel === identityLevel) return;
  db.run("UPDATE owner_state SET is_anonymous = 0, identity_level = ? WHERE id = 1", identityLevel);
};

/** True when the caller's token predates the owner's last sign-out-everywhere. */
export const callerSessionRevoked = (db: OwnerDb, caller: Pick<OwnerCaller, "issuedAtMs">): boolean => {
  const { minIatMs } = readOwnerState(db);
  // JWT `iat` has second precision.
  return minIatMs > 0 && (caller.issuedAtMs ?? 0) < Math.floor(minIatMs / 1000) * 1000;
};

/**
 * Start a reset or a deletion: fence the owner off and queue the purge. A
 * deletion joins a reset that is still running, so they share one fence.
 */
export const beginOwnerPurge = (ctx: OwnerContext, mode: OwnerPurgeMode): void => {
  const state = readOwnerState(ctx.db);
  if (mode === "reset") {
    if (state.closed) throw new RpcError("CONFLICT", "Your account is being deleted.");
    if (state.purge) return;
    const generation = crypto.randomUUID();
    ctx.db.run(
      `UPDATE owner_state SET generation = ?, writable = 0, purge_request_id = ?, purge_mode = 'reset' WHERE id = 1`,
      generation,
      `reset:${generation}`,
    );
  } else {
    ctx.db.run(
      `UPDATE owner_state SET writable = 0, closed = 1, purge_request_id = ?, purge_mode = 'delete' WHERE id = 1`,
      state.purge?.requestId ?? `close:${ctx.ownerId}`,
    );
  }
  ctx.jobs.schedule(ACCOUNT_PURGE_JOB, ctx.now, {}, { id: ACCOUNT_PURGE_JOB_ID });
};

/** Pending scheduled fires must not start turns for data that is going away. */
const cancelScheduleFires = (ctx: OwnerContext): void => {
  const fires = ctx.db.all<{ id: string }>("SELECT id FROM owner_jobs WHERE kind = ?", SCHEDULE_FIRE_JOB);
  for (const fire of fires) ctx.jobs.cancel(fire.id);
};

const resetAccount = (ctx: OwnerContext): null => {
  // The sensitive-action limit: five a minute.
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "account.reset",
    { count: 5, windowMs: 60_000 },
    "Too many account reset attempts. Please wait a minute and try again.",
  );
  beginOwnerPurge(ctx, "reset");
  cancelScheduleFires(ctx);
  return null;
};

/** One purge pass; throws while stores are pending so the job retries with backoff. */
const runAccountPurge = async (ctx: OwnerContext): Promise<void> => {
  const { purge } = readOwnerState(ctx.db);
  if (!purge) return;
  const { pending } = await ctx.host.purgeOwner(purge.mode, purge.requestId);
  if (pending.length > 0) throw new Error(`Owner ${purge.mode} is waiting on ${pending.join(", ")}.`);
  ctx.db.run(
    `UPDATE owner_state SET purge_request_id = NULL, purge_mode = NULL, writable = ? WHERE id = 1 AND purge_request_id = ?`,
    purge.mode === "reset" ? 1 : 0,
    purge.requestId,
  );
};

const parseSessionsRevoked = (args: unknown): { minIatMs: number } => {
  const minIatMs = (args as { minIatMs?: unknown } | null)?.minIatMs;
  if (typeof minIatMs !== "number" || !Number.isSafeInteger(minIatMs) || minIatMs <= 0) {
    throw new RpcError("BAD_REQUEST", "minIatMs must be a timestamp.");
  }
  return { minIatMs };
};

export const accountDomain: OwnerDomain = {
  name: "account",
  migrations: [ACCOUNT_MIGRATION],
  calls: {
    "account.reset": {
      scope: "owner",
      parse: empty(),
      handler: resetAccount,
    },
  },
  internal: {
    /** Better Auth's revoke-sessions: refuse every token issued before `minIatMs`. */
    "account.sessionsRevoked": (ctx, args) => {
      const { minIatMs } = parseSessionsRevoked(args);
      readOwnerState(ctx.db);
      ctx.db.run("UPDATE owner_state SET min_iat_ms = MAX(min_iat_ms, ?) WHERE id = 1", minIatMs);
      return null;
    },
  },
  jobs: {
    [ACCOUNT_PURGE_JOB]: { run: runAccountPurge, maxAttempts: 100 },
  },
};
