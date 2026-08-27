import { existsSync } from "node:fs";
import path from "path";
import os from "os";
import type { App } from "electron";

export const resolveBundledAgentMetadataDir = (stellaAppDir: string): string => {
  const resourcesPath = process.env.STELLA_APP_RESOURCES_PATH?.trim();
  const candidates = [
    ...(resourcesPath
      ? [path.join(resourcesPath, "runtime", "extensions", "stella-runtime", "agent-metadata")]
      : []),
    path.join(stellaAppDir, "packages", "runtime", "extensions", "stella-runtime", "agent-metadata"),
    path.join(stellaAppDir, "runtime", "extensions", "stella-runtime", "agent-metadata"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
};

const __dirname = import.meta.dirname;

export const resolveStellaAppDir = (
  app?: App,
  explicitRoot?: string,
): string => {
  const normalizedExplicitRoot = explicitRoot?.trim();
  if (normalizedExplicitRoot) {
    return normalizedExplicitRoot;
  }
  return app
    ? path.resolve(app.getAppPath(), "..")
    : path.resolve(__dirname, "..", "..", "..", "..");
};

export const resolveDefaultStellaDataDir = (): string =>
  path.join(os.homedir(), ".stella");

export const resolveStellaDataSeedDir = (stellaAppDir: string): string => {
  const resourcesPath = process.env.STELLA_APP_RESOURCES_PATH?.trim();
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, "home-seed")] : []),
    path.join(stellaAppDir, "packages", "home-seed"),
    path.join(stellaAppDir, "home-seed"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
};

export const resolveRuntimeStatePath = (
  _app?: App,
  _explicitRoot?: string,
  explicitStatePath?: string,
): string => {
  const configuredStatePath =
    explicitStatePath?.trim() || process.env.STELLA_DATA_DIR?.trim();
  return path.resolve(configuredStatePath || resolveDefaultStellaDataDir());
};
