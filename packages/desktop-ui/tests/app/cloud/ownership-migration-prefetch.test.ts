import { describe, expect, test } from "vitest";
import { readPrefetchedOwnershipMigration } from "../../../src/global/auth/lib/cloud-conversation-session";

describe("prefetched ownership migration status", () => {
  const complete = { status: "complete" as const, updatedAt: 1 };

  test("reads as not loaded until the session identity is confirmed", () => {
    expect(readPrefetchedOwnershipMigration(complete, false)).toBeUndefined();
    expect(readPrefetchedOwnershipMigration(null, false)).toBeUndefined();
  });

  test("never throws a failure fetched under an unconfirmed identity", () => {
    expect(
      readPrefetchedOwnershipMigration(new Error("policy"), false),
    ).toBeUndefined();
  });

  test("exposes the already-fetched result the moment the session is confirmed", () => {
    expect(readPrefetchedOwnershipMigration(complete, true)).toBe(complete);
    expect(readPrefetchedOwnershipMigration(null, true)).toBeNull();
    expect(readPrefetchedOwnershipMigration(undefined, true)).toBeUndefined();
  });

  test("throws a failure once confirmed, as a readiness-gated useQuery would", () => {
    const failure = new Error("policy");
    expect(() => readPrefetchedOwnershipMigration(failure, true)).toThrow(
      failure,
    );
  });
});
