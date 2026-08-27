import os from "node:os";
import path from "node:path";

export const resolvePackagedStellaAppDirPath = (appPath: string): string =>
  path.dirname(path.resolve(appPath));

export const resolveDesktopStellaDataDirPath = (options: {

  configuredStatePath?: string | null;
  homeDir?: string;
}): string => {
  const configured = options.configuredStatePath?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  return path.join(options.homeDir ?? os.homedir(), ".stella");
};
