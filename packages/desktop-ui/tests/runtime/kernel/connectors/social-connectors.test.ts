import { describe, expect, it } from "vitest";

import {
  getSocialConnectorActions,
  getSocialConnectorAdapter,
  getSocialConnectorScopeStatus,
  isSocialConnectorId,
  listSocialConnectorAdapters,
  SOCIAL_CONNECTOR_IDS,
} from "@stella/runtime/kernel/connectors/social-connectors";

const IN_SCOPE_IDS = [
  "twitter",
  "instagram",
  "youtube",
  "reddit",
  "facebook",
  "metaads",
  "linkedin",
  "2chat",
];

describe("social connector adapter registry", () => {
  it("covers exactly the in-scope social providers and excludes WhatsApp", () => {
    expect([...SOCIAL_CONNECTOR_IDS].sort()).toEqual([...IN_SCOPE_IDS].sort());
    expect(isSocialConnectorId("whatsapp")).toBe(false);
    expect(SOCIAL_CONNECTOR_IDS).not.toContain("whatsapp");
  });

  it("keeps API-key 2Chat metadata code-ready but on Composio fallback", () => {
    expect(
      getSocialConnectorActions("2chat").map((action) => action.name),
    ).toEqual(["_2CHAT_LIST_CONTACTS", "_2CHAT_CREATE_CONTACT"]);
    expect(getSocialConnectorScopeStatus("2chat")?.executionRoute).toBe(
      "composio-fallback",
    );
    expect(getSocialConnectorScopeStatus("2chat")?.hasProviderApp).toBe(false);
  });

  it("preserves canonical catalog ids", () => {
    for (const id of IN_SCOPE_IDS) {
      expect(isSocialConnectorId(id)).toBe(true);
      expect(getSocialConnectorAdapter(id)?.id).toBe(id);
    }
    // Case-insensitive lookups still resolve to the canonical lowercase id.
    expect(getSocialConnectorAdapter("Twitter")?.id).toBe("twitter");
  });

  it("routes Facebook, Instagram, and Meta Ads through the shared Meta grant", () => {
    for (const id of ["facebook", "instagram", "metaads"]) {
      const adapter = getSocialConnectorAdapter(id);
      expect(adapter?.providerConfigId).toBe("meta");
      expect(adapter?.sharedGrant).toEqual({ id: "meta", name: "Meta" });
    }
  });

  it("uses dedicated provider configs for the non-Meta connectors", () => {
    expect(getSocialConnectorAdapter("twitter")?.providerConfigId).toBe(
      "twitter",
    );
    expect(getSocialConnectorAdapter("youtube")?.providerConfigId).toBe(
      "youtube",
    );
    expect(getSocialConnectorAdapter("reddit")?.providerConfigId).toBe(
      "reddit",
    );
    expect(getSocialConnectorAdapter("linkedin")?.providerConfigId).toBe(
      "linkedin",
    );
    expect(getSocialConnectorAdapter("twitter")?.sharedGrant).toBeUndefined();
  });

  it("ships at least one representative safe read and one write per connector", () => {
    for (const adapter of listSocialConnectorAdapters()) {
      const reads = adapter.actions.filter((a) => a.access === "read");
      const writes = adapter.actions.filter((a) => a.access === "write");
      expect(reads.length).toBeGreaterThan(0);
      expect(writes.length).toBeGreaterThan(0);
      // Safe reads must be GETs; writes must never be GET.
      for (const read of reads) expect(read.method).toBe("GET");
      for (const write of writes) expect(write.method).not.toBe("GET");
      // Every action declares at least one required scope.
      for (const action of adapter.actions) {
        expect(action.requiredScopes.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("social connector scope-aware status", () => {
  it("reports read and write readiness independently from granted scopes", () => {
    const readOnly = getSocialConnectorScopeStatus("twitter", {
      grantedScopes: ["tweet.read", "users.read"],
    });
    expect(readOnly?.readReady).toBe(true);
    expect(readOnly?.writeReady).toBe(false);
    expect(readOnly?.missingWriteScopes).toContain("tweet.write");

    const full = getSocialConnectorScopeStatus("twitter", {
      grantedScopes: ["tweet.read", "tweet.write", "users.read"],
    });
    expect(full?.readReady).toBe(true);
    expect(full?.writeReady).toBe(true);
    expect(full?.missingWriteScopes).toEqual([]);
  });

  it("computes per-action availability against the granted scope set", () => {
    const status = getSocialConnectorScopeStatus("reddit", {
      grantedScopes: ["identity", "read"],
    });
    const byName = new Map(status?.actions.map((a) => [a.name, a]));
    expect(byName.get("REDDIT_GET_ME_PREFS")?.available).toBe(true);
    expect(byName.get("REDDIT_CREATE_REDDIT_POST")?.available).toBe(false);
    expect(byName.get("REDDIT_CREATE_REDDIT_POST")?.missingScopes).toEqual([
      "submit",
    ]);
  });

  it("threads the shared Meta grant scopes through each Meta connector", () => {
    // A single Meta authorization carries scopes for all three connectors.
    const metaScopes = [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "instagram_basic",
      "instagram_content_publish",
      "ads_read",
      "ads_management",
    ];
    for (const id of ["facebook", "instagram", "metaads"]) {
      const status = getSocialConnectorScopeStatus(id, {
        grantedScopes: metaScopes,
      });
      expect(status?.sharedGrant).toEqual({ id: "meta", name: "Meta" });
      expect(status?.readReady).toBe(true);
      expect(status?.writeReady).toBe(true);
    }

    // Read-only Meta grant leaves writes gated for every connector.
    const readOnlyMeta = [
      "pages_show_list",
      "pages_read_engagement",
      "instagram_basic",
      "ads_read",
    ];
    expect(
      getSocialConnectorScopeStatus("instagram", {
        grantedScopes: readOnlyMeta,
      })?.writeReady,
    ).toBe(false);
    expect(
      getSocialConnectorScopeStatus("metaads", { grantedScopes: readOnlyMeta })
        ?.writeReady,
    ).toBe(false);
  });

  it("keeps every connector on the preserved Composio fallback route until the core enables native execution", () => {
    for (const id of IN_SCOPE_IDS) {
      const status = getSocialConnectorScopeStatus(id, { grantedScopes: [] });
      expect(status?.executionRoute).toBe("composio-fallback");
    }
    // The backend rollout is authoritative; this adapter cannot enable a
    // competing runtime-local route.
  });

  it("treats an absent provider app and empty grant as not-ready without throwing", () => {
    const status = getSocialConnectorScopeStatus("linkedin", {
      grantedScopes: [],
      config: null,
    });
    expect(status?.hasProviderApp).toBe(false);
    expect(status?.readReady).toBe(false);
    expect(status?.writeReady).toBe(false);
    expect(status?.missingReadScopes).toEqual(["openid", "profile"]);
  });

  it("returns undefined for unknown or excluded connectors", () => {
    expect(getSocialConnectorScopeStatus("whatsapp")).toBeUndefined();
    expect(getSocialConnectorScopeStatus("notion")).toBeUndefined();
    expect(getSocialConnectorActions("whatsapp")).toEqual([]);
  });
});
