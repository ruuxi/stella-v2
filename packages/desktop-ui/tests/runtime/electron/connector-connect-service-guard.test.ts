import { mkdtempSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send },
};

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [fakeWindow] },
  shell: { openExternal: vi.fn() },
}));

import { writeCachedServerCatalog } from "@stella/runtime/kernel/connectors/catalog-cache";
import { getNativeConnectorReadiness } from "@stella/runtime/kernel/connectors/connection-status";
import {
  buildNativeConnectorCatalog,
  enableNativeConnector,
  type NativeConnectorCatalogEntry,
} from "@stella/runtime/kernel/connectors/native-integrations";
import { setConnectorTokenStoreBroker } from "@stella/runtime/kernel/connectors/oauth";
import { ConnectorConnectService } from "@stella/desktop/electron/services/connector-connect-service.js";

const roots: string[] = [];
const backendEntry = (
  id: string,
  name: string,
): NativeConnectorCatalogEntry => ({
  id,
  name,
  category: "productivity",
  auth: ["OAUTH2"],
  catalogToolCount: 12,
  availability: "ready",
  provider: "backend-composio",
  description: `Canonical ${name} description.`,
  iconUrl: "https://example.com/canonical.png",
  connectable: true,
  backendConnector: { type: "composio", toolkit: id.toUpperCase() },
});

const makeService = (root: string, withSiteAuth = false) => {
  const credentialService = {
    requestPreregisteredOAuth: vi.fn(),
    requestExternalOAuthApproval: vi.fn(),
    requestDeviceOAuth: vi.fn(),
  };
  const service = new ConnectorConnectService({
    getStellaAppDir: () => root,
    getConvexAuthToken: async () => (withSiteAuth ? "site-token" : null),
    getConvexSiteUrl: () => (withSiteAuth ? "https://stella.test" : null),
    windowManagerTarget: { getWindowManager: () => null } as never,
    connectorCredentialService: credentialService as never,
  });
  return { service, credentialService };
};

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition not reached");
};

const flushUntil = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not reached");
};

