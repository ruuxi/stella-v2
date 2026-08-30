import { afterEach, describe, expect, test } from "bun:test";
import { MAX_APP_ASSET_BYTES } from "../src/http-security";
import worker from "../src/index";
import { createEnv, routeId, TEST_SERVICE_SECRET } from "./fixtures";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const r2Object = (body: string, contentType = "text/html; charset=utf-8") => {
  const bytes = new TextEncoder().encode(body);
  return {
    body: new Blob([bytes]).stream(),
    size: bytes.byteLength,
    httpEtag: '"test-etag"',
    writeHttpMetadata: (headers: Headers) => {
      headers.set("content-type", contentType);
    },
  } as unknown as R2ObjectBody;
};

describe("hosted asset boundary", () => {
  test("serves the live app route with strict CSP and cache policy", async () => {
    const requested: string[] = [];
    const env = createEnv({
      APP_ROUTES: {
        get: async (key: string) =>
          key === "app:orbit-demo"
            ? {
                artifactPrefix: `builds/${"a".repeat(64)}/build-123`,
                suspended: false,
              }
            : null,
      } as unknown as KVNamespace,
      APP_BUILDS: {
        get: async (key: string) => {
          requested.push(key);
          return r2Object("<!doctype html><h1>Demo</h1>");
        },
      } as unknown as R2Bucket,
    });
    const response = await worker.fetch(
      new Request("https://apps.example.com/apps/orbit-demo/"),
      env,
    );
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(response.status).toBe(200);
    expect(requested).toEqual([
      `builds/${"a".repeat(64)}/build-123/index.html`,
    ]);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("https://outgoing-bulldog-865.convex.site");
    expect(csp).toContain(
      "wss://stella-v2-cloud-builder-dev.lolruuxi.workers.dev",
    );
    expect(csp).not.toContain("flexible-panther-999");
    expect(csp).not.toContain("stella-v2-interior-dev");
  });

  test("rejects malformed asset paths before reading R2", async () => {
    let r2Reads = 0;
    const env = createEnv({
      APP_ROUTES: {
        get: async () => ({
          artifactPrefix: `builds/${"a".repeat(64)}/build-123`,
          suspended: false,
        }),
      } as unknown as KVNamespace,
      APP_BUILDS: {
        get: async () => {
          r2Reads += 1;
          return null;
        },
      } as unknown as R2Bucket,
    });
    const response = await worker.fetch(
      new Request("https://apps.example.com/apps/orbit-demo/%5Csecret"),
      env,
    );
    expect(response.status).toBe(404);
    expect(r2Reads).toBe(0);
  });

  test("uses the builder's bounded app-slug contract", async () => {
    const routeKeys: string[] = [];
    const env = createEnv({
      APP_ROUTES: {
        get: async (key: string) => {
          routeKeys.push(key);
          return {
            artifactPrefix: `builds/${"a".repeat(64)}/build-123`,
            suspended: false,
          };
        },
      } as unknown as KVNamespace,
      APP_BUILDS: {
        get: async () => r2Object("<!doctype html><h1>Demo</h1>"),
      } as unknown as R2Bucket,
    });
    const accepted = await worker.fetch(
      new Request("https://apps.example.com/apps/orbit_demo.v2/"),
      env,
    );
    const rejected = await worker.fetch(
      new Request(`https://apps.example.com/apps/${"a".repeat(65)}/`),
      env,
    );
    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(404);
    expect(routeKeys).toEqual(["app:orbit_demo.v2"]);
  });

  test("fails closed on an invalid route record", async () => {
    let r2Reads = 0;
    const env = createEnv({
      APP_ROUTES: {
        get: async () => ({
          artifactPrefix: "backups/private",
          suspended: false,
        }),
      } as unknown as KVNamespace,
      APP_BUILDS: {
        get: async () => {
          r2Reads += 1;
          return null;
        },
      } as unknown as R2Bucket,
    });
    const response = await worker.fetch(
      new Request("https://apps.example.com/apps/orbit-demo/"),
      env,
    );
    expect(response.status).toBe(503);
    expect(r2Reads).toBe(0);
  });

  test("serves the packaged-interior manifest from the same host", async () => {
    const requested: string[] = [];
    const env = createEnv({
      APP_ROUTES: {
        get: async (key: string) =>
          key === "app:stella-interior"
            ? {
                artifactPrefix: "interior/e2e-build",
                suspended: false,
              }
            : null,
      } as unknown as KVNamespace,
      APP_BUILDS: {
        get: async (key: string) => {
          requested.push(key);
          if (key === "interior/e2e-build/index.html") {
            return r2Object("<!doctype html><h1>Stella</h1>");
          }
          if (key === "interior/e2e-build/bundle.zip") {
            return r2Object("zip", "application/zip");
          }
          return null;
        },
      } as unknown as R2Bucket,
    });
    const response = await worker.fetch(
      new Request("https://apps.example.com/api/interior/manifest"),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: "interior/e2e-build",
      bundleUrl: "https://apps.example.com/apps/stella-interior/bundle.zip",
      remoteUrl: "https://apps.example.com/apps/stella-interior/",
    });

    const remote = await worker.fetch(
      new Request("https://apps.example.com/apps/stella-interior/"),
      env,
    );
    const bundle = await worker.fetch(
      new Request("https://apps.example.com/apps/stella-interior/bundle.zip"),
      env,
    );
    expect(remote.status).toBe(200);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toBe("application/zip");
    expect(requested).toEqual([
      "interior/e2e-build/index.html",
      "interior/e2e-build/bundle.zip",
    ]);
  });

  test("rejects a packaged-interior route outside its live prefix", async () => {
    let r2Reads = 0;
    const env = createEnv({
      APP_ROUTES: {
        get: async () => ({
          artifactPrefix: "backups/private",
          suspended: false,
        }),
      } as unknown as KVNamespace,
      APP_BUILDS: {
        get: async () => {
          r2Reads += 1;
          return null;
        },
      } as unknown as R2Bucket,
    });
    const response = await worker.fetch(
      new Request("https://apps.example.com/apps/stella-interior/"),
      env,
    );
    expect(response.status).toBe(503);
    expect(r2Reads).toBe(0);
  });

  test("rejects an app asset above the host bound", async () => {
    const oversized = r2Object("");
    Object.defineProperty(oversized, "size", {
      value: MAX_APP_ASSET_BYTES + 1,
    });
    const env = createEnv({
      APP_ROUTES: {
        get: async () => ({
          artifactPrefix: `builds/${"a".repeat(64)}/build-123`,
          suspended: false,
        }),
      } as unknown as KVNamespace,
      APP_BUILDS: {
        get: async () => oversized,
      } as unknown as R2Bucket,
    });
    const response = await worker.fetch(
      new Request("https://apps.example.com/apps/orbit-demo/app.js"),
      env,
    );
    expect(response.status).toBe(503);
  });

  test("resolves active interiors only through the pinned authenticated endpoint", async () => {
    const ownerHash = "b".repeat(64);
    const buildId = `interior-${"c".repeat(48)}`;
    let upstreamUrl = "";
    let authorization = "";
    globalThis.fetch = (async (input, init) => {
      upstreamUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({
        mode: "custom",
        ownerHash,
        buildId,
        artifactPrefix: `interiors/${ownerHash}/${buildId}`,
      });
    }) as typeof fetch;
    const env = createEnv({
      APP_BUILDS: {
        get: async (key: string) =>
          key === `interiors/${ownerHash}/${buildId}/index.html`
            ? r2Object("<!doctype html><h1>Interior</h1>")
            : null,
      } as unknown as R2Bucket,
    });
    const response = await worker.fetch(
      new Request(`https://apps.example.com/stella/${routeId}/`),
      env,
    );
    expect(response.status).toBe(200);
    expect(upstreamUrl).toBe(
      `https://outgoing-bulldog-865.convex.site/api/cloud/interior-active-route?stableRouteId=${routeId}`,
    );
    expect(authorization).toBe(`Bearer ${TEST_SERVICE_SECRET}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("does not expose an interior route when the control plane rejects it", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: "Unauthorized" },
        { status: 401 },
      )) as typeof fetch;
    const response = await worker.fetch(
      new Request(`https://apps.example.com/stella/${routeId}/`),
      createEnv(),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(
      "The active Stella route is unavailable.",
    );
  });
});
