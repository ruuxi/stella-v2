/**
 * pi-durable storage on `bun:sqlite`.
 *
 * Bun has no `node:sqlite`, so pi-durable's own Node adapter cannot load in
 * the desktop runtime. This is the same adapter over Bun's built-in driver:
 * one connection, statements cached by SQL text, and a queue that keeps every
 * other call out of an open transaction (the `SqliteDatabase` contract).
 */
import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

const WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const BUSY_TIMEOUT_MS = 5_000;
const ignore = () => {};

/**
 * Runs operations in call order. An operation starts at once when nothing is
 * running or waiting; an asynchronous one holds the queue until it settles.
 */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(operation: () => T): Promise<Awaited<T>> {
    if (this.pending > 0) return this.enqueue(operation);
    try {
      return Promise.resolve(operation()) as Promise<Awaited<T>>;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  runAsync<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    this.pending++;
    // The barrier is published before the operation starts, so calls it
    // makes synchronously queue behind it instead of running inside it.
    const { promise: barrier, resolve: release } = Promise.withResolvers<void>();
    this.tail = barrier;
    let started: Promise<T>;
    try {
      started = operation();
    } catch (error) {
      started = Promise.reject(error);
    }
    return started.finally(() => {
      this.pending--;
      release();
    });
  }

  private enqueue<T>(operation: () => T): Promise<Awaited<T>> {
    this.pending++;
    const settled = this.tail.then(operation).finally(() => {
      this.pending--;
    }) as Promise<Awaited<T>>;
    this.tail = settled.then(ignore, ignore);
    return settled;
  }
}

/** bun:sqlite returns BLOBs as Uint8Array and integers as numbers (or bigint with safeIntegers). */
const bindings = (params: readonly SqliteValue[]): SQLQueryBindings[] => params as SQLQueryBindings[];

abstract class BunSqliteExecutor implements SqliteExecutor {
  constructor(
    protected readonly database: Database,
    protected readonly statements: Map<string, Statement>,
  ) {}

  protected abstract runOperation<T>(operation: () => T): Promise<Awaited<T>>;

  exec(sql: string): Promise<void> {
    return this.runOperation(() => {
      this.database.run(sql);
    });
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.runOperation(() => {
      this.statement(sql).run(...bindings(params));
    });
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.runOperation(() => (this.statement(sql).get(...bindings(params)) ?? undefined) as T | undefined);
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.runOperation(() => this.statement(sql).all(...bindings(params)) as T[]);
  }

  private statement(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
}

class BunSqliteTransaction extends BunSqliteExecutor {
  constructor(
    database: Database,
    statements: Map<string, Statement>,
    private readonly scope: { active: boolean },
  ) {
    super(database, statements);
  }

  protected async runOperation<T>(operation: () => T): Promise<Awaited<T>> {
    if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
    return (await operation()) as Awaited<T>;
  }
}

/** `SqliteDatabase` facade over one `bun:sqlite` connection. */
export class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
  private readonly access = new SerialQueue();
  private closed = false;

  constructor(database: Database) {
    super(database, new Map());
  }

  protected runOperation<T>(operation: () => T): Promise<Awaited<T>> {
    return this.access.run(operation);
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.access.runAsync(async () => {
      this.database.run("BEGIN IMMEDIATE");
      const scope = { active: true };
      try {
        const result = await callback(new BunSqliteTransaction(this.database, this.statements, scope));
        scope.active = false;
        this.database.run("COMMIT");
        return result;
      } catch (error) {
        scope.active = false;
        try {
          this.database.run("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.access.run(() => {
      if (this.closed) return;
      this.closed = true;
      for (const statement of this.statements.values()) statement.finalize();
      this.statements.clear();
      try {
        this.database.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        this.database.close();
      }
    });
  }
}

/** Open one SQLite file in WAL mode, the durability pi-durable's Node adapter uses. */
export async function openBunSqliteDatabase(path: string): Promise<BunSqliteDatabase> {
  if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  const database = new Database(path, { create: true, strict: true });
  const adapter = new BunSqliteDatabase(database);
  try {
    await adapter.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    await adapter.exec("PRAGMA journal_mode = WAL");
    await adapter.exec("PRAGMA synchronous = NORMAL");
    await adapter.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTO_CHECKPOINT_PAGES}`);
    return adapter;
  } catch (error) {
    await adapter.close().catch(ignore);
    throw error;
  }
}

/** Durable harness storage in one SQLite file, for the desktop runtime. */
export async function openBunSqliteStorage(path: string): Promise<SqliteStorage> {
  return SqliteStorage.open(await openBunSqliteDatabase(path));
}
