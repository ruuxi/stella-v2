/**
 * The owner's database, hosted inside the owner's Durable Object
 * (`OwnerGate`). One instance per owner object.
 *
 * - **Schema:** domain migrations run once, in registration order, tracked by
 *   id in `_owner_migrations`.
 * - **Calls:** `call()` parses arguments, runs the handler against this
 *   owner's SQLite, then pushes any view that changed.
 * - **Views:** live sockets (tag `live`) subscribe to views. Subscriptions
 *   live in `owner_live_subs` so they survive hibernation. After every write,
 *   each open subscription is rerun and its value is sent only when its hash
 *   moved.
 * - **Jobs:** `owner_jobs` are the owner's scheduled work. The owner
 *   object's single alarm fires at `nextDeadline()` and calls `onAlarm()`.
 */

import type { RpcResponse } from "@stella/contracts/backend/protocol";
import {
  LIVE_CLOSE,
  LIVE_MAX_FRAME_BYTES,
  LIVE_MAX_SUBSCRIPTIONS,
  LIVE_SUBPROTOCOL,
  type LiveClientFrame,
  type LiveServerFrame,
} from "@stella/contracts/backend/protocol";
import { RpcError, toBackendError } from "./errors.js";
import type {
  OwnerCaller,
  OwnerContext,
  OwnerDb,
  OwnerHost,
  OwnerJobs,
  OwnerRegistry,
  OwnerViewContext,
  SqlValue,
} from "./registry.js";

export const LIVE_SOCKET_TAG = "live";
/** Ask for a fresh token this long before the current one expires. */
const LIVE_REAUTH_LEAD_MS = 2 * 60_000;
const JOB_BATCH = 32;
const JOB_DEFAULT_MAX_ATTEMPTS = 20;
const JOB_MAX_BACKOFF_MS = 60 * 60_000;

const PLATFORM_DDL = [
  `CREATE TABLE IF NOT EXISTS _owner_migrations (
     id TEXT PRIMARY KEY,
     applied_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS owner_jobs (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     run_at INTEGER NOT NULL,
     payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS owner_jobs_run_at ON owner_jobs (run_at)`,
  `CREATE TABLE IF NOT EXISTS owner_live_subs (
     conn_id TEXT NOT NULL,
     sub_id TEXT NOT NULL,
     view TEXT NOT NULL,
     args TEXT NOT NULL,
     hash TEXT,
     PRIMARY KEY (conn_id, sub_id)
   )`,
];

type LiveAttachment = {
  kind: "live";
  connId: string;
  caller: OwnerCaller;
  reauthSent?: boolean;
};

type LiveSubRow = {
  conn_id: string;
  sub_id: string;
  view: string;
  args: string;
  hash: string | null;
};

type JobRow = {
  id: string;
  kind: string;
  run_at: number;
  payload: string;
  attempts: number;
};

export type OwnerStoreLog = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown>,
) => void;

export type OwnerStoreOptions = {
  ctx: DurableObjectState;
  env: Cloudflare.Env;
  ownerId: () => string;
  registry: OwnerRegistry;
  host: OwnerHost;
  /** Verifies a refreshed JWT sent on a live socket. */
  verifyToken: (token: string) => Promise<OwnerCaller | null>;
  log?: OwnerStoreLog;
};

/** Two FNV-1a passes with different offsets: a cheap, synchronous change hash. */
export const valueHash = (text: string): string => {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x01000193) ^ (b >>> 13);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
};

const encodeJson = (value: unknown): string => JSON.stringify(value ?? null);

export class OwnerStore {
  private readonly ctx: DurableObjectState;
  private readonly env: Cloudflare.Env;
  private readonly ownerIdOf: () => string;
  private readonly registry: OwnerRegistry;
  private readonly host: OwnerHost;
  private readonly verifyToken: OwnerStoreOptions["verifyToken"];
  private readonly log: OwnerStoreLog;
  private schemaReady = false;
  private dirty = false;
  private flushQueued = false;

