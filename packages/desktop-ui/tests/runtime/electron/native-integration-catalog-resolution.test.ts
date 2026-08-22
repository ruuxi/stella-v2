import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { writeCachedServerCatalog } from "@stella/runtime/kernel/connectors/catalog-cache";
import type { NativeConnectorCatalogEntry } from "@stella/runtime/kernel/connectors/native-integrations";
import {
  disableDesktopNativeIntegration,
  resolveDesktopNativeConnectorEntry,
} from "@stella/desktop/electron/ipc/native-integration-handlers.js";

const roots: string[] = [];
const backendEntry = (
  id: string,
  name: string,
): NativeConnectorCatalogEntry => ({
  id,
  name,
  category: "productivity",
  auth: ["OAUTH2"],
  catalogToolCount: 4,
  availability: "ready",
  provider: "backend-composio",
  description: `${name} integration.`,
  connectable: true,
  backendConnector: { type: "composio", toolkit: id.toUpperCase() },
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop native integration catalog resolution", () => {
  it("returns incomplete bundled Outlook metadata when no authoritative catalog exists", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-desktop-catalog-"));
    roots.push(root);
    const resolved = await resolveDesktopNativeConnectorEntry(
      {},
      root,
      "outlook",
    );
    expect(resolved.catalog.sources.outlook).toBe("bundled");
    expect(resolved.entry).toMatchObject({
      provider: "oauth-catalog",
      localExecution: "incomplete",
    });
  });

  it("keeps cached Outlook backend semantics when live auth is unavailable", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-desktop-catalog-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [backendEntry("outlook", "Outlook")]);

    const resolved = await resolveDesktopNativeConnectorEntry(
      { getConvexSiteUrl: () => null, getConvexAuthToken: async () => null },
      root,
      "outlook",
    );
    expect(resolved.catalog.sources.outlook).toBe("cache");
    expect(resolved.entry).toMatchObject({
      id: "outlook",
      provider: "backend-composio",
      backendConnector: { toolkit: "OUTLOOK" },
    });
  });

  it("keeps cached backend-only ids available to enable and connect flows", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-desktop-catalog-"));
    roots.push(root);
    const entry = backendEntry("desktop_backend_only", "Desktop Backend Only");
    await writeCachedServerCatalog(root, [entry]);

    const resolved = await resolveDesktopNativeConnectorEntry(
      {},
      root,
      entry.id,
    );
    expect(resolved.catalog.sources[entry.id]).toBe("cache");
    expect(resolved.entry).toMatchObject({
      id: entry.id,
      provider: "backend-composio",
    });
  });

  it("keeps locally bundled connectors resolvable beside cached server entries", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-desktop-catalog-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [
      backendEntry("desktop_backend_only", "Desktop Backend Only"),
    ]);

    const resolved = await resolveDesktopNativeConnectorEntry(
      {},
      root,
      "googlesuper",
    );
    expect(resolved.catalog.sources.googlesuper).toBe("bundled");
    expect(resolved.entry).toMatchObject({
      id: "googlesuper",
      name: "Google Workspace",
      provider: "google-workspace",
    });
  });

  it("attributes stale cached Google metadata to the bundled native owner", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-desktop-catalog-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [
      backendEntry("gmail", "Stale Gmail"),
    ]);

    const resolved = await resolveDesktopNativeConnectorEntry(
      {},
      root,
      "gmail",
    );
    expect(resolved.catalog.source).toBe("cache");
    expect(resolved.catalog.sources.gmail).toBe("bundled");
    expect(resolved.entry).toMatchObject({
      id: "gmail",
      name: "Gmail",
      provider: "google-workspace",
      localExecution: "production-ready",
    });
  });

  it("destroys a possible backend API key directly before local disable", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-desktop-catalog-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [
      backendEntry("firecrawl", "Firecrawl"),
    ]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/api/native-integrations/disconnect")) {
          return new Response(JSON.stringify({ disconnected: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, { status: 503 });
      });

    await disableDesktopNativeIntegration(
      {
        getStellaAppDir: () => root,
        getConvexSiteUrl: () => "https://backend.stella.test/",
        getConvexAuthToken: async () => "session-token-sentinel",
        assertPrivilegedSender: () => true,
      },
      { id: "firecrawl" },
    );

    const disconnectCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/api/native-integrations/disconnect"),
    );
    expect(disconnectCall).toBeDefined();
    expect(disconnectCall?.[1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer session-token-sentinel",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "firecrawl" }),
    });
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/status")),
    ).toBe(false);
  });

  it("does not locally disable when backend key destruction is uncertain", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-desktop-catalog-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [
      backendEntry("firecrawl", "Firecrawl"),
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) =>
        new Response(null, {
          status: String(input).endsWith("/api/native-integrations/disconnect")
            ? 503
            : 404,
        }),
    );

    await expect(
      disableDesktopNativeIntegration(
        {
          getStellaAppDir: () => root,
          getConvexSiteUrl: () => "https://backend.stella.test",
          getConvexAuthToken: async () => "session-token-sentinel",
          assertPrivilegedSender: () => true,
        },
        { id: "firecrawl" },
      ),
    ).rejects.toThrow("Could not destroy the server-owned API key.");
  });
});
