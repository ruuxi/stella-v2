import { describe, expect, it } from "vitest";

import {
  buildMergedConnectorCatalog,
  toBackendComposioEntry,
} from "@stella/runtime/kernel/connectors/catalog-cache";
import {
  buildNativeConnectorCatalog,
  getNativeConnectorCatalogEntry,
  type NativeConnectorCatalogEntry,
} from "@stella/runtime/kernel/connectors/native-integrations";

const composioEntry = (
  id: string,
  name: string,
  overrides: Partial<NativeConnectorCatalogEntry> = {},
): NativeConnectorCatalogEntry => ({
  id,
  name,
  category: "integrations",
  auth: ["OAUTH2"],
  catalogToolCount: 10,
  availability: "ready",
  provider: "backend-composio",
  description: `${name} integration`,
  connectable: true,
  backendConnector: { type: "composio", toolkit: id.toUpperCase() },
  ...overrides,
});

describe("buildNativeConnectorCatalog server-catalog overlay", () => {
  it("keeps bundled entries when the server catalog only carries backend integrations", () => {
    // Regression: a server catalog with only a Composio entry must not
    // evict Gmail — discovery could offer it while the Store/connect
    // paths (which pass the server catalog through) failed to resolve it.
    const catalog = buildNativeConnectorCatalog([
      composioEntry("notion", "Notion"),
    ]);
    const gmail = getNativeConnectorCatalogEntry("gmail", catalog);
    expect(gmail).toBeDefined();
    expect(gmail?.provider).toBe("google-workspace");
    expect(gmail?.connectable).toBe(true);
    expect(getNativeConnectorCatalogEntry("notion", catalog)?.provider).toBe(
      "backend-composio",
    );
  });

  it("keeps production-ready local executors ahead of stale server entries", () => {
    const override = composioEntry("gmail", "Gmail (backend)");
    const catalog = buildNativeConnectorCatalog([override]);
    const gmail = getNativeConnectorCatalogEntry("gmail", catalog);
    expect(gmail?.provider).toBe("google-workspace");
    expect(gmail?.name).toBe("Gmail");
    // No duplicate ids after the overlay.
    expect(catalog.filter((entry) => entry.id === "gmail")).toHaveLength(1);
  });

  it("still lets server execution replace incomplete bundled metadata", () => {
    const override = composioEntry("notion", "Notion (backend)");
    const notion = getNativeConnectorCatalogEntry(
      "notion",
      buildNativeConnectorCatalog([override]),
    );
    expect(notion).toMatchObject({
      provider: "backend-composio",
      name: "Notion (backend)",
    });
  });

  it("resolves the legacy People Data Labs id to the authoritative exact id", () => {
    const legacy = composioEntry("people_data_labs", "People Data Labs", {
      backendConnector: { type: "composio", toolkit: "PEOPLEDATALABS" },
    });
    const catalog = buildNativeConnectorCatalog([legacy]);
    expect(
      getNativeConnectorCatalogEntry("people_data_labs", catalog),
    ).toMatchObject({
      id: "peopledatalabs",
      provider: "backend-composio",
    });
    expect(
      getNativeConnectorCatalogEntry("peopledatalabs", catalog),
    ).toMatchObject({ id: "peopledatalabs" });
    expect(catalog.some((entry) => entry.id === "people_data_labs")).toBe(
      false,
    );
  });

  it("buildMergedConnectorCatalog matches the overlay semantics", () => {
    const server = [composioEntry("asana", "Asana")];
    const merged = buildMergedConnectorCatalog(server);
    const overlaid = buildNativeConnectorCatalog(server);
    expect(merged.map((entry) => entry.id).sort()).toEqual(
      overlaid.map((entry) => entry.id).sort(),
    );
    expect(getNativeConnectorCatalogEntry("gmail", merged)).toBeDefined();
  });

  it("parses only explicit leading-digit toolkit and 44API action exceptions", () => {
    expect(
      toBackendComposioEntry({
        id: "21risk",
        name: "21risk",
        description: "21risk integration",
        connector: { type: "composio", toolkit: "_21risk" },
      }),
    ).toMatchObject({
      id: "21risk",
      backendConnector: { toolkit: "_21RISK" },
    });
    expect(
      toBackendComposioEntry({
        id: "21risk",
        name: "21risk",
        description: "21risk integration",
        connector: { type: "composio", toolkit: "21risk" },
      }),
    ).toBeNull();

    const action = {
      name: "44API_GET_RECORDS",
      inputSchema: { type: "object" },
    };
    expect(
      toBackendComposioEntry({
        id: "44api",
        name: "44API",
        description: "44API integration",
        connector: { type: "composio", toolkit: "44api" },
        actions: [action],
      })?.actions,
    ).toEqual([expect.objectContaining({ name: action.name })]);
    expect(
      toBackendComposioEntry({
        id: "outlook",
        name: "Outlook",
        description: "Outlook integration",
        connector: { type: "composio", toolkit: "outlook" },
        actions: [action],
      })?.actions,
    ).toBeUndefined();
  });
});
