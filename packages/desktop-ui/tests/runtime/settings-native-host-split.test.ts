import { describe, expect, test } from "vitest";
import {
  SETTINGS_SEARCH_ENTRY_DEFS,
  searchSettings,
} from "../../src/global/settings/lib/settings-search-index";

describe("website settings native-host isolation", () => {
  test("website search excludes every native catalog entry", () => {
    const translate = (key: string) => key;
    const nativeEntries = SETTINGS_SEARCH_ENTRY_DEFS.filter(
      (entry) => entry.availability === "native",
    );
    expect(nativeEntries.length).toBeGreaterThan(0);

    for (const entry of nativeEntries) {
      const query = entry.keywords[0] ?? entry.titleKey;
      const websiteTitles = searchSettings(query, translate, {
        host: "website",
      }).map((result) => result.title);
      expect(websiteTitles).not.toContain(entry.titleKey);

      const nativeTitles = searchSettings(query, translate, {
        host: "native",
        platform: "darwin",
      }).map((result) => result.title);
      expect(nativeTitles).toContain(entry.titleKey);
    }
  });

  test("native-only cards are indexed and platform-specific rows stay exact", () => {
    const translate = (key: string) => key;
    const byTitle = new Map(
      SETTINGS_SEARCH_ENTRY_DEFS.map((entry) => [entry.titleKey, entry]),
    );

    expect(
      byTitle.get("settings.resetCustomizations.title")?.availability,
    ).toBe("native");
    expect(byTitle.get("settings.systemPrompt.title")?.availability).toBe(
      "native",
    );
    expect(
      byTitle.get("settings.nativeFontSmoothing.title")?.platforms,
    ).toEqual(["darwin"]);

    const linuxTitles = searchSettings("font smoothing", translate, {
      host: "native",
      platform: "linux",
    }).map((result) => result.title);
    expect(linuxTitles).not.toContain("settings.nativeFontSmoothing.title");

    const darwinTitles = searchSettings("font smoothing", translate, {
      host: "native",
      platform: "darwin",
    }).map((result) => result.title);
    expect(darwinTitles).toContain("settings.nativeFontSmoothing.title");
  });
});
