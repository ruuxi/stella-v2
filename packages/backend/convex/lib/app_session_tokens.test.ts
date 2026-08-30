import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  APP_SESSION_TTL_MS,
  hashAppViewerNamespace,
  signAppSessionToken,
  verifyAppSessionToken,
} from "./app_session_tokens";

const previous = {
  APP_TOKEN_SIGNING_KEY: process.env.APP_TOKEN_SIGNING_KEY,
  APP_VIEWER_NAMESPACE_KEY: process.env.APP_VIEWER_NAMESPACE_KEY,
  STELLA_DEPLOYMENT_IDENTITY: process.env.STELLA_DEPLOYMENT_IDENTITY,
};

before(() => {
  process.env.APP_TOKEN_SIGNING_KEY = "test-signing-key-000000000000000000000000";
  process.env.APP_VIEWER_NAMESPACE_KEY = "test-namespace-key-0000000000000000000000";
  process.env.STELLA_DEPLOYMENT_IDENTITY = "dev:outgoing-bulldog-865";
});

after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("opaque app session credentials", () => {
  test("round-trips an exact short-lived owner session without plaintext identity", async () => {
    const now = Date.now();
    const token = await signAppSessionToken({
      appId: "app-a",
      ownerId: "owner-secret-id",
      ownerGeneration: "generation-a",
      viewerNamespace: "viewer-a",
      role: "owner",
      userId: "owner-secret-id",
      username: "Owner",
      anonymous: false,
      origin: "https://apps.example.com",
      issuedAt: now,
      exp: now + APP_SESSION_TTL_MS,
    });
    assert.equal(token.includes("owner-secret-id"), false);
    assert.equal(
      (
        await verifyAppSessionToken({
          token,
          origin: "https://apps.example.com",
          now,
        })
      ).role,
      "owner",
    );
    await assert.rejects(() =>
      verifyAppSessionToken({
        token,
        origin: "https://attacker.example.com",
        now,
      }),
    );
  });

  test("derives distinct namespaces for owner, other viewer, anonymous viewer, and app", async () => {
    const owner = await hashAppViewerNamespace({
      appId: "app-a",
      viewerIdentity: "account:owner",
    });
    const other = await hashAppViewerNamespace({
      appId: "app-a",
      viewerIdentity: "account:other",
    });
    const anonymous = await hashAppViewerNamespace({
      appId: "app-a",
      viewerIdentity: "anonymous:visitor",
    });
    const otherApp = await hashAppViewerNamespace({
      appId: "app-b",
      viewerIdentity: "account:owner",
    });
    assert.equal(new Set([owner, other, anonymous, otherApp]).size, 4);
  });

  test("rejects an owner role that is not the owner identity", async () => {
    const now = Date.now();
    const token = await signAppSessionToken({
      appId: "app-a",
      ownerId: "owner-a",
      ownerGeneration: "generation-a",
      viewerNamespace: "viewer-a",
      role: "owner",
      userId: "other-user",
      username: "Other",
      anonymous: false,
      origin: "https://apps.example.com",
      issuedAt: now,
      exp: now + APP_SESSION_TTL_MS,
    });
    await assert.rejects(() =>
      verifyAppSessionToken({
        token,
        origin: "https://apps.example.com",
        now,
      }),
    );
  });

  test("rejects an authenticated session with an overlong lifetime", async () => {
    const now = Date.now();
    const token = await signAppSessionToken({
      appId: "app-a",
      ownerId: "owner-a",
      ownerGeneration: "generation-a",
      viewerNamespace: "viewer-a",
      role: "viewer",
      userId: "viewer-a",
      username: "Viewer",
      anonymous: false,
      origin: "https://apps.example.com",
      issuedAt: now,
      exp: now + APP_SESSION_TTL_MS + 1,
    });
    await assert.rejects(() =>
      verifyAppSessionToken({
        token,
        origin: "https://apps.example.com",
        now,
      }),
    );
  });

  test("accepts only coherent anonymous authorization semantics", async () => {
    const now = Date.now();
    const token = await signAppSessionToken({
      appId: "app-a",
      ownerId: "owner-a",
      ownerGeneration: "generation-a",
      viewerNamespace: "anonymous-viewer",
      role: "anonymous",
      userId: "anonymous:anonymous-viewer",
      username: "Guest",
      anonymous: true,
      origin: "https://apps.example.com",
      issuedAt: now,
      exp: now + APP_SESSION_TTL_MS,
    });
    assert.equal(
      (
        await verifyAppSessionToken({
          token,
          origin: "https://apps.example.com",
          now,
        })
      ).role,
      "anonymous",
    );
  });
});
