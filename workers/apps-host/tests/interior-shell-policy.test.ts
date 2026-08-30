import { describe, expect, test } from "bun:test";
import {
  INTERIOR_SHELL_AUDIENCE,
  issueInteriorShellSession,
  parseInteriorShellSession,
  validateInteriorConvexClientMessage,
  type InteriorShellSessionIssueArgs,
} from "../src/interior-shell-policy";

const NOW = 1_800_000_000_000;
const KEY = "test-interior-shell-key-" + "k".repeat(48);
const CONVEX_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ2aWV3ZXItYSJ9.signature";
const ROUTE_A = "sr_12345678-1234-4123-8123-123456789abc";
const ROUTE_B = "sr_87654321-4321-4321-8321-cba987654321";
const BUILD_A = `interior-${"a".repeat(48)}`;
const BUILD_B = `interior-${"b".repeat(48)}`;
const DEFAULT_BUILD = "interior/desktop-v2.0.0";
const GATEWAY = "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev";

const issueArgs = (
  overrides: Partial<InteriorShellSessionIssueArgs> = {},
): InteriorShellSessionIssueArgs => ({
  appTokenSigningKey: KEY,
  issuer: "dev:outgoing-bulldog-865",
  stableRouteId: ROUTE_A,
  routeBuild: { mode: "custom", buildId: BUILD_A },
  viewerId: "viewer-a",
  viewerOwnerGeneration: "generation-a",
  convexJwt: CONVEX_JWT,
  trustedGatewayOrigin: GATEWAY,
  now: NOW,
  ...overrides,
});

const expected = (overrides: Record<string, unknown> = {}) => ({
  issuer: "dev:outgoing-bulldog-865",
  stableRouteId: ROUTE_A,
  routeBuild: { mode: "custom" as const, buildId: BUILD_A },
  viewerId: "viewer-a",
  viewerOwnerGeneration: "generation-a",
  trustedGatewayOrigin: GATEWAY,
  ...overrides,
});

const seal = async (payload: Record<string, unknown>): Promise<string> => {
  const encoder = new TextEncoder();
  const nonce = new Uint8Array(12).fill(7);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(KEY));
  const key = await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: encoder.encode(INTERIOR_SHELL_AUDIENCE),
    },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  return `v1.${encode(nonce)}.${encode(new Uint8Array(ciphertext))}`;
};

const canonicalPayload = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  audience: INTERIOR_SHELL_AUDIENCE,
  issuer: "dev:outgoing-bulldog-865",
  stableRouteId: ROUTE_A,
  routeMode: "custom",
  buildId: BUILD_A,
  viewerId: "viewer-a",
  viewerOwnerGeneration: "generation-a",
  tokenId: "12345678-1234-4123-8123-123456789abc",
  issuedAt: NOW,
  expiresAt: NOW + 120_000,
  trustedGatewayOrigin: GATEWAY,
  convexJwt: CONVEX_JWT,
  ...overrides,
});

const startSession = async () => {
  const { token } = await issueInteriorShellSession(issueArgs());
  const session = await parseInteriorShellSession({
    token,
    appTokenSigningKey: KEY,
    expected: expected(),
    now: NOW,
  });
  return { token, session };
};

