import { describe, expect, it, vi } from "vitest";

import { configureLinuxGraphics } from "@stella/desktop/electron/linux-graphics.js";

describe("Linux graphics configuration", () => {
  it("selects ANGLE's OpenGL backend on Linux", () => {
    const appendSwitch = vi.fn();

    expect(
      configureLinuxGraphics({
        commandLine: { appendSwitch },
        platform: "linux",
      }),
    ).toBe(true);
    expect(appendSwitch).toHaveBeenNthCalledWith(1, "use-gl", "angle");
    expect(appendSwitch).toHaveBeenNthCalledWith(2, "use-angle", "gl");
  });

  it.each(["darwin", "win32"] as const)(
    "retains the default graphics configuration on %s",
    (platform) => {
      const appendSwitch = vi.fn();

      expect(
        configureLinuxGraphics({
          commandLine: { appendSwitch },
          platform,
        }),
      ).toBe(false);
      expect(appendSwitch).not.toHaveBeenCalled();
    },
  );
});
