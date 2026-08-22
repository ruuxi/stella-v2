import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildNativeConnectorCatalog,
  disableNativeConnector,
  enableNativeConnector,
  getNativeConnectorCatalogActions,
  getNativeConnectorTools,
  isNativeConnectorEnabled,
  listNativeConnectors,
  type NativeConnectorCatalogEntry,
} from "@stella/runtime/kernel/connectors/native-integrations";
import { isNativeOAuthLocalExecutionProductionReady } from "@stella/runtime/kernel/connectors/native-oauth-provider-config";

const roots: string[] = [];
const createRoot = () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "stella-native-integrations-"),
  );
  roots.push(root);
  return root;
};

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
  description: `${name} Store integration.`,
  connectable: true,
  backendConnector: { type: "composio", toolkit: id.toUpperCase() },
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("native integration execution policy", () => {
  it("enumerates only shipped Google Workspace entries as production-ready local implementations", () => {
    const catalog = buildNativeConnectorCatalog();
    for (const id of [
      "gmail",
      "googlecalendar",
      "googledocs",
      "googledrive",
      "googlesheets",
      "googletasks",
    ]) {
      const entry = catalog.find((candidate) => candidate.id === id);
      expect(entry).toMatchObject({
        provider: "google-workspace",
        localExecution: "production-ready",
      });
      expect(getNativeConnectorTools(entry!).length).toBeGreaterThan(0);
    }
  });

  it("ships the one-tap Google Workspace bundle under the googlesuper id exposing every tool", () => {
    const catalog = buildNativeConnectorCatalog();
    const bundle = catalog.find((candidate) => candidate.id === "googlesuper");
    expect(bundle).toMatchObject({
      id: "googlesuper",
      name: "Google Workspace",
      provider: "google-workspace",
      localExecution: "production-ready",
      connectable: true,
    });
    // User-visible text must not carry the legacy "Google Super" name.
    expect(bundle?.name).not.toContain("Super");
    expect(bundle?.description ?? "").not.toContain("Super");
    // The bundle exposes the full allowlist, not a single service prefix.
    expect(getNativeConnectorTools(bundle!).length).toBe(
      getNativeConnectorCatalogActions(bundle!).length,
    );
    expect(getNativeConnectorTools(bundle!).length).toBeGreaterThan(
      getNativeConnectorTools(
        catalog.find((candidate) => candidate.id === "gmail")!,
      ).length,
    );
  });

  it("keeps all user-visible Google Workspace catalog text free of the legacy bundle name", () => {
    for (const entry of buildNativeConnectorCatalog()) {
      if (entry.provider !== "google-workspace") continue;
      expect(entry.name).not.toContain("Super");
      expect(entry.description ?? "").not.toContain("Super");
    }
  });

  it("does not infer local readiness from OAuth templates", () => {
    for (const id of [
      "outlook",
      "notion",
      "sentry",
      "todoist",
      "future_provider",
    ]) {
      expect(isNativeOAuthLocalExecutionProductionReady(id)).toBe(false);
    }
    const catalog = buildNativeConnectorCatalog();
    for (const id of ["outlook", "notion", "sentry", "todoist"]) {
      const entry = catalog.find((candidate) => candidate.id === id);
      expect(entry).toMatchObject({
        provider: "oauth-catalog",
        localExecution: "incomplete",
      });
      expect(getNativeConnectorTools(entry!)).toEqual([]);
    }
  });

  it("keeps recovered actions as metadata without exposing setup or execution", async () => {
    const root = createRoot();
    const outlook = (await listNativeConnectors(root)).find(
      (entry) => entry.id === "outlook",
    );
    expect(outlook).toMatchObject({
      connectable: false,
      oauthSetupStatus: "local_implementation_incomplete",
      toolCount: 0,
      actionCount: 282,
    });
    expect(outlook?.oauthSetupMessage).toContain("metadata only");
    await expect(enableNativeConnector(root, "outlook", "cli")).rejects.toThrow(
      "local execution is incomplete",
    );
  });

  it("requires a deliberate entry capability before a future local dispatcher can execute", () => {
    const incomplete: NativeConnectorCatalogEntry = {
      id: "future_provider",
      name: "Future Provider",
      category: "productivity",
      auth: ["OAUTH2"],
      catalogToolCount: 1,
      availability: "ready",
      provider: "oauth-catalog",
      localExecution: "incomplete",
      description: "Future provider metadata.",
      connectable: false,
      oauthConfig: {
        flow: "authorization_code",
        tokenKey: "future-provider",
        clientId: "client",
        authorizationEndpoint: "https://example.com/authorize",
        tokenEndpoint: "https://example.com/token",
        resourceUrl: "https://api.example.com",
      },
    };
    expect(getNativeConnectorTools(incomplete)).toEqual([]);
    expect(
      getNativeConnectorTools({
        ...incomplete,
        localExecution: "production-ready",
      }),
    ).toEqual([
      expect.objectContaining({ name: "FUTURE_PROVIDER_API_REQUEST" }),
    ]);
  });

  it("keeps production-ready native execution authoritative on a same-id collision", () => {
    const serverGmail = backendEntry("gmail", "Gmail");
    const resolved = buildNativeConnectorCatalog([serverGmail]).find(
      (entry) => entry.id === "gmail",
    );
    expect(resolved).toMatchObject({
      provider: "google-workspace",
      localExecution: "production-ready",
    });
    expect(getNativeConnectorTools(resolved!).length).toBeGreaterThan(1);
  });

  it("keeps backend-only Store connectors enableable and writes their action skill", async () => {
    const root = createRoot();
    const entry = backendEntry("backend_only", "Backend Only");
    const enabled = await enableNativeConnector(root, entry.id, "store", {}, [
      entry,
    ]);
    expect(enabled).toMatchObject({
      id: entry.id,
      enabled: true,
      provider: "backend-composio",
      toolCount: 1,
    });
    expect(
      await readFile(path.join(root, "skills", entry.id, "SKILL.md"), "utf8"),
    ).toContain("BACKEND_ONLY_RUN_ACTION");
    await expect(
      disableNativeConnector(root, entry.id, {}, [entry]),
    ).resolves.toMatchObject({ id: entry.id, enabled: false });
  });

  it("reads legacy People Data Labs state and lazily migrates it on write", async () => {
    const root = createRoot();
    const statePath = path.join(root, "connectors", "native-integrations.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        integrations: {
          people_data_labs: {
            enabled: true,
            enabledAt: 123,
            updatedAt: 123,
            source: "store",
          },
        },
      }),
    );
    const entry = backendEntry("peopledatalabs", "People Data Labs");

    expect(await isNativeConnectorEnabled(root, "people_data_labs")).toBe(true);
    expect(await isNativeConnectorEnabled(root, "peopledatalabs")).toBe(true);
    expect(
      (await listNativeConnectors(root, {}, [entry])).find(
        (candidate) => candidate.id === "peopledatalabs",
      ),
    ).toMatchObject({ enabled: true, enabledAt: 123 });

    await enableNativeConnector(root, "people_data_labs", "store", {}, [entry]);
    const migrated = JSON.parse(await readFile(statePath, "utf8")) as {
      integrations: Record<string, unknown>;
    };
    expect(migrated.integrations).toHaveProperty("peopledatalabs");
    expect(migrated.integrations).not.toHaveProperty("people_data_labs");
  });

  it("preserves recovered catalog actions for planning only", () => {
    const outlook = buildNativeConnectorCatalog().find(
      (entry) => entry.id === "outlook",
    )!;
    expect(getNativeConnectorCatalogActions(outlook).length).toBe(282);
    expect(getNativeConnectorTools(outlook)).toEqual([]);
  });
});