describe("Stella interior session token", () => {
  test("is opaque, route/viewer bound, and keeps the Convex JWT server-only", async () => {
    const { token, expiresAt } = await issueInteriorShellSession(issueArgs());
    expect(expiresAt).toBe(NOW + 120_000);
    expect(token).not.toContain("viewer-a");
    expect(token).not.toContain(CONVEX_JWT);

    const session = await parseInteriorShellSession({
      token,
      appTokenSigningKey: KEY,
      expected: expected(),
      now: NOW,
    });
    expect(session.claims).toMatchObject({
      audience: INTERIOR_SHELL_AUDIENCE,
      stableRouteId: ROUTE_A,
      routeBuild: { mode: "custom", buildId: BUILD_A },
      viewerId: "viewer-a",
      viewerOwnerGeneration: "generation-a",
      trustedGatewayOrigin: GATEWAY,
    });
    expect(session.convexToken).toBe(CONVEX_JWT);
    expect(Object.keys(session)).toEqual(["claims"]);
    expect(JSON.stringify(session)).not.toContain(CONVEX_JWT);

    const unwrapped = await parseInteriorShellSession({
      token,
      appTokenSigningKey: KEY,
      expected: {
        issuer: "dev:outgoing-bulldog-865",
        trustedGatewayOrigin: GATEWAY,
      },
      now: NOW,
    });
    expect(unwrapped.claims.viewerId).toBe("viewer-a");
    expect(unwrapped.claims.stableRouteId).toBe(ROUTE_A);
  });

  test("supports an exact default build identity", async () => {
    const args = issueArgs({
      routeBuild: { mode: "default", buildId: DEFAULT_BUILD },
    });
    const { token } = await issueInteriorShellSession(args);
    const session = await parseInteriorShellSession({
      token,
      appTokenSigningKey: KEY,
      expected: expected({
        routeBuild: { mode: "default", buildId: DEFAULT_BUILD },
      }),
      now: NOW,
    });
    expect(session.claims.routeBuild).toEqual({
      mode: "default",
      buildId: DEFAULT_BUILD,
    });
    await expect(
      parseInteriorShellSession({
        token,
        appTokenSigningKey: KEY,
        expected: expected({
          routeBuild: { mode: "default", buildId: "interior/desktop-v2.0.1" },
        }),
        now: NOW,
      }),
    ).rejects.toThrow("invalid or expired");
  });

  test.each([
    ["route", expected({ stableRouteId: ROUTE_B })],
    ["build", expected({ routeBuild: { mode: "custom", buildId: BUILD_B } })],
    ["viewer", expected({ viewerId: "viewer-b" })],
    ["owner generation", expected({ viewerOwnerGeneration: "generation-b" })],
    ["issuer", expected({ issuer: "preview:basic-nightingale-118" })],
    [
      "gateway origin",
      expected({ trustedGatewayOrigin: "https://example.com" }),
    ],
  ])("rejects a cross-%s expectation", async (_label, mismatch) => {
    const { token } = await issueInteriorShellSession(issueArgs());
    await expect(
      parseInteriorShellSession({
        token,
        appTokenSigningKey: KEY,
        expected: mismatch,
        now: NOW,
      }),
    ).rejects.toThrow("invalid or expired");
  });

  test("rejects expiry and an overlong requested lifetime", async () => {
    const { token } = await issueInteriorShellSession(issueArgs());
    await expect(
      parseInteriorShellSession({
        token,
        appTokenSigningKey: KEY,
        expected: expected(),
        now: NOW + 120_000,
      }),
    ).rejects.toThrow("invalid or expired");
    await expect(
      issueInteriorShellSession(issueArgs({ ttlMs: 120_001 })),
    ).rejects.toThrow("invalid or expired");
  });

  test("rejects wrong audience and non-canonical or malformed encodings", async () => {
    const wrongAudience = await seal(
      canonicalPayload({ audience: "stella-app-fetch-v1" }),
    );
    await expect(
      parseInteriorShellSession({
        token: wrongAudience,
        appTokenSigningKey: KEY,
        expected: expected(),
        now: NOW,
      }),
    ).rejects.toThrow("invalid or expired");

    const reordered = await seal({
      issuer: "dev:outgoing-bulldog-865",
      ...canonicalPayload(),
    });
    await expect(
      parseInteriorShellSession({
        token: reordered,
        appTokenSigningKey: KEY,
        expected: expected(),
        now: NOW,
      }),
    ).rejects.toThrow("invalid or expired");
    await expect(
      parseInteriorShellSession({
        token: "v1.not+base64.not-base64!",
        appTokenSigningKey: KEY,
        expected: expected(),
        now: NOW,
      }),
    ).rejects.toThrow("invalid or expired");
  });
});

