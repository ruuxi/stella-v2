import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  decideAnonymousLinkBinding,
  planLinkCompletion,
} from "./mobile_auth_link";

describe("mobile auth link ownership", () => {
  test("binds a validated anonymous Convex identity", () => {
    assert.deepEqual(
      decideAnonymousLinkBinding({
        hasAuthorizationHeader: true,
        identityOwnerId: "https://convex.example|anon-user",
        identityIsAnonymous: true,
        requireAnonymousOwner: true,
      }),
      {
        ok: true,
        fromOwnerId: "https://convex.example|anon-user",
      },
    );
  });

  test("requires a valid anonymous bearer when the client requests ownership linking", () => {
    assert.deepEqual(
      decideAnonymousLinkBinding({
        hasAuthorizationHeader: true,
        identityIsAnonymous: false,
        requireAnonymousOwner: true,
      }),
      { ok: false, reason: "invalid_authorization" },
    );
    assert.deepEqual(
      decideAnonymousLinkBinding({
        hasAuthorizationHeader: false,
        identityIsAnonymous: false,
        requireAnonymousOwner: true,
      }),
      {
        ok: false,
        reason: "anonymous_authorization_required",
      },
    );
  });

  test("plans connected completion with a durable migration", () => {
    assert.deepEqual(
      planLinkCompletion({
        requestStatus: "pending",
        fromOwnerId: "issuer|anonymous",
        toOwnerId: "issuer|connected",
      }),
      {
        kind: "complete_with_migration",
        schedule: true,
        migrationStatus: "pending",
      },
    );
  });

  test("completion replay is idempotent", () => {
    assert.deepEqual(
      planLinkCompletion({
        requestStatus: "completed",
        fromOwnerId: "issuer|anonymous",
        toOwnerId: "issuer|connected",
        existingMigrationStatus: "running",
      }),
      { kind: "replay" },
    );
  });

  test("preserves connected-only login when there is no anonymous source", () => {
    assert.deepEqual(
      decideAnonymousLinkBinding({
        hasAuthorizationHeader: false,
        identityIsAnonymous: false,
        requireAnonymousOwner: false,
      }),
      { ok: true },
    );
    assert.deepEqual(
      planLinkCompletion({
        requestStatus: "pending",
        toOwnerId: "issuer|connected",
      }),
      { kind: "complete_without_migration" },
    );
  });
});
