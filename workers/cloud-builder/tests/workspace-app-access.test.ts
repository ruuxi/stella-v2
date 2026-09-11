import { afterEach, describe, expect, test } from "bun:test";
import {
  mintWorkspaceAppAccess,
  serveWorkspaceApp,
} from "../src/workspace-app-access";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("workspace app sessions", () => {
  test("scopes signed access, strips credentials, and invalidates access on reset", async () => {
    let generation = "generation-one";
    globalThis.fetch = (async () =>
      Response.json({ ownerGeneration: generation })) as typeof fetch;
    let calls = 0;
    let forwarded: Request | undefined;
    const env = {
      BUILDER_SERVICE_SECRET: "test-secret-only-for-workspace-app-tests",
      STELLA_CONVEX_SITE_URL: "https://test.convex.site",
      APPS_HOST_BASE_URL: "https://apps.test",
      WORLDS: {
        getByName: () => ({
          fetchWorkspaceApp: async (slug: string, request: Request) => {
            calls++;
            expect(slug).toBe("counter");
            forwarded = request;
            return Response.json(
              { count: 1 },
              {
                headers: {
                  "set-cookie": "unsafe=true",
                  "content-security-policy": "default-src *",
                },
              },
            );
          },
        }),
      },
    } as unknown as Env;
    const session = await mintWorkspaceAppAccess(env, "owner-a", "counter");
    const response = await serveWorkspaceApp(
      new Request(session.url + "api/count", {
        headers: { authorization: "Bearer account", cookie: "account=true" },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts allow-forms;",
    );
    expect(forwarded?.headers.has("authorization")).toBe(false);
    expect(forwarded?.headers.has("cookie")).toBe(false);
    expect(forwarded?.url).toBe("https://app.internal/api/count");
    const tampered = session.url.replace(
      /workspace-apps\/[A-Za-z]/,
      "workspace-apps/Z",
    );
    expect((await serveWorkspaceApp(new Request(tampered), env)).status).toBe(
      401,
    );
    generation = "generation-two";
    expect(
      (await serveWorkspaceApp(new Request(session.url), env)).status,
    ).toBe(403);
    expect(calls).toBe(1);
  });
});
