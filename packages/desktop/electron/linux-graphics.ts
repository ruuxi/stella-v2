type LinuxGraphicsOptions = {
  commandLine: {
    appendSwitch: (switchName: string, value?: string) => void;
  };
  platform?: NodeJS.Platform;
};

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
