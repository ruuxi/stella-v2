import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FIRST_PARTY_PRODUCTIVITY_ACTIONS,
  FIRST_PARTY_PRODUCTIVITY_CONNECTOR_IDS,
  firstPartyProductivityConnectorExecutionOwner,
  firstPartyProductivityConnectorProdEnv,
  firstPartyProductivityConnectorSecretProvider,
  getFirstPartyProductivityConnector,
  isFirstPartyProductivityConnectorNativeReady,
  resolveFirstPartyProductivityConnectorReadiness,
} from "@stella/runtime/kernel/connectors/first-party-productivity-connectors";
import {
  buildNativeConnectorCatalog,
  disableNativeConnector,
  getNativeConnectorTools,
  type NativeConnectorCatalogEntry,
} from "@stella/runtime/kernel/connectors/native-integrations";
import { getNativeOAuthProviderConfig } from "@stella/runtime/kernel/connectors/native-oauth-provider-config";

const EXPECTED_IDS = [
  "notion",
  "slack",
  "airtable",
  "asana",
  "linear",
  "jira",
  "clickup",
  "slackbot",
  "monday",
  "canvas",
  "7shifts",
] as const;

const NON_CATALOG_OAUTH_IDS = new Set(["slack", "slackbot", "7shifts"]);
const OAUTH_CATALOG_IDS = EXPECTED_IDS.filter(
  (id) => !NON_CATALOG_OAUTH_IDS.has(id),
);