  constructor(options: OwnerStoreOptions) {
    this.ctx = options.ctx;
    this.env = options.env;
    this.ownerIdOf = options.ownerId;
    this.registry = options.registry;
    this.host = options.host;
    this.verifyToken = options.verifyToken;
    this.log = options.log ?? (() => {});
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  ensureSchema(): void {
    if (this.schemaReady) return;
    for (const statement of PLATFORM_DDL) this.sql.exec(statement);
    const applied = new Set(
      this.sql
        .exec<{ id: string }>("SELECT id FROM _owner_migrations")
        .toArray()
        .map((row) => row.id),
    );
    for (const migration of this.registry.migrations) {
      if (applied.has(migration.id)) continue;
      this.transaction(() => {
        for (const statement of migration.statements) this.sql.exec(statement);
        this.sql.exec(
          "INSERT INTO _owner_migrations (id, applied_at) VALUES (?, ?)",
          migration.id,
          Date.now(),
        );
      });
    }
    this.schemaReady = true;
  }

  private transaction<T>(fn: () => T): T {
    const storage = this.ctx.storage as DurableObjectStorage & {
      transactionSync?: <R>(closure: () => R) => R;
    };
    return typeof storage.transactionSync === "function"
      ? storage.transactionSync(fn)
      : fn();
  }

  private reader(): OwnerDb {
    const sql = this.sql;
    return {
      all: <T extends Record<string, SqlValue>>(query: string, ...params: SqlValue[]) =>
        sql.exec<T>(query, ...params).toArray(),
      one: <T extends Record<string, SqlValue>>(query: string, ...params: SqlValue[]) =>
        sql.exec<T>(query, ...params).toArray()[0] ?? null,
      run: (query: string, ...params: SqlValue[]) => {
        sql.exec(query, ...params);
        this.dirty = true;
      },
    };
  }

  private jobs(): OwnerJobs {
    return {
      schedule: (kind, runAt, payload, options) => {
        if (!this.registry.jobs.has(kind)) {
          throw new Error(`Unknown owner job kind ${kind}.`);
        }
        const id = options?.id ?? crypto.randomUUID();
        this.sql.exec(
          `INSERT INTO owner_jobs (id, kind, run_at, payload, attempts)
             VALUES (?, ?, ?, ?, 0)
           ON CONFLICT (id) DO UPDATE SET
             kind = excluded.kind, run_at = excluded.run_at,
             payload = excluded.payload, attempts = 0`,
          id,
          kind,
          Math.max(0, Math.floor(runAt)),
          encodeJson(payload),
        );
        return id;
      },
      cancel: (id) => {
        this.sql.exec("DELETE FROM owner_jobs WHERE id = ?", id);
      },
    };
  }

  /** The context a call or job runs with. */
  context(caller: OwnerCaller | null, now = Date.now()): OwnerContext {
    this.ensureSchema();
    return {
      ownerId: this.ownerIdOf(),
      host: this.host,
      caller,
      db: this.reader(),
      jobs: this.jobs(),
      env: this.env,
      storage: this.ctx.storage,
      now,
    };
  }

  /** Run an owner-scoped call. Never throws; errors become the response. */
  async call(
    name: string,
    args: unknown,
    caller: OwnerCaller | null,
  ): Promise<RpcResponse> {
    const def = this.registry.calls.get(name);
    if (!def || def.scope !== "owner") {
      return {
        ok: false,
        error: toBackendError(new RpcError("NOT_FOUND", `Unknown function ${name}.`)),
      };
    }
    try {
      if (caller && caller.ownerId !== this.ownerIdOf()) {
        throw new RpcError("FORBIDDEN", "This request belongs to another account.");
      }
      if (def.requireAccount && caller?.isAnonymous) {
        throw new RpcError("FORBIDDEN", "Sign in with an account to use this.");
      }
      const parsed = def.parse(args ?? {});
      const value = await def.handler(this.context(caller), parsed as never);
      return { ok: true, value: value ?? null };
    } catch (error) {
      if (!(error instanceof RpcError)) {
        this.log("error", "owner_call_failed", {
          name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return { ok: false, error: toBackendError(error) };
    } finally {
      this.flush();
    }
  }

  /**
   * Run a server-internal operation with a null caller. The owner gate
   * checks the owner generation first. Never throws; errors become the
   * response.
   */
  async internalCall(name: string, args: unknown): Promise<RpcResponse> {
    const def = this.registry.internal.get(name);
    if (!def) {
      return {
        ok: false,
        error: toBackendError(new RpcError("NOT_FOUND", `Unknown internal operation ${name}.`)),
      };
    }
    try {
      const value = await def(this.context(null), args ?? {});
      return { ok: true, value: value ?? null };
    } catch (error) {
      if (!(error instanceof RpcError)) {
        this.log("error", "owner_internal_failed", {
          name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return { ok: false, error: toBackendError(error) };
    } finally {
      this.flush();
    }
  }

  /**
   * Note a write made outside `call()` (another object, an alarm path) so the
   * views rerun. Coalesces to one recompute per turn of the event loop.
   */
  changed(): void {
    this.dirty = true;
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  // ── Live views ──────────────────────────────────────────────────────────

  liveSockets(): WebSocket[] {
    try {
      return this.ctx.getWebSockets(LIVE_SOCKET_TAG);
    } catch {
      return [];
    }
  }

  isLiveSocket(socket: WebSocket): boolean {
    return this.liveAttachment(socket) !== null;
  }

  private liveAttachment(socket: WebSocket): LiveAttachment | null {
    try {
      const value = socket.deserializeAttachment() as LiveAttachment | null;
      return value && value.kind === "live" ? value : null;
    } catch {
      return null;
    }
  }

  /** Accept a live socket whose caller the Worker already verified. */
  acceptLive(caller: OwnerCaller): Response {
    this.ensureSchema();
    if (caller.ownerId !== this.ownerIdOf()) {
      return Response.json({ error: "Owner mismatch." }, { status: 403 });
    }
    const pair = new WebSocketPair();
    const server = pair[1]!;
    const attachment: LiveAttachment = {
      kind: "live",
      connId: crypto.randomUUID(),
      caller,
    };
    this.ctx.acceptWebSocket(server, [LIVE_SOCKET_TAG]);
    server.serializeAttachment(attachment);
    return new Response(null, {
      status: 101,
      webSocket: pair[0]!,
      headers: { "sec-websocket-protocol": LIVE_SUBPROTOCOL },
    });
  }

  async onLiveMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.liveAttachment(socket);
    if (!attachment) {
      this.closeLive(socket, LIVE_CLOSE.unauthenticated, "unauthenticated");
      return;
    }
    const text =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(new Uint8Array(message));
    if (text.length > LIVE_MAX_FRAME_BYTES) {
      this.closeLive(socket, LIVE_CLOSE.protocol, "frame_too_large");
      return;
    }
    let frame: LiveClientFrame;
    try {
      frame = JSON.parse(text) as LiveClientFrame;
    } catch {
      this.closeLive(socket, LIVE_CLOSE.protocol, "bad_frame");
      return;
    }
    const now = Date.now();
    if (attachment.caller.expiresAtMs <= now && frame.t !== "auth") {
      this.closeLive(socket, LIVE_CLOSE.unauthenticated, "token_expired");
      return;
    }
    this.ensureSchema();
    switch (frame.t) {
      case "ping":
        this.send(socket, { t: "pong" });
        return;
      case "auth": {
        const caller =
          typeof frame.token === "string" && frame.token.length > 0
            ? await this.verifyToken(frame.token).catch(() => null)
            : null;
        if (
          !caller ||
          caller.ownerId !== attachment.caller.ownerId ||
          caller.subject !== attachment.caller.subject
        ) {
          this.closeLive(socket, LIVE_CLOSE.unauthenticated, "token_rejected");
          return;
        }
        socket.serializeAttachment({
          kind: "live",
          connId: attachment.connId,
          caller,
        } satisfies LiveAttachment);
        return;
      }
      case "sub": {
        if (typeof frame.id !== "string" || frame.id.length > 64 || typeof frame.view !== "string") {
          this.closeLive(socket, LIVE_CLOSE.protocol, "bad_frame");
          return;
        }
        const count =
          this.sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) AS n FROM owner_live_subs WHERE conn_id = ?",
              attachment.connId,
            )
            .toArray()[0]?.n ?? 0;
        if (count >= LIVE_MAX_SUBSCRIPTIONS) {
          this.send(socket, {
            t: "error",
            id: frame.id,
            error: toBackendError(
              new RpcError("RATE_LIMITED", "Too many live subscriptions."),
            ),
          });
          return;
        }
        this.sql.exec(
          `INSERT INTO owner_live_subs (conn_id, sub_id, view, args, hash)
             VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT (conn_id, sub_id) DO UPDATE SET
             view = excluded.view, args = excluded.args, hash = NULL`,
          attachment.connId,
          frame.id,
          frame.view,
          encodeJson(frame.args),
        );
        this.pushSubscription(socket, attachment, {
          conn_id: attachment.connId,
          sub_id: frame.id,
          view: frame.view,
          args: encodeJson(frame.args),
          hash: null,
        });
        return;
      }
      case "unsub":
        this.sql.exec(
          "DELETE FROM owner_live_subs WHERE conn_id = ? AND sub_id = ?",
          attachment.connId,
          String(frame.id),
        );
        return;
      default:
        this.closeLive(socket, LIVE_CLOSE.protocol, "bad_frame");
    }
  }

  onLiveClose(socket: WebSocket): void {
    const attachment = this.liveAttachment(socket);
    if (attachment) {
      this.ensureSchema();
      this.sql.exec("DELETE FROM owner_live_subs WHERE conn_id = ?", attachment.connId);
    }
    try {
      socket.close(1000, "");
    } catch {
      // Already closed.
    }
  }

  /** Rerun every open subscription and push the ones that changed. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const sockets = this.liveSockets();
    if (sockets.length === 0) return;
    this.ensureSchema();
    const byConn = new Map<string, { socket: WebSocket; attachment: LiveAttachment }>();
    for (const socket of sockets) {
      const attachment = this.liveAttachment(socket);
      if (attachment) byConn.set(attachment.connId, { socket, attachment });
    }
    const rows = this.sql
      .exec<LiveSubRow>("SELECT * FROM owner_live_subs ORDER BY conn_id")
      .toArray();
    const orphaned = new Set<string>();
    for (const row of rows) {
      const live = byConn.get(row.conn_id);
      if (!live) {
        orphaned.add(row.conn_id);
        continue;
      }
      this.pushSubscription(live.socket, live.attachment, row);
    }
    for (const connId of orphaned) {
      this.sql.exec("DELETE FROM owner_live_subs WHERE conn_id = ?", connId);
    }
  }

  private pushSubscription(
    socket: WebSocket,
    attachment: LiveAttachment,
    row: LiveSubRow,
  ): void {
    let frame: LiveServerFrame;
    let hash: string;
    try {
      const def = this.registry.views.get(row.view);
      if (!def) throw new RpcError("NOT_FOUND", `Unknown view ${row.view}.`);
      if (def.requireAccount && attachment.caller.isAnonymous) {
        throw new RpcError("FORBIDDEN", "Sign in with an account to see this.");
      }
      const args = def.parse(JSON.parse(row.args));
      const viewContext: OwnerViewContext = {
        ownerId: this.ownerIdOf(),
        caller: attachment.caller,
        db: this.reader(),
        env: this.env,
        now: Date.now(),
      };
      const value = def.read(viewContext, args as never);
      const text = encodeJson(value);
      hash = valueHash(text);
      frame = { t: "value", id: row.sub_id, value: JSON.parse(text) };
    } catch (error) {
      if (!(error instanceof RpcError)) {
        this.log("error", "owner_view_failed", {
          view: row.view,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const backendError = toBackendError(error);
      hash = `error:${backendError.code}`;
      frame = { t: "error", id: row.sub_id, error: backendError };
    }
    if (hash === row.hash) return;
    this.sql.exec(
      "UPDATE owner_live_subs SET hash = ? WHERE conn_id = ? AND sub_id = ?",
      hash,
      row.conn_id,
      row.sub_id,
    );
    this.send(socket, frame);
  }

  private send(socket: WebSocket, frame: LiveServerFrame): void {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // The close handler cleans up.
    }
  }

  private closeLive(socket: WebSocket, code: number, reason: string): void {
    const attachment = this.liveAttachment(socket);
    if (attachment) {
      this.sql.exec("DELETE FROM owner_live_subs WHERE conn_id = ?", attachment.connId);
    }
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  // ── Jobs and deadlines ──────────────────────────────────────────────────

  /** The earliest time this store needs the alarm, or +Infinity. */
  nextDeadline(): number {
    this.ensureSchema();
    let next = Number.POSITIVE_INFINITY;
    const job = this.sql
      .exec<{ at: number | null }>("SELECT MIN(run_at) AS at FROM owner_jobs")
      .toArray()[0]?.at;
    if (typeof job === "number") next = Math.min(next, job);
    for (const socket of this.liveSockets()) {
      const attachment = this.liveAttachment(socket);
      if (!attachment) continue;
      const { expiresAtMs } = attachment.caller;
      next = Math.min(
        next,
        attachment.reauthSent ? expiresAtMs : expiresAtMs - LIVE_REAUTH_LEAD_MS,
      );
    }
    return next;
  }

  /** Run due jobs and enforce live-socket token expiry. */
  async onAlarm(now = Date.now()): Promise<void> {
    this.ensureSchema();
    for (const socket of this.liveSockets()) {
      const attachment = this.liveAttachment(socket);
      if (!attachment) continue;
      const { expiresAtMs } = attachment.caller;
      if (expiresAtMs <= now) {
        this.closeLive(socket, LIVE_CLOSE.unauthenticated, "token_expired");
      } else if (!attachment.reauthSent && expiresAtMs - LIVE_REAUTH_LEAD_MS <= now) {
        socket.serializeAttachment({ ...attachment, reauthSent: true } satisfies LiveAttachment);
        this.send(socket, { t: "reauth", expiresAtMs });
      }
    }
    await this.runDueJobs(now);
  }

  async runDueJobs(now = Date.now()): Promise<number> {
    this.ensureSchema();
    const due = this.sql
      .exec<JobRow>(
        "SELECT * FROM owner_jobs WHERE run_at <= ? ORDER BY run_at LIMIT ?",
        now,
        JOB_BATCH,
      )
      .toArray();
    for (const job of due) {
      const def = this.registry.jobs.get(job.kind);
      if (!def) {
        this.log("error", "owner_job_unknown", { id: job.id, kind: job.kind });
        this.sql.exec("DELETE FROM owner_jobs WHERE id = ?", job.id);
        continue;
      }
      try {
        await def.run(this.context(null, now), JSON.parse(job.payload));
        // A job may reschedule itself under its own id; keep that one.
        this.sql.exec(
          "DELETE FROM owner_jobs WHERE id = ? AND run_at = ? AND attempts = ?",
          job.id,
          job.run_at,
          job.attempts,
        );
      } catch (error) {
        const attempts = job.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        if (attempts >= (def.maxAttempts ?? JOB_DEFAULT_MAX_ATTEMPTS)) {
          this.log("error", "owner_job_dropped", { id: job.id, kind: job.kind, attempts, message });
          this.sql.exec("DELETE FROM owner_jobs WHERE id = ?", job.id);
        } else {
          const backoff = Math.min(JOB_MAX_BACKOFF_MS, 1_000 * 2 ** (attempts - 1));
          this.log("error", "owner_job_failed", { id: job.id, kind: job.kind, attempts, message });
          this.sql.exec(
            "UPDATE owner_jobs SET attempts = ?, run_at = ? WHERE id = ? AND run_at = ?",
            attempts,
            now + backoff,
            job.id,
            job.run_at,
          );
        }
      }
    }
    this.flush();
    return due.length;
  }
}
