// Golden equivalence for the catalog summary sidecar: listing and matching
// connectors read `oauth-provider-catalog.index.json` instead of the full
// ~12MB catalog, so everything derived from it must equal what the full
// catalog produces, and actions must still resolve from the full catalog.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  oauthProviderCatalogIndexPaths,
  renderOAuthProviderCatalogIndex,
} from "@stella/runtime/kernel/connectors/generate-oauth-provider-catalog-index";
import {
  buildConnectorKeywordIndex,
  matchConnectorsInMessage,
} from "@stella/runtime/kernel/connectors/keyword-index";
import {
  buildNativeConnectorCatalog,
  getNativeConnectorCatalogActions,
} from "@stella/runtime/kernel/connectors/native-integrations";
import {
  getOAuthCatalogProviderTools,
  getOAuthProviderCatalog,
  getOAuthProviderSummaries,
} from "@stella/runtime/kernel/connectors/oauth-provider-catalog";
import {
  buildConnectedReminderText,
  buildOfferReminderText,
} from "@stella/runtime/extensions/stella-runtime/hooks/connector-availability-reminder.hook";

const fullCatalog = getOAuthProviderCatalog();
const fullById = new Map(fullCatalog.map((entry) => [entry.id, entry]));

describe("OAuth provider catalog summary sidecar", () => {
  it("is the committed projection of the full catalog (run the generator on drift)", () => {
    expect(readFileSync(oauthProviderCatalogIndexPaths.index, "utf-8")).toBe(
      renderOAuthProviderCatalogIndex(),
    );
    expect(getOAuthProviderSummaries()).toEqual(
      fullCatalog.map(({ tools: _tools, ...summary }) => summary),
    );
  });

  it("derives native catalog entries identical to the full catalog's fields", () => {
    const oauthEntries = buildNativeConnectorCatalog().filter(
      (entry) => entry.provider === "oauth-catalog",
    );
    expect(oauthEntries.length).toBeGreaterThan(50);
    for (const entry of oauthEntries) {
      const full = fullById.get(entry.id);
      expect(full, entry.id).toBeDefined();
      expect({
        id: entry.id,
        name: entry.name,
        category: entry.category,
        auth: entry.auth,
        catalogToolCount: entry.catalogToolCount,
        description: entry.description,
        sourceUrl: entry.sourceUrl,
      }).toEqual({
        id: full!.id,
        name: full!.name,
        category: full!.category,
        auth: full!.auth,
        catalogToolCount: full!.catalogToolCount,
        description: full!.description,
        sourceUrl: full!.sourceUrl,
      });
    }
  });

  it("resolves every oauth-catalog entry's actions from the full catalog", () => {
    for (const entry of buildNativeConnectorCatalog()) {
      if (entry.provider !== "oauth-catalog" || entry.oauthConfig) continue;
      expect(getNativeConnectorCatalogActions(entry), entry.id).toEqual(
        (fullById.get(entry.id)?.tools ?? []).map((tool) => ({
          name: tool.name.trim(),
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        })),
      );
    }
    expect(getOAuthCatalogProviderTools("not-a-provider")).toBeUndefined();
  });

  it("builds the same keyword index and reminders as a full-catalog build", () => {
    const catalog = buildNativeConnectorCatalog();
    // Rebuild the same catalog with every field re-read from the full JSON:
    // the index over it must be identical.
    const fromFull = catalog.map((entry) => {
      const full = fullById.get(entry.id);
      return full && entry.provider === "oauth-catalog"
        ? {
            ...entry,
            name: full.name,
            category: full.category,
            description: full.description,
          }
        : entry;
    });
    const index = buildConnectorKeywordIndex(catalog);
    const expected = buildConnectorKeywordIndex(fromFull);
    expect(index).toEqual(expected);
    for (const prompt of [
      "check my email and calendar",
      "update the jira ticket and the pull request",
      "add it to basecamp",
      "play a song",
      "hello there",
    ]) {
      const render = (idx: typeof index) =>
        matchConnectorsInMessage(idx, prompt).map((entry) => [
          buildConnectedReminderText(entry),
          buildOfferReminderText(entry),
        ]);
      expect(render(index)).toEqual(render(expected));
    }
  });
});
