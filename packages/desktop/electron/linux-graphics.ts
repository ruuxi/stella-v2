type LinuxGraphicsOptions = {
  commandLine: {
    appendSwitch: (switchName: string, value?: string) => void;
  };
  platform?: NodeJS.Platform;
};

/**
 * Keep hardware acceleration enabled on Linux while selecting ANGLE's OpenGL
 * backend explicitly.
 *
 * Must run before Electron's `ready` event so the switches reach the GPU
 * process. macOS and Windows retain Electron's default graphics configuration.
 */
export const configureLinuxGraphics = ({
  commandLine,
  platform = process.platform,
}: LinuxGraphicsOptions): boolean => {
  if (platform !== "linux") {
    return false;
  }

  commandLine.appendSwitch("use-gl", "angle");
  commandLine.appendSwitch("use-angle", "gl");
  return true;
};
