import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  buildConnectorAdapterRequest,
  CONNECTOR_ADAPTER_IDS,
  getConnectorAdapter,
  getConnectorAdapterAction,
  listConnectorAdapters,
} from "@stella/runtime/kernel/connectors/adapters/registry";
import {
  callNativeConnector,
  type NativeConnectorCallArgs,
} from "@stella/runtime/kernel/connectors/connect-service";
import {
  enableNativeConnector,
  getNativeConnectorCatalogActions,
  getNativeConnectorTools,
  type NativeConnectorCatalogEntry,
} from "@stella/runtime/kernel/connectors/native-integrations";
import {
  setConnectorTokenStoreBroker,
  type ConnectorTokenPayload,
} from "@stella/runtime/kernel/connectors/oauth";

const EXPECTED_IDS = [
  "hubspot",
  "gong",
  "ashby",
  "pipedrive",
  "salesforce",
  "apollo",
  "attio",
  "21risk",
];

const roots: string[] = [];
const createRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-crm-adapters-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  vi.restoreAllMocks();
  setConnectorTokenStoreBroker(null);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CRM/recruiting/sales adapter registry", () => {
  it("registers exactly the eight in-scope connectors with unchanged ids", () => {
    expect([...CONNECTOR_ADAPTER_IDS].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("declares valid, representative read and write actions per adapter", () => {
    const readOnlyProviders = new Set(["21risk"]);
    for (const adapter of listConnectorAdapters()) {
      expect(adapter.actions.length).toBeGreaterThan(0);
      expect(["oauth", "api_key"]).toContain(adapter.auth);
      expect(adapter.baseUrl.startsWith("https://")).toBe(true);

      const names = adapter.actions.map((action) => action.name);
      expect(new Set(names).size).toBe(names.length);

      const kinds = new Set(adapter.actions.map((action) => action.kind));
      expect(kinds.has("read")).toBe(true);
      if (!readOnlyProviders.has(adapter.id)) {
        expect(kinds.has("write")).toBe(true);
      }

      for (const action of adapter.actions) {
        expect(action.name).toMatch(/^[A-Z][A-Z0-9_]*$/u);
        expect(typeof action.title).toBe("string");
        expect(action.inputSchema).toMatchObject({ type: "object" });
      }
    }
  });

  it("maps actions to a single official-API request and encodes path params", () => {
    expect(
      buildConnectorAdapterRequest("hubspot", "HUBSPOT_READ_CONTACT", {
        contactId: "a/b 1",
      }),
    ).toEqual({ path: "/crm/v3/objects/contacts/a%2Fb%201", method: "GET" });

    expect(
      buildConnectorAdapterRequest("salesforce", "SALESFORCE_RUN_SOQL_QUERY", {
        q: "SELECT Id FROM Lead",
      }),
    ).toEqual({
      method: "GET",
      path: "/services/data/v60.0/query",
      query: { q: "SELECT Id FROM Lead" },
    });

    expect(
      buildConnectorAdapterRequest("attio", "ATTIO_CREATE_RECORD", {
        object: "people",
        values: { name: "Ada" },
      }),
    ).toEqual({
      method: "POST",
      path: "/v2/objects/people/records",
      body: { data: { values: { name: "Ada" } } },
    });

    expect(
      buildConnectorAdapterRequest("apollo", "APOLLO_PEOPLE_SEARCH", {
        q_keywords: "cto",
        person_titles: ["Chief Technology Officer", "CTO"],
      }),
    ).toEqual({
      method: "POST",
      path: "/api/v1/mixed_people/api_search?q_keywords=cto&person_titles%5B%5D=Chief+Technology+Officer&person_titles%5B%5D=CTO",
    });

    expect(
      buildConnectorAdapterRequest("apollo", "APOLLO_ORGANIZATION_SEARCH", {
        q_organization_name: "Acme",
        q_organization_domains_list: ["acme.example"],
      }),
    ).toEqual({
      method: "POST",
      path: "/api/v1/mixed_companies/search?q_organization_name=Acme&q_organization_domains_list%5B%5D=acme.example",
    });

    expect(
      buildConnectorAdapterRequest("apollo", "APOLLO_PEOPLE_ENRICH", {
        email: "ada+lead@example.com",
      }),
    ).toEqual({
      method: "POST",
      path: "/api/v1/people/match?email=ada%2Blead%40example.com",
    });

    expect(
      buildConnectorAdapterRequest("apollo", "APOLLO_CREATE_CONTACT", {
        first_name: "Ada",
        last_name: "Lovelace",
        account_id: "account-1",
      }),
    ).toEqual({
      method: "POST",
      path: "/api/v1/contacts",
      body: {
        last_name: "Lovelace",
        account_id: "account-1",
        first_name: "Ada",
      },
    });

    expect(
      buildConnectorAdapterRequest("apollo", "APOLLO_CREATE_TASK", {
        user_id: "user-1",
        contact_id: "contact-1",
        type: "call",
        status: "scheduled",
        due_at: "2026-08-15T10:00:00Z",
        priority: "high",
      }),
    ).toEqual({
      method: "POST",
      path: "/api/v1/tasks",
      body: {
        type: "call",
        due_at: "2026-08-15T10:00:00Z",
        status: "scheduled",
        user_id: "user-1",
        priority: "high",
        contact_id: "contact-1",
      },
    });

    expect(
      buildConnectorAdapterRequest("21risk", "TWENTY_ONE_RISK_GET_REPORTS", {
        top: 5,
        filter: "Report Status eq 'published'",
      }),
    ).toEqual({
      method: "GET",
      path: "/odata/v5/reports",
      query: { $top: 5, $filter: "Report Status eq 'published'" },
    });
  });

  it("throws a clear error when required arguments are missing", () => {
    expect(() =>
      buildConnectorAdapterRequest("hubspot", "HUBSPOT_CREATE_CONTACT", {}),
    ).toThrow(/properties/);
    expect(() =>
      buildConnectorAdapterRequest("ashby", "ASHBY_CREATE_NOTE", {
        candidateId: "c1",
      }),
    ).toThrow(/note/);
    expect(() =>
      buildConnectorAdapterRequest("apollo", "APOLLO_CREATE_TASK", {
        priority: "high",
        type: "email",
        contact_ids: ["legacy-contact"],
      }),
    ).toThrow(/unsupported.*type|user_id/);
  });

  it("rejects unknown adapters and actions without executing", () => {
    expect(getConnectorAdapter("notreal")).toBeUndefined();
    expect(getConnectorAdapterAction("hubspot", "NOPE")).toBeUndefined();
    expect(() => buildConnectorAdapterRequest("hubspot", "NOPE", {})).toThrow(
      /does not expose/,
    );
  });

  it("records the correct auth model and custom header for api-key providers", () => {
    expect(getConnectorAdapter("hubspot")?.auth).toBe("oauth");
    expect(getConnectorAdapter("ashby")?.apiAuthScheme).toBe("basic");
    expect(getConnectorAdapter("apollo")?.authHeaderName).toBe("X-Api-Key");
  });
});

const productionReadyEntry = (
  id: string,
  name: string,
): NativeConnectorCatalogEntry => ({
  id,
  name,
  category: "crm",
  auth: ["OAUTH2"],
  catalogToolCount: 6,
  availability: "ready",
  provider: "oauth-catalog",
  localExecution: "production-ready",
  description: `${name} first-party connector.`,
  connectable: true,
});

// The HubSpot OAuth config is env-backed; a client id is required before its
// native config (and thus its tool surface / execution) resolves.
let prevHubspotClientId: string | undefined;
beforeAll(() => {
  prevHubspotClientId = process.env.STELLA_NATIVE_OAUTH_HUBSPOT_CLIENT_ID;
  process.env.STELLA_NATIVE_OAUTH_HUBSPOT_CLIENT_ID = "test-client-id";
});
afterAll(() => {
  if (prevHubspotClientId === undefined) {
    delete process.env.STELLA_NATIVE_OAUTH_HUBSPOT_CLIENT_ID;
  } else {
    process.env.STELLA_NATIVE_OAUTH_HUBSPOT_CLIENT_ID = prevHubspotClientId;
  }
});

describe("adapter catalog + tool surface", () => {
  it("exposes adapter actions as tools and catalog actions once production-ready", () => {
    const entry = productionReadyEntry("hubspot", "HubSpot");
    const toolNames = getNativeConnectorTools(entry).map((tool) => tool.name);
    expect(toolNames).toContain("HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA");
    expect(toolNames).toContain("HUBSPOT_CREATE_DEAL");
    // The generic REST escape hatch remains available alongside named actions.
    expect(toolNames).toContain("HUBSPOT_API_REQUEST");

    const catalogNames = getNativeConnectorCatalogActions(entry).map(
      (action) => action.name,
    );
    expect(catalogNames).toEqual(
      getConnectorAdapter("hubspot")?.actions.map((action) => action.name),
    );
  });
});

describe("runtime adapter execution is disabled", () => {
  it("fails closed without issuing a local request", async () => {
    const stellaAppDir = createRoot();
    const entry = productionReadyEntry("hubspot", "HubSpot");

    const tokens = new Map<string, ConnectorTokenPayload>();
    setConnectorTokenStoreBroker({
      load: async (key) => tokens.get(key) ?? null,
      save: async (key, payload) => {
        tokens.set(key, payload);
      },
      delete: async (keys) => {
        for (const key of keys) tokens.delete(key);
      },
    });
    tokens.set("native-oauth:hubspot", {
      accessToken: "test-access-token",
      resourceUrl: "https://api.hubapi.com",
    });

    await enableNativeConnector(stellaAppDir, "hubspot", "cli", {}, [entry]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "42", properties: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const args: NativeConnectorCallArgs = { body: { contactId: "42" } };
    await expect(
      callNativeConnector(
        { stellaAppDir },
        "hubspot",
        "HUBSPOT_READ_CONTACT",
        args,
        [entry],
      ),
    ).rejects.toThrow(/does not have a native tool dispatcher/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