describe("Stella interior Convex protocol policy", () => {
  test("rewrites only exact scoped User authentication", async () => {
    const { token, session } = await startSession();
    expect(
      validateInteriorConvexClientMessage({
        session,
        scopedToken: token,
        message: {
          type: "Authenticate",
          tokenType: "User",
          value: token,
          baseVersion: 2,
        },
      }),
    ).toEqual({
      ok: true,
      upstreamMessage: {
        type: "Authenticate",
        tokenType: "User",
        value: CONVEX_JWT,
        baseVersion: 2,
      },
    });
    expect(
      validateInteriorConvexClientMessage({
        session,
        scopedToken: `${token}x`,
        message: {
          type: "Authenticate",
          tokenType: "User",
          value: `${token}x`,
          baseVersion: 2,
        },
      }),
    ).toEqual({ ok: false, reason: "authentication_denied" });
    expect(
      validateInteriorConvexClientMessage({
        session,
        scopedToken: token,
        message: { type: "Authenticate", tokenType: "None", baseVersion: 2 },
      }),
    ).toEqual({ ok: false, reason: "authentication_denied" });
  });

  test("permits Connect and only the ClientConnect event", async () => {
    const { token, session } = await startSession();
    const connect = {
      type: "Connect",
      sessionId: "session-a",
      connectionCount: 0,
      lastCloseReason: null,
      clientTs: NOW,
    };
    expect(
      validateInteriorConvexClientMessage({
        message: connect,
        session,
        scopedToken: token,
      }),
    ).toEqual({ ok: true, upstreamMessage: connect });
    const clientConnect = {
      type: "Event",
      eventType: "ClientConnect",
      event: { marks: [] },
    };
    expect(
      validateInteriorConvexClientMessage({
        message: clientConnect,
        session,
        scopedToken: token,
      }),
    ).toEqual({ ok: true, upstreamMessage: clientConnect });
    expect(
      validateInteriorConvexClientMessage({
        message: {
          type: "Event",
          eventType: "NetworkRecoveryReconnect",
          event: {},
        },
        session,
        scopedToken: token,
      }),
    ).toEqual({ ok: false, reason: "event_denied" });
  });

  test("allows listed query Add and any valid Remove", async () => {
    const { token, session } = await startSession();
    const message = {
      type: "ModifyQuerySet",
      baseVersion: 0,
      newVersion: 1,
      modifications: [
        {
          type: "Add",
          queryId: 1,
          udfPath: "cloud_apps:listMyConversations",
          args: [{}],
          journal: null,
        },
        { type: "Remove", queryId: 2 },
      ],
    };
    expect(
      validateInteriorConvexClientMessage({
        message,
        session,
        scopedToken: token,
      }),
    ).toEqual({ ok: true, upstreamMessage: message });
  });

  test("denies sensitive UDFs and all component calls", async () => {
    const { token, session } = await startSession();
    expect(
      validateInteriorConvexClientMessage({
        session,
        scopedToken: token,
        message: {
          type: "ModifyQuerySet",
          baseVersion: 0,
          newVersion: 1,
          modifications: [
            {
              type: "Add",
              queryId: 1,
              udfPath: "billing:listMySubscriptions",
              args: [{}],
            },
          ],
        },
      }),
    ).toEqual({ ok: false, reason: "udf_denied" });
    expect(
      validateInteriorConvexClientMessage({
        session,
        scopedToken: token,
        message: {
          type: "Mutation",
          requestId: 1,
          udfPath: "cloud_apps:startCloudChat",
          args: [{}],
          componentPath: "admin",
        },
      }),
    ).toEqual({ ok: false, reason: "component_denied" });
  });

  test("uses separate exact mutation and action allowlists", async () => {
    const { token, session } = await startSession();
    const mutation = {
      type: "Mutation",
      requestId: 1,
      udfPath: "cloud_apps:startCloudChat",
      args: [{}],
    };
    const action = {
      type: "Action",
      requestId: 2,
      udfPath: "cloud_apps:deleteMyConversation",
      args: [{}],
    };
    expect(
      validateInteriorConvexClientMessage({
        message: mutation,
        session,
        scopedToken: token,
      }).ok,
    ).toBeTrue();
    expect(
      validateInteriorConvexClientMessage({
        message: action,
        session,
        scopedToken: token,
      }).ok,
    ).toBeTrue();
    expect(
      validateInteriorConvexClientMessage({
        message: { ...mutation, udfPath: action.udfPath },
        session,
        scopedToken: token,
      }),
    ).toEqual({ ok: false, reason: "udf_denied" });
    expect(
      validateInteriorConvexClientMessage({
        message: { ...action, udfPath: mutation.udfPath },
        session,
        scopedToken: token,
      }),
    ).toEqual({ ok: false, reason: "udf_denied" });
  });
});
