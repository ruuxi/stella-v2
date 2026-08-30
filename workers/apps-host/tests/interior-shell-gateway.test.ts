import { afterEach, describe, expect, test } from "bun:test";
import { AppsAuthService } from "../src/app-auth-service";
import { readAppsHostConfig } from "../src/config";
import {
  handleInteriorService,
  handleInteriorSession,
} from "../src/interior-shell-gateway";
import {
  issueInteriorShellSession,
  parseInteriorShellSession,
} from "../src/interior-shell-policy";
import { createEnv, routeId, TEST_APP_TOKEN_SIGNING_KEY } from "./fixtures";

const originalFetch = globalThis.fetch;
const ownerHash = "b".repeat(64);
const buildId = `interior-${"c".repeat(48)}`;
const convexJwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ2aWV3ZXItYSJ9.signature";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const config = () => readAppsHostConfig(createEnv());

const service = (): AppsAuthService => {
  const instance = Object.create(AppsAuthService.prototype) as AppsAuthService;
  Object.defineProperty(instance, "env", { value: createEnv() });
  return instance;
};

const routeResponse = (selectedBuildId = buildId): Response =>
  Response.json({
    mode: "custom",
    ownerHash,
    buildId: selectedBuildId,
    artifactPrefix: `interiors/${ownerHash}/${selectedBuildId}`,
  });

