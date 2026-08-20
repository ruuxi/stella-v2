import { describe, expect, it, vi } from "vitest";

import { configureLinuxGraphics } from "@stella/desktop/electron/linux-graphics.js";

describe("Linux graphics configuration", () => {
  it("disables hardware acceleration on Linux", () => {
    const disableHardwareAcceleration = vi.fn();

    expect(
      configureLinuxGraphics({
        disableHardwareAcceleration,
        platform: "linux",
      }),
    ).toBe(true);
    expect(disableHardwareAcceleration).toHaveBeenCalledOnce();
  });

  it.each(["darwin", "win32"] as const)(
    "retains hardware acceleration on %s",
    (platform) => {
      const disableHardwareAcceleration = vi.fn();

      expect(
        configureLinuxGraphics({
          disableHardwareAcceleration,
          platform,
        }),
      ).toBe(false);
      expect(disableHardwareAcceleration).not.toHaveBeenCalled();
    },
  );
});
