import { describe, expect, it } from "vitest";
import {
  GOOGLE_WORKSPACE_SERVICE_SCOPES,
  IDENTITY_SCOPES,
  SCOPES,
  getRequiredScopesForIntegration,
  hasRequiredScopes,
} from "@stella/runtime/kernel/google-workspace/scopes";

const SCOPE = (name: string) => `https://www.googleapis.com/auth/${name}`;

describe("google-workspace scopes", () => {
  it("requests exactly the target scope union (identity + write-capable services)", () => {
    expect([...SCOPES].sort()).toEqual(
      [
        "openid",
        SCOPE("userinfo.email"),
        SCOPE("userinfo.profile"),
        SCOPE("gmail.modify"),
        SCOPE("calendar"),
        SCOPE("drive"),
        SCOPE("documents"),
        SCOPE("spreadsheets"),
        SCOPE("tasks"),
      ].sort(),
    );
  });

  it("drops the removed scopes and uses write-capable spreadsheets", () => {
    expect(SCOPES).toContain(SCOPE("spreadsheets"));
    expect(SCOPES).not.toContain(SCOPE("spreadsheets.readonly"));
    expect(SCOPES).not.toContain(SCOPE("chat.spaces"));
    expect(SCOPES).not.toContain(SCOPE("chat.messages"));
    expect(SCOPES).not.toContain(SCOPE("chat.memberships"));
    expect(SCOPES).not.toContain(SCOPE("directory.readonly"));
    expect(SCOPES).not.toContain(SCOPE("presentations.readonly"));
    expect(SCOPES.some((scope) => scope.includes("slides"))).toBe(false);
  });

  it("has no duplicate scopes", () => {
    expect(new Set(SCOPES).size).toBe(SCOPES.length);
  });

  it("maps each service to its required scopes plus the identity baseline", () => {
    expect(getRequiredScopesForIntegration("googlesheets")).toEqual([
      ...IDENTITY_SCOPES,
      SCOPE("spreadsheets"),
    ]);
    expect(getRequiredScopesForIntegration("googletasks")).toEqual([
      ...IDENTITY_SCOPES,
      SCOPE("tasks"),
    ]);
    expect(getRequiredScopesForIntegration("gmail")).toContain(
      SCOPE("gmail.modify"),
    );
    // Every declared service scope is part of the shared union.
    for (const serviceScopes of Object.values(GOOGLE_WORKSPACE_SERVICE_SCOPES)) {
      for (const scope of serviceScopes) expect(SCOPES).toContain(scope);
    }
  });

  it("requires the full six-service union for the one-tap bundle", () => {
    // Internal alias stays `googlesuper`; the bundle grants the whole union.
    expect([...getRequiredScopesForIntegration("googlesuper")].sort()).toEqual(
      [...SCOPES].sort(),
    );
  });

  it("falls back to identity scopes for unknown integrations", () => {
    expect(getRequiredScopesForIntegration("unknown")).toEqual([
      ...IDENTITY_SCOPES,
    ]);
  });

  it("checks scope supersets", () => {
    expect(hasRequiredScopes(SCOPES, getRequiredScopesForIntegration("googlesheets"))).toBe(
      true,
    );
    // A grant that predates Sheets/Tasks is missing those service scopes.
    const legacyGrant = [...IDENTITY_SCOPES, SCOPE("gmail.modify")];
    expect(
      hasRequiredScopes(legacyGrant, getRequiredScopesForIntegration("googlesheets")),
    ).toBe(false);
    expect(
      hasRequiredScopes(legacyGrant, getRequiredScopesForIntegration("gmail")),
    ).toBe(true);
    expect(hasRequiredScopes(undefined, IDENTITY_SCOPES)).toBe(false);
  });
});
