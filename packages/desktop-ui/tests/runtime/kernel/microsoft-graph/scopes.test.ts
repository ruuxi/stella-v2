import { describe, expect, it } from "vitest";

import {
  MICROSOFT_GRAPH_SCOPES,
  MICROSOFT_GRAPH_SERVICE_SCOPES,
  MICROSOFT_IDENTITY_SCOPES,
  getRequiredScopesForMicrosoftService,
  hasRequiredMicrosoftScopes,
  resolveMicrosoftGraphServiceId,
} from "@stella/runtime/kernel/microsoft-graph/scopes";

describe("microsoft graph scopes", () => {
  it("union is a deduped superset of identity + every service scope", () => {
    const expected = new Set([
      ...MICROSOFT_IDENTITY_SCOPES,
      ...Object.values(MICROSOFT_GRAPH_SERVICE_SCOPES).flat(),
    ]);
    // No duplicates.
    expect(MICROSOFT_GRAPH_SCOPES.length).toBe(new Set(MICROSOFT_GRAPH_SCOPES).size);
    // Every expected scope present.
    for (const scope of expected) {
      expect(MICROSOFT_GRAPH_SCOPES).toContain(scope);
    }
    expect(MICROSOFT_GRAPH_SCOPES.length).toBe(expected.size);
  });

  it("carries offline_access so the shared grant yields a refresh token", () => {
    expect(MICROSOFT_GRAPH_SCOPES).toContain("offline_access");
  });

  it("excludes SharePoint / OneDrive scopes (out of current scope)", () => {
    expect(MICROSOFT_GRAPH_SCOPES).not.toContain("Sites.ReadWrite.All");
    expect(MICROSOFT_GRAPH_SCOPES).not.toContain("Files.ReadWrite.All");
  });

  it("uses least-privilege delegated (non-admin) service scopes", () => {
    // Excel uses per-file Files.ReadWrite, not the tenant-wide .All variant.
    expect(MICROSOFT_GRAPH_SERVICE_SCOPES.excel).toEqual(["Files.ReadWrite"]);
    // No application-only (admin-consent) scopes leak into the union.
    for (const scope of MICROSOFT_GRAPH_SCOPES) {
      expect(scope.endsWith(".All") && scope.startsWith("Sites")).toBe(false);
    }
  });

  it("resolves connector ids and aliases to a service", () => {
    expect(resolveMicrosoftGraphServiceId("outlook")).toBe("outlook");
    expect(resolveMicrosoftGraphServiceId("microsoft_teams")).toBe(
      "microsoft_teams",
    );
    expect(resolveMicrosoftGraphServiceId("teams")).toBe("microsoft_teams");
    expect(resolveMicrosoftGraphServiceId("excel")).toBe("excel");
    expect(resolveMicrosoftGraphServiceId("sharepoint")).toBeUndefined();
  });

  it("reports per-service required scopes (identity baseline + service)", () => {
    const outlook = getRequiredScopesForMicrosoftService("outlook");
    expect(outlook).toContain("Mail.Send");
    expect(outlook).toContain("User.Read");
    expect(outlook).not.toContain("ChannelMessage.Send");

    const teams = getRequiredScopesForMicrosoftService("teams");
    expect(teams).toContain("ChannelMessage.Send");
    expect(teams).not.toContain("Mail.Send");
  });

  it("is scope-aware: a mail-only grant is not ready for Teams", () => {
    const granted = [
      "openid",
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
    ];
    expect(
      hasRequiredMicrosoftScopes(
        granted,
        getRequiredScopesForMicrosoftService("outlook"),
      ),
    ).toBe(false); // missing Calendars.ReadWrite
    expect(
      hasRequiredMicrosoftScopes(
        [...granted, "Calendars.ReadWrite"],
        getRequiredScopesForMicrosoftService("outlook"),
      ),
    ).toBe(true);
    expect(
      hasRequiredMicrosoftScopes(
        [...granted, "Calendars.ReadWrite"],
        getRequiredScopesForMicrosoftService("microsoft_teams"),
      ),
    ).toBe(false);
  });

  it("treats OIDC-only scopes as always satisfied when a token exists", () => {
    // Microsoft does not echo openid/profile/email back in the granted set.
    expect(hasRequiredMicrosoftScopes(["User.Read"], ["openid", "User.Read"])).toBe(
      true,
    );
  });

  it("empty required set is always satisfied", () => {
    expect(hasRequiredMicrosoftScopes(undefined, [])).toBe(true);
  });
});
