type LinuxGraphicsOptions = {
  disableHardwareAcceleration: () => void;
  platform?: NodeJS.Platform;
};

/**
 * Use Electron's software-compositing mode on Linux.
 *
 * Electron 43 / Chromium 150 can enter unstable GPU paths on Linux: native
 * Wayland selects a Vulkan presentation path that Chromium reports as
 * incompatible, while the X11 fallback can crash in NVIDIA/GBM initialization.
 * Repeated GPU subprocess failures terminate the browser through its fatal trap
 * path with "GPU process isn't usable. Goodbye."
 *
 * Linux hardware and driver combinations vary too widely to safely select a
 * narrower accelerated path in this Electron release. Keep macOS and Windows
 * hardware accelerated. Must run before Electron's `ready` event.
 */
export const configureLinuxGraphics = ({
  disableHardwareAcceleration,
  platform = process.platform,
}: LinuxGraphicsOptions): boolean => {
  if (platform !== "linux") {
    return false;
  }

  disableHardwareAcceleration();
  return true;
};
