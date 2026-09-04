import { afterEach, describe, expect, test } from "bun:test";
import { MAX_APP_ASSET_BYTES } from "../src/http-security";
import worker from "../src/index";
import { createUntrustedEnv as createEnv } from "./fixtures";

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
                appId: "app-orbit",
                slug: "orbit-demo",
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
    const wrapperHtml = await response.text();
    expect(wrapperHtml).toContain(
      'data-raw-src="/_stella/apps-assets/orbit-demo/"',
    );
    expect(wrapperHtml).not.toContain(
      ' src="/_stella/apps-assets/orbit-demo/"',
    );
    expect(wrapperHtml).not.toContain("app-orbit");
    expect(wrapperHtml).toContain(
      'data-bootstrap-refresh-url="/apps/orbit-demo/_bootstrap"',
    );
    expect(requested).toEqual([]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("https://outgoing-bulldog-865.convex.site");
    const raw = await worker.fetch(
      new Request("https://apps.example.com/_stella/apps-assets/orbit-demo/"),
      env,
    );
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(raw.headers.get("access-control-allow-origin")).toBeNull();
    expect(requested).toEqual([
      `builds/${"a".repeat(64)}/build-123/index.html`,
    ]);
  });

  test("refreshes only the route-bound app bootstrap from the fixed wrapper origin", async () => {
    const minted: Array<{ appId: string; slug: string; origin: string }> = [];
    const env = createEnv({
      HOST_ROLE: "untrusted",
      BUILDER_SERVICE_SECRET: undefined,
      APP_TOKEN_SIGNING_KEY: undefined,
      APP_FETCH_GATE: {
        getByName: () => ({ consume: async () => ({ ok: true }) }),
      },
      APP_AUTH: {
        mintAppBootstrap: async (args) => {
          minted.push(args);
          return {
            bootstrap: "refreshed-bootstrap",
            expiresAt: Date.now() + 120_000,
          };
        },
        mintAnonymousSession: async () => ({}),
        verifyFetchCapability: async () => ({ ok: false }),
      },
      APP_ROUTES: {
        get: async (key: string) =>
          key === "app:orbit-demo"
            ? {
                artifactPrefix: `builds/${"a".repeat(64)}/build-123`,
                appId: "server-resolved-app",
                slug: "orbit-demo",
                suspended: false,
              }
            : null,
      } as unknown as KVNamespace,
    });
    const endpoint =
      "https://stella-v2-apps-host-dev.lolruuxi.workers.dev/apps/orbit-demo/_bootstrap";
    const allowed = await worker.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          origin: "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
        },
      }),
      env,
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      bootstrap: "refreshed-bootstrap",
    });
    expect(minted).toEqual([
      {
        appId: "server-resolved-app",
        slug: "orbit-demo",
        origin: "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
      },
    ]);

    for (const request of [
      new Request(endpoint, {
        method: "POST",
        headers: {
          origin: "null",
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "cors",
        },
      }),
      new Request(endpoint, {
        method: "POST",
        headers: {
          origin: "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "content-type": "application/json",
        },
        body: JSON.stringify({ appId: "caller-chosen-app" }),
      }),
    ]) {
      const denied = await worker.fetch(request, env);
      expect([400, 403]).toContain(denied.status);
    }
    expect(minted).toHaveLength(1);
  });

  test("sandboxes active non-HTML assets on direct navigation", async () => {
    const env = createEnv({
      APP_ROUTES: {
        get: async () => ({
          artifactPrefix: `builds/${"a".repeat(64)}/build-123`,
          appId: "app-orbit",
          slug: "orbit-demo",
          suspended: false,
        }),
      } as unknown as KVNamespace,
      APP_BUILDS: {
        get: async () =>
          r2Object(
            '<svg xmlns="http://www.w3.org/2000/svg"><script>top.location="https://attacker.example"</script></svg>',
            "image/svg+xml",
          ),
      } as unknown as R2Bucket,
    });
    const response = await worker.fetch(
      new Request(
        "https://apps.example.com/_stella/apps-assets/orbit-demo/active.svg",
      ),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("rejects malformed asset paths before reading R2", async () => {
    let r2Reads = 0;
    const env = createEnv({
      APP_ROUTES: {
        get: async () => ({
          artifactPrefix: `builds/${"a".repeat(64)}/build-123`,
          appId: "app-orbit",
          slug: "orbit-demo",
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
      new Request(
        "https://apps.example.com/_stella/apps-assets/orbit-demo/%5Csecret",
      ),
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
            appId: "app-orbit",
            slug: key.slice("app:".length),
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
          appId: "app-orbit",
          slug: "orbit-demo",
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

  test("rejects an app asset above the host bound", async () => {
    const oversized = r2Object("");
    Object.defineProperty(oversized, "size", {
      value: MAX_APP_ASSET_BYTES + 1,
    });
    const env = createEnv({
      APP_ROUTES: {
        get: async () => ({
          artifactPrefix: `builds/${"a".repeat(64)}/build-123`,
          appId: "app-orbit",
          slug: "orbit-demo",
          suspended: false,
        }),
      } as unknown as KVNamespace,
      APP_BUILDS: {
        get: async () => oversized,
      } as unknown as R2Bucket,
    });
    const response = await worker.fetch(
      new Request(
        "https://apps.example.com/_stella/apps-assets/orbit-demo/app.js",
      ),
      env,
    );
    expect(response.status).toBe(503);
  });
});