afterEach(async () => {
  setConnectorTokenStoreBroker(null);
  vi.unstubAllGlobals();
  send.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ConnectorConnectService canonical guards", () => {
  it("rejects direct bundled-only Outlook requests before emitting a card", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-service-"));
    roots.push(root);
    const { service, credentialService } = makeService(root);

    await expect(
      service.requestConnection({
        id: "outlook",
        name: "Caller supplied Outlook",
        description: "Untrusted description",
      }),
    ).resolves.toEqual({ ok: false, reason: "connector_unavailable" });
    expect(send).not.toHaveBeenCalled();
    expect(credentialService.requestPreregisteredOAuth).not.toHaveBeenCalled();
    expect(
      credentialService.requestExternalOAuthApproval,
    ).not.toHaveBeenCalled();
  });

  it("uses canonical card metadata and revalidates before credential side effects", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-service-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [backendEntry("outlook", "Outlook")]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = String(url);
        if (value.endsWith("/api/native-oauth/providers")) {
          return new Response(
            JSON.stringify({ providers: [{ id: "google-workspace" }] }),
            { status: 200 },
          );
        }
        return new Response("offline", { status: 503 });
      }),
    );
    const { service, credentialService } = makeService(root, true);

    const outcome = service.requestConnection({
      id: "OUTLOOK",
      name: "Spoofed name",
      description: "Spoofed description",
      iconUrl: "https://example.com/spoofed.png",
      category: "spoofed",
    });
    await waitFor(() => send.mock.calls.length === 1);
    const card = send.mock.calls[0]![1] as {
      requestId: string;
      id: string;
      name: string;
      description: string;
      iconUrl: string;
      category: string;
    };
    expect(card).toMatchObject({
      id: "outlook",
      name: "Outlook",
      description: "Canonical Outlook description.",
      iconUrl: "https://example.com/canonical.png",
      category: "productivity",
    });

    await unlink(path.join(root, "connectors/catalog-cache.json"));
    expect(
      service.respond({ requestId: card.requestId, action: "accept" }),
    ).toEqual({
      ok: true,
    });
    await expect(outcome).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("no longer available"),
    });
    expect(credentialService.requestPreregisteredOAuth).not.toHaveBeenCalled();
    expect(
      credentialService.requestExternalOAuthApproval,
    ).not.toHaveBeenCalled();
    expect(credentialService.requestDeviceOAuth).not.toHaveBeenCalled();
  });

  it("blocks a same-id backend Gmail to bundled Google Workspace provider swap", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-service-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [backendEntry("gmail", "Gmail")]);
    const { service, credentialService } = makeService(root);

    const outcome = service.requestConnection({ id: "gmail", name: "Gmail" });
    await waitFor(() => send.mock.calls.length === 1);
    const card = send.mock.calls[0]![1] as { requestId: string };
    await unlink(path.join(root, "connectors/catalog-cache.json"));
    service.respond({ requestId: card.requestId, action: "accept" });

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("connector changed"),
    });
    expect(credentialService.requestPreregisteredOAuth).not.toHaveBeenCalled();
    expect(
      credentialService.requestExternalOAuthApproval,
    ).not.toHaveBeenCalled();
  });

  it("blocks a same-provider backend toolkit semantic change", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-service-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [backendEntry("notion", "Notion")]);
    const { service, credentialService } = makeService(root);

    const outcome = service.requestConnection({ id: "notion", name: "Notion" });
    await waitFor(() => send.mock.calls.length === 1);
    const card = send.mock.calls[0]![1] as { requestId: string };
    await writeCachedServerCatalog(root, [
      {
        ...backendEntry("notion", "Notion"),
        backendConnector: { type: "composio", toolkit: "NOTION_V2" },
      },
    ]);
    service.respond({ requestId: card.requestId, action: "accept" });

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("connector changed"),
    });
    expect(
      credentialService.requestExternalOAuthApproval,
    ).not.toHaveBeenCalled();
  });

  it("reconnects enabled Gmail with a missing token and restores executable readiness", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-service-"));
    roots.push(root);
    await enableNativeConnector(root, "gmail", "store");
    let token: { accessToken: string } | null = null;
    setConnectorTokenStoreBroker({
      load: async () => token,
      save: async () => undefined,
      delete: async () => undefined,
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/api/native-oauth/providers")) {
        return new Response(
          JSON.stringify({ providers: [{ id: "google-workspace" }] }),
          { status: 200 },
        );
      }
      return new Response("offline", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { service, credentialService } = makeService(root, true);
    credentialService.requestPreregisteredOAuth.mockImplementation(async () => {
      token = { accessToken: "restored-token" };
      return { ok: true };
    });

    const outcome = service.requestConnection({ id: "gmail", name: "spoofed" });
    await waitFor(() => send.mock.calls.length === 1);
    const card = send.mock.calls[0]![1] as { requestId: string; name: string };
    expect(card.name).toBe("Gmail");
    service.respond({ requestId: card.requestId, action: "accept" });
    await expect(outcome).resolves.toEqual({ ok: true, status: "connected" });
    expect(credentialService.requestPreregisteredOAuth).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/native-integrations/catalog"),
      ),
    ).toHaveLength(2);

    const gmail = buildNativeConnectorCatalog().find(
      (entry) => entry.id === "gmail",
    )!;
    await expect(
      getNativeConnectorReadiness(root, gmail),
    ).resolves.toMatchObject({
      enabled: true,
      accountVerified: true,
      executable: true,
    });
  });

  it("resolves a backend Composio card via the completion status poll", async () => {

    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-service-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [
      backendEntry("googledocs", "Google Docs"),
    ]);
    const statusCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = String(url);
        if (value.endsWith("/api/native-oauth/providers")) {
          return new Response(JSON.stringify({ providers: [] }), {
            status: 200,
          });
        }
        if (value.endsWith("/api/native-integrations/connect-link")) {
          return new Response(
            JSON.stringify({ url: "https://dashboard.composio.dev/link/lk_test" }),
            { status: 200 },
          );
        }
        if (value.includes("/api/native-integrations/status")) {
          statusCalls.push(value);
          return new Response(JSON.stringify({ connected: true }), {
            status: 200,
          });
        }
        return new Response("offline", { status: 503 });
      }),
    );
    const { service, credentialService } = makeService(root, true);
    credentialService.requestExternalOAuthApproval.mockResolvedValue({
      ok: true,
    });

    const outcome = service.requestConnection({
      id: "googledocs",
      name: "Google Docs",
    });
    await waitFor(() => send.mock.calls.length === 1);
    const card = send.mock.calls[0]![1] as { requestId: string };
    service.respond({ requestId: card.requestId, action: "accept" });

    await expect(outcome).resolves.toEqual({ ok: true, status: "connected" });
    expect(credentialService.requestExternalOAuthApproval).toHaveBeenCalledOnce();
    expect(
      credentialService.requestExternalOAuthApproval.mock.calls[0]![0],
    ).toMatchObject({
      resourceUrl: "https://dashboard.composio.dev/link/lk_test",
      presentation: "headless",
    });
    expect(statusCalls.length).toBeGreaterThan(0);
    expect(statusCalls[0]).toContain("id=googledocs");
    const phases = send.mock.calls
      .filter(([channel]) => channel === "connector-connect:update")
      .map(([, payload]) => (payload as { phase: string }).phase);
    expect(phases).toEqual(["connecting", "connected"]);
    await expect(
      getNativeConnectorReadiness(root, backendEntry("googledocs", "Google Docs")),
    ).resolves.toMatchObject({
      enabled: true,
      connected: true,
      executable: true,
    });
  });

  it("backstops a wedged connecting flow at the card timeout", async () => {

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const root = mkdtempSync(
        path.join(os.tmpdir(), "stella-connect-service-"),
      );
      roots.push(root);
      await writeCachedServerCatalog(root, [
        backendEntry("googledocs", "Google Docs"),
      ]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL | Request) => {
          const value = String(url);
          if (value.endsWith("/api/native-oauth/providers")) {
            return new Response(JSON.stringify({ providers: [] }), {
              status: 200,
            });
          }
          if (value.endsWith("/api/native-integrations/connect-link")) {
            return new Response(
              JSON.stringify({
                url: "https://dashboard.composio.dev/link/lk_test",
              }),
              { status: 200 },
            );
          }
          return new Response("offline", { status: 503 });
        }),
      );
      const { service, credentialService } = makeService(root, true);
      let approvalRequested = false;
      credentialService.requestExternalOAuthApproval.mockImplementation(() => {
        approvalRequested = true;

        return new Promise(() => undefined);
      });

      const outcome = service.requestConnection({
        id: "googledocs",
        name: "Google Docs",
      });
      await flushUntil(() => send.mock.calls.length === 1);
      const card = send.mock.calls[0]![1] as { requestId: string };
      service.respond({ requestId: card.requestId, action: "accept" });
      await flushUntil(() => approvalRequested);

      await vi.advanceTimersByTimeAsync(9.5 * 60 * 1000);
      await expect(outcome).resolves.toEqual({
        ok: false,
        reason: "timeout",
      });
      const phases = send.mock.calls
        .filter(([channel]) => channel === "connector-connect:update")
        .map(([, payload]) => (payload as { phase: string }).phase);
      expect(phases).toEqual(["connecting", "timeout"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
