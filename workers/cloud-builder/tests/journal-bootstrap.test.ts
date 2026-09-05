import { afterEach, describe, expect, test } from "bun:test";
import { Journal } from "../src/journal.js";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const openHarness = () => {
  const fake = openSqlStorageFake();
  cleanups.push(fake.close);
  const values = new Map<string, unknown>();
  const statements: string[] = [];
  const storage = {
    sql: {
      ...fake.sql,
      exec: <T>(statement: string, ...bindings: unknown[]) => {
        statements.push(statement);
        return fake.sql.exec<T>(statement, ...bindings);
      },
    },
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") values.set(key, value);
      else
        for (const [entryKey, entryValue] of Object.entries(key))
          values.set(entryKey, entryValue);
    },
    transactionSync: <T>(operation: () => T): T => operation(),
  };
  return {
    sql: fake.sql,
    statements,
    state: { storage } as unknown as DurableObjectState,
  };
};

describe("Journal bootstrap", () => {
  test("uses one schema probe for a complete current store", async () => {
    const harness = openHarness();
    await new Journal(harness.state, () => undefined).bootstrap();
    harness.statements.length = 0;

    await new Journal(harness.state, () => undefined).bootstrap();

    expect(harness.statements).toHaveLength(1);
    expect(harness.statements[0]).toContain("FROM meta WHERE meta.id = 0");
    expect(
      harness.statements.some((statement) => statement.includes("CREATE")),
    ).toBe(false);
  });

  test("repairs a current version whose named schema object is missing", async () => {
    const harness = openHarness();
    await new Journal(harness.state, () => undefined).bootstrap();
    harness.sql.exec("DROP TABLE inbox");
    harness.statements.length = 0;

    await new Journal(harness.state, () => undefined).bootstrap();

    expect(
      harness.sql
        .exec<{
          count: number;
        }>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'inbox'",
        )
        .one().count,
    ).toBe(1);
    expect(
      harness.statements.some((statement) =>
        statement.includes("CREATE TABLE IF NOT EXISTS inbox"),
      ),
    ).toBe(true);
  });

  test("runs the existing migration path for an old version", async () => {
    const harness = openHarness();
    const journal = new Journal(harness.state, () => undefined);
    await journal.bootstrap();
    harness.sql.exec("UPDATE meta SET schema_version = 7 WHERE id = 0");
    harness.statements.length = 0;

    await new Journal(harness.state, () => undefined).bootstrap();

    expect(
      new Journal(harness.state, () => undefined).meta().schema_version,
    ).toBe(8);
    expect(
      harness.statements.some((statement) =>
        statement.includes("CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts"),
      ),
    ).toBe(true);
  });
});
