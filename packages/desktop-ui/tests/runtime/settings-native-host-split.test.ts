import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  SETTINGS_SEARCH_ENTRY_DEFS,
  searchSettings,
} from "../../src/global/settings/lib/settings-search-index";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const read = (relative: string) =>
  fs.readFileSync(path.join(repoRoot, relative), "utf8");

describe("website settings native-host isolation", () => {
  test("GeneralTab loads native subtrees only through lazy imports", () => {
    const source = read(
      "packages/desktop-ui/src/global/settings/tabs/GeneralTab.tsx",
    );
    expect(source).not.toMatch(/electronAPI/);
    expect(source).not.toMatch(
      /getPreventComputerSleep|getSoundNotificationsEnabled|getLockedComputerUse|useDesktopPermissions/,
    );
    expect(source).not.toMatch(
      /from ["'].\/(?:NativeGeneralSettings|NativePermissionSettings)["']/,
    );
    expect(source).toContain('import("./NativeGeneralSettings")');
    expect(source).toContain('import("./NativePermissionSettings")');
    expect(source).toContain("lazy(() =>");
    expect(source).toContain("<Suspense fallback={null}>");
    expect(source).toContain("platformCapabilities.nativeSettings");
  });

  test("AudioTab lazy-loads native rows instead of importing their module eagerly", () => {
    const source = read("packages/desktop-ui/src/global/settings/AudioTab.tsx");
    const nativeSource = read(
      "packages/desktop-ui/src/global/settings/tabs/NativeAudioDesktopSettings.tsx",
    );
    expect(source).not.toMatch(
      /getWakeWordEnabled|getSoundEffectsEnabled|useMicrophoneRecovery|localStatus|getPermissionStatus/,
    );
    expect(source).not.toMatch(
      /from ["'].\/tabs\/NativeAudioDesktopSettings["']/,
    );
    expect(source).toContain('import("./tabs/NativeAudioDesktopSettings")');
    expect(source.match(/lazy\(\(\) =>/gu)).toHaveLength(1);
    expect(source.match(/<Suspense fallback=\{null\}>/gu)).toHaveLength(1);
    expect(source).toContain("<NativeAudioDesktopRows");
    expect(source).toContain("afterWakeWord={afterWakeWord}");
    expect(source).toContain("afterSounds={afterSounds}");

    const orderedRows = [
      "<NativeMicrophoneRecoveryRow />",
      "<NativeWakeWordRow micEnabled={micEnabled} />",
      "{afterWakeWord}",
      "<NativeDictationSoundsRow />",
      "{afterSounds}",
      "<NativeLocalDictationRow micEnabled={micEnabled} />",
    ].map((marker) => nativeSource.indexOf(marker));
    expect(orderedRows.every((index) => index >= 0)).toBe(true);
    expect(orderedRows).toEqual([...orderedRows].sort((a, b) => a - b));
  });

  test("settings search reads host availability from each catalog entry", () => {
    const source = read(
      "packages/desktop-ui/src/global/settings/SettingsSearchResults.tsx",
    );
    expect(source).toContain('host: platformCapabilities.website ? "website"');
    expect(source).toContain("platform: window.electronAPI?.platform");
    expect(source).not.toContain("HIDDEN_SETTING");
    expect(source).not.toContain("SETTING_TITLE_KEYS");
  });

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
