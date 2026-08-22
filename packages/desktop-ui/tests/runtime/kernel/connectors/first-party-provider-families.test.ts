import { describe, expect, it } from "vitest";

import {
  FIRST_PARTY_PROVIDER_FAMILY_STATUS,
  getFirstPartyProviderFamilyStatus,
} from "@stella/runtime/kernel/connectors/first-party-provider-families";
import { AUTHORITATIVE_PAGE_1_2_CONNECTOR_OWNERSHIP } from "@stella/runtime/kernel/connectors/first-party-connector-ownership";

const SAFE_CONNECTOR_ID = /^[a-z0-9][a-z0-9_-]*$/u;
const EXPECTED_IDS = [
  "outlook",
  "microsoft_teams",
  "excel",
  "notion",
  "slack",
  "slackbot",
  "airtable",
  "asana",
  "linear",
  "jira",
  "clickup",
  "monday",
  "canvas",
  "github",
  "supabase",
  "firecrawl",
  "tavily",
  "exa",
  "serpapi",
  "perplexityai",
  "peopledatalabs",
  "snowflake",
  "posthog",
  "ably",
  "abstract",
  "abuseipdb",
  "44api",
  "stripe",
  "figma",
  "1password",
  "7shifts",
  "abyssale",
  "0codekit",
  "2chat",
  "twitter",
  "instagram",
  "youtube",
  "reddit",
  "facebook",
  "metaads",
  "linkedin",
  "21risk",
  "apollo",
  "ashby",
  "gong",
  "pipedrive",
  "attio",
  "hubspot",
  "salesforce",
] as const;

describe("reconciled first-party provider-family contract", () => {
  it("covers every assigned connector exactly once without changing public ids", () => {
    const ids = FIRST_PARTY_PROVIDER_FAMILY_STATUS.map(
      (entry) => entry.connectorId,
    );
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(SAFE_CONNECTOR_ID);
  });

  it("retains Composio without claiming live and reports code independently", () => {
    for (const entry of FIRST_PARTY_PROVIDER_FAMILY_STATUS) {
      expect(entry.fallbackStatus).toBe("retained");
      expect(entry.activationBlockers.length).toBeGreaterThan(0);
    }
    const counts = Object.groupBy(
      FIRST_PARTY_PROVIDER_FAMILY_STATUS,
      (entry) => entry.codeStatus,
    );
    expect(counts.executor_ready).toHaveLength(30);
    expect(counts.planner_ready).toHaveLength(8);
    expect(counts.metadata_only).toHaveLength(11);
    expect(
      FIRST_PARTY_PROVIDER_FAMILY_STATUS.filter(
        (entry) => entry.activationStatus === "external_blocked",
      ),
    ).toHaveLength(30);
    expect(
      FIRST_PARTY_PROVIDER_FAMILY_STATUS.filter(
        (entry) => entry.activationStatus === "code_blocked",
      ),
    ).toHaveLength(19);
  });

  it("preserves shared grants and digit-leading toolkit ids", () => {
    expect(getFirstPartyProviderFamilyStatus("slackbot")?.providerKey).toBe(
      "slack",
    );
    expect(getFirstPartyProviderFamilyStatus("jira")?.providerKey).toBe(
      "atlassian",
    );
    for (const id of ["outlook", "microsoft_teams", "excel"]) {
      const status = getFirstPartyProviderFamilyStatus(id);
      expect(status?.providerKey).toBe("microsoft");
      expect(status?.activationBlockers).toContain(
        "contact@fromyou.ai Microsoft identity or existing tenant membership",
      );
    }
    expect(getFirstPartyProviderFamilyStatus("44api")?.toolkitId).toBe("44API");
    expect(getFirstPartyProviderFamilyStatus("1password")?.toolkitId).toBe(
      "_1PASSWORD",
    );
    expect(getFirstPartyProviderFamilyStatus("0codekit")?.toolkitId).toBe(
      "0CODEKIT",
    );
    for (const id of ["facebook", "instagram", "metaads"]) {
      expect(getFirstPartyProviderFamilyStatus(id)?.providerKey).toBe("meta");
    }
    expect(getFirstPartyProviderFamilyStatus("youtube")?.toolkitId).toBe(
      "YOUTUBE",
    );
    expect(getFirstPartyProviderFamilyStatus("7shifts")).toMatchObject({
      toolkitId: "7SHIFTS",
      auth: "api_key",
      adapterSurface: "request_planner",
      fallbackStatus: "retained",
      activationStatus: "external_blocked",
    });
  });

  it("assigns every authoritative pages 1-2 connector to exactly one family", () => {
    const ownershipIds = AUTHORITATIVE_PAGE_1_2_CONNECTOR_OWNERSHIP.map(
      (entry) => entry.connectorId,
    );
    expect(new Set(ownershipIds).size).toBe(15);

    for (const ownership of AUTHORITATIVE_PAGE_1_2_CONNECTOR_OWNERSHIP) {
      const status = getFirstPartyProviderFamilyStatus(ownership.connectorId);
      expect(status?.ownerFamily, ownership.connectorId).toBe(
        ownership.ownerFamily,
      );
      expect(status?.toolkitId, ownership.connectorId).toBe(
        ownership.toolkitId,
      );
      expect(status?.auth, ownership.connectorId).toBe(ownership.auth);
    }
  });
});