describe("trusted Stella interior gateway", () => {
  test("exchanges the exact current route for an opaque viewer-scoped session", async () => {
    const { bootstrap } = await service().mintInteriorBootstrap({
      stableRouteId: routeId,
      routeBuild: { mode: "custom", buildId },
      origin: config().appsHostOrigin,
    });
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/cloud/interior-active-route") {
        return routeResponse();
      }
      if (url.pathname === "/api/auth/get-session") {
        return Response.json({
          session: { id: "session-a" },
          user: {
            id: "viewer-a",
            email: "viewer@example.com",
            name: "Viewer",
            image: null,
            isAnonymous: false,
          },
        });
      }
      if (url.pathname === "/api/auth/convex/token") {
        return Response.json({ token: convexJwt });
      }
      if (url.pathname === "/api/query") {
        return Response.json({
          status: "success",
          value: { ownerId: "viewer-a", ownerGeneration: "generation-a" },
        });
      }
      throw new Error(`Unexpected upstream ${url}`);
    }) as typeof fetch;

    const response = await handleInteriorSession(
      new Request(`${config().trustedAppsHostOrigin}/api/interior/session`, {
        method: "POST",
        headers: {
          origin: config().appsHostOrigin,
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
          "content-type": "application/json",
          cookie:
            "__Host-stella_account_session=signed-session.signature; __Host-stella_identity_intent=connected",
        },
        body: JSON.stringify({ bootstrap }),
      }),
      config(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.token).toStartWith("v1.");
    expect(JSON.stringify(body)).not.toContain(convexJwt);
    expect(JSON.stringify(body)).not.toContain("signed-session.signature");
    expect(body.user).toMatchObject({ id: "viewer-a", isAnonymous: false });
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const parsed = await parseInteriorShellSession({
      token: body.token,
      appTokenSigningKey: TEST_APP_TOKEN_SIGNING_KEY,
      expected: {
        issuer: config().deploymentIdentity,
        trustedGatewayOrigin: config().trustedAppsHostOrigin,
        stableRouteId: routeId,
        routeBuild: { mode: "custom", buildId },
        viewerId: "viewer-a",
        viewerOwnerGeneration: "generation-a",
      },
    });
    expect(parsed.convexToken).toBe(convexJwt);
  });

  test("rejects a bootstrap after the stable route changes builds", async () => {
    const { bootstrap } = await service().mintInteriorBootstrap({
      stableRouteId: routeId,
      routeBuild: { mode: "custom", buildId },
      origin: config().appsHostOrigin,
    });
    const changedBuild = `interior-${"d".repeat(48)}`;
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/cloud/interior-active-route") {
        return routeResponse(changedBuild);
      }
      throw new Error("Auth must not run for a stale build.");
    }) as typeof fetch;
    const response = await handleInteriorSession(
      new Request(`${config().trustedAppsHostOrigin}/api/interior/session`, {
        method: "POST",
        headers: {
          origin: config().appsHostOrigin,
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
          "content-type": "application/json",
        },
        body: JSON.stringify({ bootstrap }),
      }),
      config(),
    );
    expect(response.status).toBe(401);
  });

  test("substitutes the internal JWT only for an exact service path", async () => {
    const scoped = await issueInteriorShellSession({
      appTokenSigningKey: TEST_APP_TOKEN_SIGNING_KEY,
      issuer: config().deploymentIdentity,
      stableRouteId: routeId,
      routeBuild: { mode: "custom", buildId },
      viewerId: "viewer-a",
      viewerOwnerGeneration: "generation-a",
      convexJwt,
      trustedGatewayOrigin: config().trustedAppsHostOrigin,
    });
    let forwardedAuthorization = "";
    let serviceCalls = 0;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/cloud/interior-active-route") {
        return routeResponse();
      }
      if (url.pathname === "/api/query") {
        return Response.json({
          status: "success",
          value: { ownerId: "viewer-a", ownerGeneration: "generation-a" },
        });
      }
      if (url.pathname === "/api/stella/models") {
        serviceCalls += 1;
        forwardedAuthorization =
          new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({ data: [] });
      }
      throw new Error(`Unexpected upstream ${url}`);
    }) as typeof fetch;
    const response = await handleInteriorService(
      new Request(`${config().trustedAppsHostOrigin}/api/stella/models`, {
        headers: { origin: "null", authorization: `Bearer ${scoped.token}` },
      }),
      config(),
    );
    expect(response?.status).toBe(200);
    expect(forwardedAuthorization).toBe(`Bearer ${convexJwt}`);
    expect(forwardedAuthorization).not.toContain(scoped.token);

    const arbitrary = await handleInteriorService(
      new Request(
        `${config().trustedAppsHostOrigin}/api/cloud/projects/credentials`,
        {
          headers: { origin: "null", authorization: `Bearer ${scoped.token}` },
        },
      ),
      config(),
    );
    expect(arbitrary).toBeNull();
    expect(serviceCalls).toBe(1);
  });

  test("rejects expired and cross-viewer session reuse before a service call", async () => {
    const now = Date.now();
    const expired = await issueInteriorShellSession({
      appTokenSigningKey: TEST_APP_TOKEN_SIGNING_KEY,
      issuer: config().deploymentIdentity,
      stableRouteId: routeId,
      routeBuild: { mode: "custom", buildId },
      viewerId: "viewer-a",
      viewerOwnerGeneration: "generation-a",
      convexJwt,
      trustedGatewayOrigin: config().trustedAppsHostOrigin,
      now: now - 2_000,
      ttlMs: 1_000,
    });
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return new Response("unexpected");
    }) as typeof fetch;
    const expiredResponse = await handleInteriorService(
      new Request(`${config().trustedAppsHostOrigin}/api/stella/models`, {
        headers: { origin: "null", authorization: `Bearer ${expired.token}` },
      }),
      config(),
    );
    expect(expiredResponse?.status).toBe(401);
    expect(upstreamCalls).toBe(0);

    const active = await issueInteriorShellSession({
      appTokenSigningKey: TEST_APP_TOKEN_SIGNING_KEY,
      issuer: config().deploymentIdentity,
      stableRouteId: routeId,
      routeBuild: { mode: "custom", buildId },
      viewerId: "viewer-a",
      viewerOwnerGeneration: "generation-a",
      convexJwt,
      trustedGatewayOrigin: config().trustedAppsHostOrigin,
    });
    globalThis.fetch = (async (input) => {
      upstreamCalls += 1;
      const url = new URL(String(input));
      if (url.pathname === "/api/cloud/interior-active-route")
        return routeResponse();
      if (url.pathname === "/api/query") {
        return Response.json({
          status: "success",
          value: { ownerId: "viewer-b", ownerGeneration: "generation-b" },
        });
      }
      return new Response("unexpected");
    }) as typeof fetch;
    const crossViewer = await handleInteriorService(
      new Request(`${config().trustedAppsHostOrigin}/api/stella/models`, {
        headers: { origin: "null", authorization: `Bearer ${active.token}` },
      }),
      config(),
    );
    expect(crossViewer?.status).toBe(401);
    expect(upstreamCalls).toBe(2);
  });
});
