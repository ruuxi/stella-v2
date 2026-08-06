import path from "node:path";

export const resolveBundledBunPath = (
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(
    resourcesPath,
    "bin",
    platform === "win32" ? "bun.exe" : "bun",
  );
};

/**
 * Point every runtime child at the Bun executable shipped inside Stella.
 * Packaged installs must never depend on a user-level Bun installation or PATH.
 */
export const configurePackagedBunEnvironment = (options: {
  resourcesPath: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): string => {
  const env = options.env ?? process.env;
  const existing = env.STELLA_BUN_PATH?.trim();
  if (existing) return existing;

  const bundledPath = resolveBundledBunPath(
    options.resourcesPath,
    options.platform,
  );
  env.STELLA_BUN_PATH = bundledPath;
  return bundledPath;
};
