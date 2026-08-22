import { describe, expect, it } from "vitest";

import {
  FIRST_PARTY_CONNECTOR_ADAPTERS,
  NATIVE_CAPABILITY_ALIASES,
  firstPartyConnectorCatalogOverlay,
  firstPartyConnectorCredentialRequirement,
  firstPartyConnectorStatus,
  getFirstPartyConnectorAdapter,
  getNativeCapabilityAlias,
  isFirstPartyLocalExecutionEnabled,
  isNativeCapabilityAlias,
} from "@stella/runtime/kernel/connectors/first-party-connectors";
import {
  buildNativeConnectorCatalog,
  getNativeConnectorCatalogEntry,
  getNativeConnectorTools,
} from "@stella/runtime/kernel/connectors/native-integrations";
import {
  getNativeOAuthProviderConfig,
  isNativeOAuthLocalExecutionProductionReady,
} from "@stella/runtime/kernel/connectors/native-oauth-provider-config";

// Mirrors the backend SAFE_INTEGRATION_ID (data/integrations.ts): stable,
// lowercased, may start with a digit (covers "44api").
const SAFE_INTEGRATION_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
// Composio action-slug shape (allows a leading digit, e.g. 44API_*).
const COMPOSIO_ACTION_SLUG = /^[A-Z0-9][A-Z0-9_]+$/u;

const EXPECTED_IDS = [
  "github",
  "supabase",
  "snowflake",
  "firecrawl",
  "tavily",
  "exa",
  "serpapi",
  "perplexityai",
  "posthog",
  "ably",
  "abuseipdb",
  "abstract",
  "peopledatalabs",
  "44api",
];

describe("first-party connector adapters", () => {
  it("owns exactly the required set with stable, unique ids", () => {
    const ids = FIRST_PARTY_CONNECTOR_ADAPTERS.map((a) => a.id);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id, `${id} must be a stable safe id`).toMatch(SAFE_INTEGRATION_ID);
    }
  });

  it("keeps the id aligned with the lowercased Composio fallback toolkit", () => {
    for (const adapter of FIRST_PARTY_CONNECTOR_ADAPTERS) {
      expect(adapter.composio.toolkit).toBeTruthy();
      expect(adapter.composio.toolkit).toBe(
        adapter.composio.toolkit.toUpperCase(),
      );
      expect(adapter.id).toBe(adapter.composio.toolkit.toLowerCase());
    }
  });

  it("declares a coherent auth model per adapter", () => {
    for (const adapter of FIRST_PARTY_CONNECTOR_ADAPTERS) {
      if (adapter.auth === "oauth") {
        expect(adapter.oauth, `${adapter.id} oauth block`).toBeTruthy();
        expect(adapter.apiKey).toBeUndefined();
        expect(adapter.oauth?.tokenKey).toMatch(/^native-oauth:/u);
        expect(adapter.oauth?.scopes.length ?? 0).toBeGreaterThan(0);
      } else {
        expect(adapter.apiKey, `${adapter.id} apiKey block`).toBeTruthy();
        expect(adapter.oauth).toBeUndefined();
        expect(adapter.apiKey?.tokenKey).toMatch(/^native-apikey:/u);
        expect(adapter.apiKey?.credentialLabel).toBeTruthy();
      }
    }
  });

  it("retains legacy native OAuth metadata for GitHub and Supabase", () => {
    // Legacy runtime metadata retains the registered GitHub and Supabase ids;
    // the server-authoritative shared core remains separately rollout-gated.
    for (const id of ["github", "supabase"]) {
      const adapter = getFirstPartyConnectorAdapter(id)!;
      const config = getNativeOAuthProviderConfig(
        adapter.oauth!.providerConfigId,
      );
      expect(config, `${id} provider config`).toBeTruthy();
      expect(config?.clientId?.trim()).toBeTruthy();
    }
  });

  it("carries representative actions with valid Composio slugs and mutation flags", () => {
    for (const adapter of FIRST_PARTY_CONNECTOR_ADAPTERS) {
      expect(adapter.representativeActions.length).toBeGreaterThan(0);
      for (const action of adapter.representativeActions) {
        expect(action.name).toMatch(COMPOSIO_ACTION_SLUG);
        const expectedPrefix = `${adapter.composio.toolkit}_`;
        expect(action.name.startsWith(expectedPrefix)).toBe(true);
        expect(action.title).toBeTruthy();
        expect(action.description).toBeTruthy();
      }
    }
  });

  it("marks at least one mutating action for state-changing toolkits", () => {
    for (const id of [
      "github",
      "supabase",
      "snowflake",
      "posthog",
      "ably",
      "abuseipdb",
      "44api",
    ]) {
      const adapter = getFirstPartyConnectorAdapter(id)!;
      expect(
        adapter.representativeActions.some((a) => a.mutating === true),
        `${id} should flag a mutating action`,
      ).toBe(true);
    }
  });
});

