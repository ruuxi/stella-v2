import { describe, expect, it } from "vitest";

import {
  FIRST_PARTY_PROVIDER_FAMILY_STATUS,
  getFirstPartyProviderFamilyStatus,
} from "@stella/runtime/kernel/connectors/first-party-provider-families";

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
  "people_data_labs",
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

  it("keeps Composio live and native activation blocked until verified", () => {
    for (const entry of FIRST_PARTY_PROVIDER_FAMILY_STATUS) {
      expect(entry.fallbackStatus).toBe("live");
      expect(entry.codeStatus).toBe("code_ready");
      expect(entry.activationStatus).toBe("external_blocked");
      expect(entry.activationBlockers.length).toBeGreaterThan(0);
    }
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
  });
});
