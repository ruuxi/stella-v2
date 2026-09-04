import { afterEach, describe, expect, test, vi } from "vitest";

describe("website platform capabilities", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("disables native surfaces while retaining browser uploads", async () => {
    vi.stubEnv("VITE_STELLA_WEB_BUILD", "1");
    const { platformCapabilities, stellaHostKind } = await import(
      "../../src/platform/capabilities"
    );

    expect(stellaHostKind()).toBe("website");
    expect(platformCapabilities).toMatchObject({
      onboarding: false,
      nativeBridges: false,
      phoneAccess: false,
      shortcuts: false,
      nativeSettings: false,
      localFiles: false,
      localModels: false,
      realtimeVoice: false,
      browserUploads: true,
      automaticExecutionLabel: "Automatic",
    });
  });

  test("filters native settings tabs without changing the desktop list", async () => {
    const { availableSettingsTabs, SETTINGS_TABS } = await import(
      "../../src/global/settings/settings-tabs"
    );
    expect(availableSettingsTabs(true).map((tab) => tab.key)).toEqual([
      "general",
      "account",
      "audio",
    ]);
    expect(availableSettingsTabs(false)).toEqual(SETTINGS_TABS);
  });
});