describe("credential/scope-aware status", () => {
  const github = getFirstPartyConnectorAdapter("github")!;
  const firecrawl = getFirstPartyConnectorAdapter("firecrawl")!;

  it("treats a registered OAuth app without a credential as not-connected", () => {
    expect(firstPartyConnectorStatus(github)).toBe("missing_credential");
  });

  it("becomes ready when the credential covers the required scopes", () => {
    expect(
      firstPartyConnectorStatus(github, {
        hasCredential: true,
        grantedScopes: ["repo", "read:user", "user:email", "gist"],
      }),
    ).toBe("ready");
  });

  it("flags missing scopes when the granted set is insufficient", () => {
    expect(
      firstPartyConnectorStatus(github, {
        hasCredential: true,
        grantedScopes: ["read:user"],
      }),
    ).toBe("missing_scopes");
  });

  it("reports missing_oauth_app when no client app is registered", () => {
    // Snowflake's config is account-url gated, so absent env it has no app.
    const snowflake = getFirstPartyConnectorAdapter("snowflake")!;
    expect(firstPartyConnectorStatus(snowflake)).toBe("missing_oauth_app");
    // Explicit override path is honored too.
    expect(firstPartyConnectorStatus(github, { hasOAuthApp: false })).toBe(
      "missing_oauth_app",
    );
  });

  it("drives API-key adapters off a stored credential", () => {
    expect(firstPartyConnectorStatus(firecrawl)).toBe("missing_credential");
    expect(firstPartyConnectorStatus(firecrawl, { hasCredential: true })).toBe(
      "ready",
    );
  });

  it("exposes the credential requirement for connect dialogs", () => {
    expect(firstPartyConnectorCredentialRequirement(github)).toEqual({
      kind: "oauth",
      scopes: ["repo", "read:user", "user:email"],
    });
    expect(firstPartyConnectorCredentialRequirement(firecrawl)).toMatchObject({
      kind: "api_key",
      label: "Firecrawl API key",
    });
  });
});

describe("execution boundaries (never dual-execute)", () => {
  it("keeps native local execution disabled for every first-party id", () => {
    for (const adapter of FIRST_PARTY_CONNECTOR_ADAPTERS) {
      expect(isFirstPartyLocalExecutionEnabled(adapter.id)).toBe(false);
    }
  });

  it("does not flip the OAuth-catalog production-ready gate for OAuth adapters", () => {
    for (const id of ["github", "supabase", "snowflake"]) {
      expect(isNativeOAuthLocalExecutionProductionReady(id)).toBe(false);
    }
  });
});

describe("Composio fallback catalog overlay", () => {
  const overlay = firstPartyConnectorCatalogOverlay();

  it("emits a backend-composio entry per adapter with a matching toolkit", () => {
    expect(overlay.map((e) => e.id).sort()).toEqual([...EXPECTED_IDS].sort());
    for (const entry of overlay) {
      const adapter = getFirstPartyConnectorAdapter(entry.id)!;
      expect(entry.provider).toBe("backend-composio");
      expect(entry.backendConnector).toEqual({
        type: "composio",
        toolkit: adapter.composio.toolkit,
      });
      expect(entry.connectable).toBe(true);
      expect(entry.actions?.length).toBe(adapter.representativeActions.length);
    }
  });

  it("resolves the overlay through the shared catalog builder as a RUN_ACTION tool", () => {
    const catalog = buildNativeConnectorCatalog(overlay);
    const github = getNativeConnectorCatalogEntry("github", catalog)!;
    expect(github.provider).toBe("backend-composio");
    expect(getNativeConnectorTools(github)).toEqual([
      expect.objectContaining({ name: "GITHUB_RUN_ACTION" }),
    ]);
  });

  it("lets an authoritative server entry win an id collision with the overlay", () => {
    // The overlay is a fallback, not an override: a real Store catalog entry
    // with the same id must still take precedence when both are present.
    const authoritative = {
      ...overlay.find((e) => e.id === "exa")!,
      description: "Authoritative Store entry.",
      catalogToolCount: 99,
    };
    const catalog = buildNativeConnectorCatalog([authoritative]);
    expect(
      getNativeConnectorCatalogEntry("exa", catalog)?.catalogToolCount,
    ).toBe(99);
  });
});

describe("Composio-owned tools mapped to native capabilities", () => {
  it("aliases Search / Browser / Codeinterpreter to native tools without wrapping them", () => {
    const expected: Record<string, { capability: string; tool: string }> = {
      composio_search: { capability: "web_search", tool: "web" },
      browser_tool: { capability: "browser", tool: "stella-browser" },
      codeinterpreter: { capability: "shell_sandbox", tool: "exec_command" },
    };
    expect(NATIVE_CAPABILITY_ALIASES.map((a) => a.id).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const alias of NATIVE_CAPABILITY_ALIASES) {
      expect(alias.status).toBe("aliased_deprecated");
      expect(alias.nativeCapability).toBe(expected[alias.id].capability);
      expect(alias.nativeToolId).toBe(expected[alias.id].tool);
      expect(alias.rationale).toBeTruthy();
      // These are NOT registered as third-party connectors.
      expect(getFirstPartyConnectorAdapter(alias.id)).toBeUndefined();
      expect(isNativeCapabilityAlias(alias.id)).toBe(true);
    }
  });

  it("resolves aliases case-insensitively", () => {
    expect(getNativeCapabilityAlias("COMPOSIO_SEARCH")?.nativeToolId).toBe(
      "web",
    );
    expect(getNativeCapabilityAlias("unknown")).toBeUndefined();
  });
});

describe("backend-publish action contract", () => {
  it("preserves exact Composio action names for digit-leading toolkits", () => {
    for (const adapter of FIRST_PARTY_CONNECTOR_ADAPTERS) {
      for (const action of adapter.representativeActions) {
        expect(action.name).toMatch(COMPOSIO_ACTION_SLUG);
      }
    }
    const taxToolkit = getFirstPartyConnectorAdapter("44api")!;
    expect(taxToolkit.composio.toolkit).toBe("44API");
    expect(taxToolkit.apiKey).toMatchObject({
      baseUrl: "https://api.44api.dev",
      placement: "header",
      headerName: "X-API-Key",
    });
    expect(
      taxToolkit.representativeActions.every((action) =>
        action.name.startsWith("44API_"),
      ),
    ).toBe(true);
  });
});
