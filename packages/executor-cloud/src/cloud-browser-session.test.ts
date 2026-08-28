import { describe, expect, test } from "bun:test";

import { isAgentToolSuspendedError } from "@stella/runtime/kernel/agent-core/suspension.js";
import {
  BrowserSessionCommandError,
  type BrowserSessionAction,
  type BrowserSessionClient,
} from "@stella/runtime/kernel/browser-use/client.js";
import { installBrowserWorkerApi } from "@stella/runtime/kernel/browser-use/worker-api.js";
import {
  CLOUD_BROWSER_COMMAND_PATH,
  createTurnBrokerBrowserSessionFactory,
} from "./cloud-browser-session.js";

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeClient = (
  response: (body: unknown) => Response | Promise<Response>,
): {
  client: BrowserSessionClient;
  calls: Array<{ path: string; body: unknown; signal?: AbortSignal }>;
} => {
  const calls: Array<{ path: string; body: unknown; signal?: AbortSignal }> =
    [];
  const factory = createTurnBrokerBrowserSessionFactory({
    postJson: async (path, body, signal) => {
      calls.push({ path, body, ...(signal ? { signal } : {}) });
      return await response(body);
    },
  });
  return {
    client: factory({ sessionId: "thread-1", cwd: "/workspace" }),
    calls,
  };
};

