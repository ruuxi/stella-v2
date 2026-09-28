import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";

export function createAsyncTempDirTracker() {
  const tempDirs: string[] = [];
  return {
    async create(prefix: string) {
      const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    },
    async cleanup() {
      await Promise.all(
        tempDirs
          .splice(0)
          // A child process that is still exiting can add an entry mid-rm
          // (ENOTEMPTY); retry briefly instead of failing the suite.
          .map((dir) =>
            rm(dir, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 100,
            }),
          ),
      );
    },
  };
}

export function createSyncTempDirTracker() {
  const tempDirs: string[] = [];
  return {
    create(prefix: string) {
      const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
