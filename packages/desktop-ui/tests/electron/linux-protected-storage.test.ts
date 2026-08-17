import { describe, expect, it, vi } from "vitest";

import {
  configureLinuxProtectedStorage,
  needsLinuxSecretServiceSelection,
} from "@stella/desktop/electron/linux-protected-storage.js";

describe("Linux protected storage selection", () => {
  it.each([
    { XDG_CURRENT_DESKTOP: "Hyprland" },
    { XDG_CURRENT_DESKTOP: "wayland:Hyprland" },
    { XDG_SESSION_DESKTOP: "hyprland" },
    { DESKTOP_SESSION: "omarchy" },
  ])("selects Secret Service for $env", (env) => {
    expect(needsLinuxSecretServiceSelection({ env, platform: "linux" })).toBe(
      true,
    );
  });

  it("does not override Electron's native desktop selection", () => {
    expect(
      needsLinuxSecretServiceSelection({
        env: { XDG_CURRENT_DESKTOP: "GNOME" },
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("does not select a Linux backend on other operating systems", () => {
    expect(
      needsLinuxSecretServiceSelection({
        env: { XDG_CURRENT_DESKTOP: "Hyprland" },
        platform: "darwin",
      }),
    ).toBe(false);
  });

  it("configures libsecret before startup", () => {
    const appendSwitch = vi.fn();

    expect(
      configureLinuxProtectedStorage({
        commandLine: { appendSwitch, hasSwitch: () => false },
        env: { XDG_CURRENT_DESKTOP: "Hyprland" },
        platform: "linux",
      }),
    ).toBe(true);
    expect(appendSwitch).toHaveBeenCalledWith(
      "password-store",
      "gnome-libsecret",
    );
  });

  it("preserves an explicitly selected password store", () => {
    const appendSwitch = vi.fn();

    expect(
      configureLinuxProtectedStorage({
        commandLine: { appendSwitch, hasSwitch: () => true },
        env: { XDG_CURRENT_DESKTOP: "Hyprland" },
        platform: "linux",
      }),
    ).toBe(false);
    expect(appendSwitch).not.toHaveBeenCalled();
  });
});
