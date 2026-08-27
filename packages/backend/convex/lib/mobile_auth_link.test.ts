import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  decideAnonymousLinkBinding,
  planLinkCompletion,
} from "./mobile_auth_link";

const anonymousOwner = "https://convex.example|anon-user";

describe("magic-link anonymous owner binding", () => {
  test("binds the exact anonymous owner derived from a valid Convex bearer", () => {
    assert.deepEqual(
      decideAnonymousLinkBinding({
        hasAuthorizationHeader: true,
        hasBearerAuthorization: true,
        identityOwnerId: anonymousOwner,
        identityIsAnonymous: true,
        requireAnonymousOwner: true,
      }),
      { ok: true, fromOwnerId: anonymousOwner },
    );
  });

  test("rejects a missing bearer when anonymous owner binding is required", () => {
    assert.deepEqual(
      decideAnonymousLinkBinding({
        hasAuthorizationHeader: false,
        hasBearerAuthorization: false,
        identityIsAnonymous: false,
        requireAnonymousOwner: true,
      }),
      { ok: false, reason: "anonymous_authorization_required" },
    );
  });

  test("rejects malformed or unverifiable authorization", () => {
    assert.deepEqual(
      decideAnonymousLinkBinding({
        hasAuthorizationHeader: true,
        hasBearerAuthorization: false,
        identityIsAnonymous: false,
        requireAnonymousOwner: true,
      }),
      { ok: false, reason: "invalid_authorization" },
    );
    assert.deepEqual(
      decideAnonymousLinkBinding({
        hasAuthorizationHeader: true,
        hasBearerAuthorization: true,
        identityIsAnonymous: false,
        requireAnonymousOwner: true,
      }),
      { ok: false, reason: "invalid_authorization" },
    );
  });

  test("rejects a valid bearer for a connected account instead of mismatching owners", () => {
    assert.deepEqual(
      decideAnonymousLinkBinding({
        hasAuthorizationHeader: true,
        hasBearerAuthorization: true,
        identityOwnerId: "https://convex.example|connected-user",
        identityIsAnonymous: false,
        requireAnonymousOwner: true,
      }),
      { ok: false, reason: "anonymous_authorization_required" },
    );
  });

  test("keeps legacy connected-only sends valid when owner binding is not requested", () => {
    assert.deepEqual(
      decideAnonymousLinkBinding({
        hasAuthorizationHeader: false,
        hasBearerAuthorization: false,
        identityIsAnonymous: false,
        requireAnonymousOwner: false,
      }),
      { ok: true },
    );
  });
});

describe("magic-link completion planning", () => {
  test("plans a durable migration for an anonymous-to-account completion", () => {
    assert.deepEqual(
      planLinkCompletion({
        requestStatus: "pending",
        fromOwnerId: anonymousOwner,
        toOwnerId: "https://convex.example|connected-user",
      }),
      {
        kind: "complete_with_migration",
        schedule: true,
        migrationStatus: "pending",
      },
    );
  });

  test("makes completion replay idempotent", () => {
    assert.deepEqual(
      planLinkCompletion({
        requestStatus: "completed",
        fromOwnerId: anonymousOwner,
        toOwnerId: "https://convex.example|connected-user",
        existingMigrationStatus: "running",
      }),
      { kind: "replay" },
    );
  });
});