const roots: string[] = [];
const createRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-first-party-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("first-party productivity connector registry", () => {
  it("owns exactly the in-scope connectors with stable snake-case ids", () => {
    expect(new Set(FIRST_PARTY_PRODUCTIVITY_CONNECTOR_IDS)).toEqual(
      new Set(EXPECTED_IDS),
    );
    for (const id of FIRST_PARTY_PRODUCTIVITY_CONNECTOR_IDS) {
      expect(id).toMatch(/^[a-z0-9_]+$/u);
      const entry = getFirstPartyProductivityConnector(id);
      expect(entry?.id).toBe(id);
      expect(entry?.displayName).toBeTruthy();
      expect(entry?.officialApi).toBeTruthy();
      expect(entry?.composioToolkit).toMatch(/^[A-Z0-9_]+$/u);
    }
    // Ids are unique.
    expect(FIRST_PARTY_PRODUCTIVITY_CONNECTOR_IDS.length).toBe(
      new Set(FIRST_PARTY_PRODUCTIVITY_CONNECTOR_IDS).size,
    );
  });

  it("resolves connectors case-insensitively and ignores unknown ids", () => {
    expect(getFirstPartyProductivityConnector("NOTION")?.id).toBe("notion");
    expect(getFirstPartyProductivityConnector(" Linear ")?.id).toBe("linear");
    expect(getFirstPartyProductivityConnector("dropbox")).toBeUndefined();
  });

  it("publishes one canonical read and write per productivity connector", () => {
    expect(Object.keys(FIRST_PARTY_PRODUCTIVITY_ACTIONS).sort()).toEqual(
      [...EXPECTED_IDS].sort(),
    );
    for (const id of EXPECTED_IDS) {
      const actions = FIRST_PARTY_PRODUCTIVITY_ACTIONS[id];
      expect(actions).toHaveLength(2);
      expect(new Set(actions.map((action) => action.operation))).toEqual(
        new Set(["read", "write"]),
      );
      for (const action of actions) {
        expect(action.name).toMatch(/^[A-Z0-9_]+$/u);
      }
    }
  });

  it("keeps Slack and Slackbot backend-owned and sharing one app/grant", () => {
    const slack = getFirstPartyProductivityConnector("slack")!;
    const slackbot = getFirstPartyProductivityConnector("slackbot")!;
    expect(slack.providerConfigId).toBeUndefined();
    expect(slackbot.providerConfigId).toBeUndefined();
    expect(slackbot.sharesOAuthAppWith).toBe("slack");
    expect(slack.authKind).toBe("oauth2");
    expect(slackbot.authKind).toBe("oauth2_bot");
    // No native config => prod env keys are not exposed for these two.
    expect(firstPartyProductivityConnectorProdEnv("slack")).toBeUndefined();
    expect(firstPartyProductivityConnectorProdEnv("slackbot")).toBeUndefined();
    // Composio owns them unconditionally.
    for (const id of ["slack", "slackbot"]) {
      const readiness = resolveFirstPartyProductivityConnectorReadiness(id)!;
      expect(readiness.configResolved).toBe(false);
      expect(readiness.nativeReady).toBe(false);
      expect(readiness.executionOwner).toBe("composio");
    }
  });

  it("keeps the API-key-only 7shifts adapter under Composio ownership", () => {
    const entry = getFirstPartyProductivityConnector("7shifts")!;
    expect(entry.authKind).toBe("api_key");
    expect(entry.providerConfigId).toBeUndefined();
    expect(
      resolveFirstPartyProductivityConnectorReadiness("7shifts"),
    ).toMatchObject({
      configResolved: false,
      nativeReady: false,
      executionOwner: "composio",
    });
  });

  it("maps every OAuth-catalog connector to a resolvable provider config id", () => {
    for (const id of OAUTH_CATALOG_IDS) {
      const entry = getFirstPartyProductivityConnector(id)!;
      expect(entry.providerConfigId).toBeTruthy();
    }
  });

  it("keeps confidential Airtable and Linear exchanges on the backend", () => {
    for (const id of ["airtable", "linear"]) {
      expect(getNativeOAuthProviderConfig(id)?.tokenExchange).toEqual({
        type: "backend",
        provider: id,
      });
    }
  });

  it("routes ALL in-scope connectors through the Composio fallback today (no dual execution)", () => {
    // Nothing is allowlisted for local execution yet, so every connector's
    // single execution owner is Composio. This is the guard that keeps writes
    // from being dispatched down two paths at once.
    for (const id of EXPECTED_IDS) {
      expect(isFirstPartyProductivityConnectorNativeReady(id)).toBe(false);
      expect(firstPartyProductivityConnectorExecutionOwner(id)).toBe(
        "composio",
      );
    }
  });

  it("does not let a configured OAuth app alone flip execution to native", () => {
    // Notion's config becomes "config-ready" once the backend can exchange its
    // token, but execution must NOT move to native until the id is also
    // deliberately allowlisted for local execution.
    const secretProvider =
      firstPartyProductivityConnectorSecretProvider("notion")!;
    const withBackend = resolveFirstPartyProductivityConnectorReadiness(
      "notion",
      { configuredBackendProviders: new Set([secretProvider]) },
    )!;
    expect(withBackend.configReady).toBe(true);
    expect(withBackend.localExecutionEnabled).toBe(false);
    expect(withBackend.nativeReady).toBe(false);
    expect(withBackend.executionOwner).toBe("composio");
  });

  it("gates env-backed connectors until their client id is provisioned", () => {
    // ClickUp and Canvas only resolve a native config once their provisioned
    // client id (and, for Canvas, install url) is present in the environment.
    for (const id of ["clickup", "canvas"]) {
      const readiness = resolveFirstPartyProductivityConnectorReadiness(id)!;
      expect(readiness.configResolved).toBe(false);
      expect(readiness.executionOwner).toBe("composio");
    }
  });

  it("derives architecture-consistent production env var names", () => {
    expect(firstPartyProductivityConnectorProdEnv("notion")).toEqual({
      clientIdEnv: "STELLA_NATIVE_OAUTH_NOTION_CLIENT_ID",
      clientSecretEnv: "STELLA_NATIVE_OAUTH_NOTION_CLIENT_SECRET",
      backendReadyEnv: "STELLA_NATIVE_OAUTH_NOTION_BACKEND_READY",
      externalCallbackReadyEnv:
        "STELLA_NATIVE_OAUTH_NOTION_EXTERNAL_CALLBACK_READY",
    });
    // Jira rides the shared Atlassian app, so its secret/readiness keys are
    // namespaced to the atlassian provider while its public client id keeps the
    // jira id.
    expect(firstPartyProductivityConnectorSecretProvider("jira")).toBe(
      "atlassian",
    );
    expect(firstPartyProductivityConnectorProdEnv("jira")).toEqual({
      clientIdEnv: "STELLA_NATIVE_OAUTH_JIRA_CLIENT_ID",
      clientSecretEnv: "STELLA_NATIVE_OAUTH_ATLASSIAN_CLIENT_SECRET",
      backendReadyEnv: "STELLA_NATIVE_OAUTH_ATLASSIAN_BACKEND_READY",
      externalCallbackReadyEnv:
        "STELLA_NATIVE_OAUTH_ATLASSIAN_EXTERNAL_CALLBACK_READY",
    });
  });

  it("exposes no native execution tools for the OAuth-catalog connectors", () => {
    const catalog = buildNativeConnectorCatalog();
    for (const id of OAUTH_CATALOG_IDS) {
      const entry = catalog.find((candidate) => candidate.id === id);
      if (!entry) continue; // canvas/clickup env-gated catalog membership varies
      expect(entry).toMatchObject({ localExecution: "incomplete" });
      expect(getNativeConnectorTools(entry)).toEqual([]);
    }
  });

  it("supports an idempotent disconnect for a backend-owned connector", async () => {
    const root = createRoot();
    const entry: NativeConnectorCatalogEntry = {
      id: "slack",
      name: "Slack",
      category: "communication",
      auth: ["OAUTH2"],
      catalogToolCount: 10,
      availability: "ready",
      provider: "backend-composio",
      description: "Slack Store integration.",
      connectable: true,
      backendConnector: { type: "composio", toolkit: "SLACK" },
    };
    await expect(
      disableNativeConnector(root, "slack", {}, [entry]),
    ).resolves.toMatchObject({ id: "slack", enabled: false });
    // Disabling again is safe.
    await expect(
      disableNativeConnector(root, "slack", {}, [entry]),
    ).resolves.toMatchObject({ id: "slack", enabled: false });
  });
});
