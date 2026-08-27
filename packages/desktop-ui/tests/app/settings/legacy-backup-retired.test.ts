import { describe, expect, it } from "vitest";
import {
  SETTINGS_TAB_KEYS,
  SETTINGS_TABS,
} from "@/global/settings/settings-tabs";
import { SETTINGS_SEARCH_ENTRY_DEFS } from "@/global/settings/lib/settings-search-index";

describe("retired legacy backup settings", () => {
  it("does not expose a settings tab or searchable entry", () => {
    expect(SETTINGS_TAB_KEYS).not.toContain("backup");
    expect(SETTINGS_TABS.map((tab) => tab.key)).not.toContain("backup");
    expect(
      SETTINGS_SEARCH_ENTRY_DEFS.some(
        (entry) =>
          entry.titleKey.startsWith("settings.backup.") ||
          entry.descriptionKey.startsWith("settings.backup."),
      ),
    ).toBe(false);
  });
});
