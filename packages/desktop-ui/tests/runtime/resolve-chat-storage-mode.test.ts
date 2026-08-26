import { describe, expect, it } from "vitest";
import {
  CloudConfigError,
  resolveChatStorageMode,
} from "@/context/resolve-chat-storage-mode";

describe("resolveChatStorageMode (cloud activation + no silent fallback)", () => {
  it("defaults to local when the cloud flag is unset (production/offline builds unchanged)", () => {
    expect(
      resolveChatStorageMode({
        cloudConversationsFlag: undefined,
        convexUrl: undefined,
        convexSiteUrl: undefined,
        journalIssuer: undefined,
      }),
    ).toEqual({ storageMode: "local", cloudFeaturesEnabled: false });
  });

  it("stays local even when Convex is configured, as long as the flag is off", () => {
    expect(
      resolveChatStorageMode({
        cloudConversationsFlag: "0",
        convexUrl: "https://benevolent-minnow-586.convex.cloud",
        convexSiteUrl: "https://benevolent-minnow-586.convex.site",
        journalIssuer: undefined,
      }),
    ).toEqual({ storageMode: "local", cloudFeaturesEnabled: false });
  });

  it("resolves cloud-canonical when enabled and issuer is aligned", () => {
    expect(
      resolveChatStorageMode({
        cloudConversationsFlag: "1",
        convexUrl: "https://flexible-panther-999.convex.cloud",
        convexSiteUrl: "https://flexible-panther-999.convex.site",
        journalIssuer: "https://flexible-panther-999.convex.site",
      }),
    ).toEqual({ storageMode: "cloud", cloudFeaturesEnabled: true });
  });

  it("throws (no silent local fallback) when enabled but Convex config is missing", () => {
    expect(() =>
      resolveChatStorageMode({
        cloudConversationsFlag: "1",
        convexUrl: undefined,
        convexSiteUrl: undefined,
        journalIssuer: undefined,
      }),
    ).toThrow(CloudConfigError);
  });

  it("throws on issuer mismatch (desktop vs journal worker) rather than 401-ing silently to local", () => {
    expect(() =>
      resolveChatStorageMode({
        cloudConversationsFlag: "1",
        // Desktop points at production issuer...
        convexUrl: "https://benevolent-minnow-586.convex.cloud",
        convexSiteUrl: "https://benevolent-minnow-586.convex.site",
        // ...but the staging journal worker verifies the dev issuer.
        journalIssuer: "https://flexible-panther-999.convex.site",
      }),
    ).toThrow(/issuer mismatch/i);
  });
});