describe("turn-broker cloud browser session", () => {
  test("maps a standard tab open to the exact gateway envelope", async () => {
    const { client, calls } = makeClient((body) => {
      const request = body as { requestId: string };
      return json({
        schemaVersion: 1,
        outcome: "completed",
        requestId: request.requestId,
        data: {
          profileId: "default",
          profileEpoch: 2,
          restored: false,
          observation: {
            url: "https://example.test/",
            title: "Example",
            text: "Welcome",
          },
        },
      });
    });
    const controller = new AbortController();
    const receipt = await client.command(
      "tab_new",
      { url: "https://example.test/" },
      {
        signal: controller.signal,
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(CLOUD_BROWSER_COMMAND_PATH);
    expect(calls[0]?.body).toEqual({
      schemaVersion: 1,
      requestId: expect.any(String),
      action: "browser.open",
      params: {
        allowedOrigins: ["https://example.test"],
        startUrl: "https://example.test/",
      },
    });
    expect(calls[0]?.body).not.toHaveProperty("profileId");
    expect(calls[0]?.body).not.toHaveProperty("profileEpoch");
    expect(calls[0]?.body).not.toHaveProperty("capability");
    expect(calls[0]?.signal).toBe(controller.signal);
    expect(receipt).toMatchObject({
      sessionId: "thread-1",
      bridgeSessionId: "cloud-browser-run",
      action: "tab_new",
      attempts: 1,
      result: {
        success: true,
        data: {
          tabId: 1,
          tabGeneration: "cloud:1",
          url: "https://example.test/",
          title: "Example",
          active: true,
        },
      },
    });
    await client.dispose();
  });

  test("maps the narrow regular browser surface and synthesizes stable tab handles", async () => {
    const { client, calls } = makeClient((body) => {
      const request = body as { requestId: string; action: string };
      const data =
        request.action === "browser.tabs"
          ? {
              tabs: [
                {
                  tabId: "gateway-tab-a",
                  url: "https://example.test/account",
                  title: "Account",
                  active: true,
                },
              ],
            }
          : request.action === "browser.navigate" ||
              request.action === "browser.observe"
            ? {
                observation: {
                  url: "https://example.test/account",
                  title: "Account",
                  text: "Signed in",
                },
              }
            : { ok: true };
      return json({
        schemaVersion: 1,
        outcome: "completed",
        requestId: request.requestId,
        data,
      });
    });

    await client.command("navigate", {
      tabId: 1,
      url: "https://example.test/account",
    });
    await client.command("snapshot", { tabId: 1, compact: true });
    await client.command("click", { tabId: 1, selector: "#submit" });
    await client.command("fill", {
      tabId: 1,
      selector: "#display-name",
      value: "Rahul",
    });
    await client.command("press", { tabId: 1, key: "Enter" });
    await client.command("select", {
      tabId: 1,
      selector: "#plan",
      values: ["pro"],
    });
    await client.command("wait", {
      tabId: 1,
      selector: "[data-ready]",
      timeout: 2_000,
    });
    const listed = await client.command<{
      tabs: Array<{ tabId: number }>;
    }>("tab_list");
    const localTabId = listed.result.data?.tabs[0]?.tabId;
    expect(localTabId).toBe(1);
    await client.command("tab_switch", { tabId: localTabId! });

    expect(
      calls.map((call) => {
        const body = call.body as { action: string; params: unknown };
        return { action: body.action, params: body.params };
      }),
    ).toEqual([
      {
        action: "browser.navigate",
        params: { url: "https://example.test/account" },
      },
      { action: "browser.observe", params: {} },
      { action: "browser.click", params: { selector: "#submit" } },
      {
        action: "browser.fill",
        params: {
          selector: "#display-name",
          value: "Rahul",
          sensitivity: "non_secret",
        },
      },
      {
        action: "browser.press",
        params: { selector: "body", key: "Enter" },
      },
      {
        action: "browser.select",
        params: { selector: "#plan", value: "pro" },
      },
      {
        action: "browser.wait",
        params: { selector: "[data-ready]", timeoutMs: 2_000 },
      },
      { action: "browser.tabs", params: {} },
      { action: "browser.focus_tab", params: { tabId: "gateway-tab-a" } },
    ]);
    await client.dispose();
  });

  test("maps login takeover and device-code outcomes to the same typed suspension", async () => {
    for (const interactionKind of ["login_takeover", "device_code"] as const) {
      const { client, calls } = makeClient((body) => {
        const request = body as {
          requestId: string;
        };
        return json({
          schemaVersion: 1,
          outcome: "suspended",
          suspension: {
            schemaVersion: 1,
            outcome: "waiting_for_user",
            interactionId: `interaction-${interactionKind}`,
            interactionRevision: 1,
            interactionKind,
            toolCallId: request.requestId,
            requestDigest: "a".repeat(64),
            profileId: "default",
            profileEpoch: 3,
            displayOrigin:
              interactionKind === "login_takeover"
                ? "https://www.demoblaze.com"
                : "https://example.test",
            expiresAt: Date.now() + 60_000,
          },
        });
      });
      client.beginTurn?.("outer-code-tool-call");
      try {
        await (interactionKind === "login_takeover"
          ? client.command("cloud_login_takeover", {
              allowedOrigins: ["https://www.demoblaze.com"],
              displayOrigin: "https://www.demoblaze.com",
              startUrl: "https://www.demoblaze.com/index.html",
              verification: {
                expectedOrigin: "https://www.demoblaze.com",
                authenticatedSelector: "#nameofuser",
                loggedOutSelector: "#login2",
                resumeUrl: "https://www.demoblaze.com/index.html",
              },
            })
          : client.command("cloud_device_code_fixture", {
              expiresInMs: 60_000,
            }));
        throw new Error("expected suspension");
      } catch (error) {
        expect(isAgentToolSuspendedError(error)).toBe(true);
        if (!isAgentToolSuspendedError(error)) throw error;
        expect(error.suspension.interactionKind).toBe(interactionKind);
        expect(error.suspension.toolCallId).toBe(
          (calls[0]?.body as { requestId: string }).requestId,
        );
        expect(calls[0]?.body).toEqual({
          schemaVersion: 1,
          requestId: expect.any(String),
          action:
            interactionKind === "login_takeover"
              ? "browser.login_takeover"
              : "device_code.fixture_start",
          params:
            interactionKind === "login_takeover"
              ? {
                  allowedOrigins: ["https://www.demoblaze.com"],
                  displayOrigin: "https://www.demoblaze.com",
                  startUrl: "https://www.demoblaze.com/index.html",
                  verification: {
                    expectedOrigin: "https://www.demoblaze.com",
                    authenticatedSelector: "#nameofuser",
                    loggedOutSelector: "#login2",
                    resumeUrl: "https://www.demoblaze.com/index.html",
                  },
                }
              : { expiresInMs: 60_000 },
        });
        expect(calls[0]?.body).not.toHaveProperty("params.toolCallId");
        expect(calls[0]?.body).not.toHaveProperty("params.profileId");
        expect(calls[0]?.body).not.toHaveProperty("params.profileEpoch");
        const serialized = JSON.stringify(error.suspension);
        expect(serialized).not.toContain("device_secret");
        expect(serialized).not.toContain("access_token");
        expect(serialized).not.toContain("refresh_token");
        expect(serialized).not.toContain("live.browser.run");
        await client.endTurn?.("outer-code-tool-call", "retain-tabs");
        expect(calls).toHaveLength(1);
      } finally {
        await client.dispose();
      }
    }
  });

  test("checkpoints before normal retain or close teardown", async () => {
    for (const behavior of ["retain-tabs", "close-tabs"] as const) {
      const { client, calls } = makeClient((body) => {
        const request = body as { requestId: string };
        return json({
          schemaVersion: 1,
          outcome: "completed",
          requestId: request.requestId,
          data: {},
        });
      });
      client.beginTurn?.(`turn-${behavior}`);
      await client.endTurn?.(`turn-${behavior}`, behavior);
      expect(
        calls.map((call) => {
          const body = call.body as {
            action: string;
            params: Record<string, unknown>;
          };
          return { action: body.action, params: body.params };
        }),
      ).toEqual(
        behavior === "retain-tabs"
          ? [{ action: "browser.checkpoint", params: {} }]
          : [
              { action: "browser.checkpoint", params: {} },
              { action: "browser.close", params: {} },
            ],
      );
      await client.dispose();
    }
  });

  test("the runtime Demoblaze takeover shape passes the real Gateway parser", async () => {
    // Keep the production Gateway parser as the contract oracle without
    // importing its Cloudflare ambient types into executor-cloud's Node
    // typecheck. Bun loads the actual TypeScript modules at test time.
    const [{ BrowserProfileSessionCore }, { MemoryProfileStore }, fixtures] =
      await Promise.all([
        import(
          new URL(
            "../../../workers/browser-gateway/src/profile-session-core.ts",
            import.meta.url,
          ).href
        ),
        import(
          new URL(
            "../../../workers/browser-gateway/src/profile-store.ts",
            import.meta.url,
          ).href
        ),
        import(
          new URL(
            "../../../workers/browser-gateway/tests/fixtures.ts",
            import.meta.url,
          ).href
        ),
      ]);
    const { AUTHORITY, FakeBrowser, MemoryR2, TEST_KEK, uuid } = fixtures;
    const gatewayBrowser = new FakeBrowser();
    const core = new BrowserProfileSessionCore({
      store: new MemoryProfileStore(),
      browser: gatewayBrowser,
      bucket: new MemoryR2().asBucket(),
      kekV1: TEST_KEK,
      randomUuid: () => uuid(991),
    });
    const { client, calls } = makeClient(async (body) =>
      json(
        await core.turn({
          schemaVersion: 1,
          authority: AUTHORITY,
          command: body,
        } as never),
      ),
    );
    client.beginTurn?.("outer-code-tool-call");
    const browser = installBrowserWorkerApi(async (method, args) => {
      if (method !== "command") {
        throw new Error(`Unexpected browser method '${method}'.`);
      }
      return await client.command(
        args[0] as BrowserSessionAction,
        args[1] as never,
      );
    });

    const error = await browser
      .requestLoginTakeover({
        allowedOrigins: ["https://www.demoblaze.com"],
        displayOrigin: "https://www.demoblaze.com",
        startUrl: "https://www.demoblaze.com/index.html",
        verification: {
          expectedOrigin: "https://www.demoblaze.com",
          authenticatedSelector: "#nameofuser",
          loggedOutSelector: "#login2",
          resumeUrl: "https://www.demoblaze.com/index.html",
        },
      })
      .catch((failure: unknown) => failure);
    expect(isAgentToolSuspendedError(error)).toBe(true);
    expect(gatewayBrowser.currentUrl).toBe(
      "https://www.demoblaze.com/index.html",
    );
    expect(gatewayBrowser.verificationStates).toEqual(["logged_out"]);
    expect(gatewayBrowser.handoffCount).toBe(1);
    expect(calls[0]?.body).toMatchObject({
      action: "browser.login_takeover",
      params: {
        allowedOrigins: ["https://www.demoblaze.com"],
        displayOrigin: "https://www.demoblaze.com",
        startUrl: "https://www.demoblaze.com/index.html",
        verification: {
          expectedOrigin: "https://www.demoblaze.com",
          authenticatedSelector: "#nameofuser",
          loggedOutSelector: "#login2",
          resumeUrl: "https://www.demoblaze.com/index.html",
        },
      },
    });
    await client.dispose();
  });

  test("never reflects gateway failure text or private state to code", async () => {
    const failed = makeClient((body) =>
      json({
        schemaVersion: 1,
        outcome: "failed",
        requestId: (body as { requestId: string }).requestId,
        code: "UPSTREAM",
        message: "private-token-should-not-escape",
      }),
    );
    const failedError = await failed.client
      .command("url")
      .catch((error: unknown) => error);
    expect(failedError).toBeInstanceOf(BrowserSessionCommandError);
    expect((failedError as Error).message).toBe(
      "Cloud browser command failed.",
    );
    expect((failedError as Error).message).not.toContain("private-token");
    await failed.client.dispose();

    const leaked = makeClient((body) =>
      json({
        schemaVersion: 1,
        outcome: "completed",
        requestId: (body as { requestId: string }).requestId,
        data: { liveViewCapability: "https://live.browser.run/private" },
      }),
    );
    const leakedError = await leaked.client
      .command("url")
      .catch((error: unknown) => error);
    expect(leakedError).toBeInstanceOf(BrowserSessionCommandError);
    expect((leakedError as Error).message).toBe(
      "Cloud browser returned an invalid response.",
    );
    await leaked.client.dispose();
  });

  test("rejects chain, arbitrary local commands, and model-supplied tool ids before dispatch", async () => {
    const { client, calls } = makeClient(() => {
      throw new Error("broker must not be called");
    });
    client.beginTurn?.("outer-code-tool-call");
    await expect(
      client.chain([{ action: "click", params: { selector: "#x" } }]),
    ).rejects.toThrow("Cloud browser batching is unavailable");
    await expect(client.command("evaluate", {})).rejects.toThrow(
      "Cloud browser action 'evaluate' is unavailable.",
    );
    await expect(
      client.command("cloud_device_code_fixture", {
        toolCallId: "model-controlled",
      } as never),
    ).rejects.toThrow("parameters are unsupported");
    expect(calls).toHaveLength(0);
    await client.dispose();
  });
});
