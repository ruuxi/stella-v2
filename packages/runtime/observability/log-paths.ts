import { hashStellaAppDir, resolveLogDir } from "../worker/runtime-paths.js";

export type LogPaths = {
  rootHash: string;
  logDir: string;
};

export const resolveLogPaths = (
  stellaAppDir: string,
  options?: { homeDir?: string },
): LogPaths => ({
  rootHash: hashStellaAppDir(stellaAppDir),
  logDir: resolveLogDir(stellaAppDir, options),
});
