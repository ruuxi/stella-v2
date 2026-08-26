import path from "path";
import { promises as fs } from "fs";
import type { App } from "electron";
import { ensurePrivateDir } from "../shared/private-fs.js";
import {
  buildBundledSkillsSnapshot,
  syncBundledSkills,
} from "./bundled-skills.js";
import { migrateLegacyHomeLayout } from "./legacy-migration.js";
import {
  resolveBundledAgentMetadataDir,
  resolveDefaultStellaDataDir,
  resolveRuntimeStatePath,
  resolveStellaAppDir,
  resolveStellaDataSeedDir,
} from "./stella-paths.js";

// Path helpers are re-exported so existing Electron-side importers keep
// working; runtime-worker code must import `stella-paths.js` directly so this
// module (and the sync machinery it drags in) stays out of the worker bundle.
export {
  resolveBundledAgentMetadataDir,
  resolveDefaultStellaDataDir,
  resolveRuntimeStatePath,
  resolveStellaAppDir,
  resolveStellaDataSeedDir,
};

export type StellaDataDir = {
  stellaAppDir: string;
  stellaDataDir: string;
  extensionsPath: string;
  statePath: string;
  workspacePath: string;
  workspaceAppsPath: string;
};

const ensureDir = async (dirPath: string) => {
  await ensurePrivateDir(dirPath);
};

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const copyPathIfMissing = async (sourcePath: string, targetPath: string) => {
  if (await pathExists(targetPath)) {
    return;
  }
  const stat = await fs.lstat(sourcePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (stat.isDirectory()) {
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    return;
  }
  await fs.copyFile(sourcePath, targetPath);
};

// One-shot copies into the user's space. Bundled skills are reconciled into
// the canonical `skills/` directory below; system prompts live in the app
// bundle and never materialize into the data dir at all.
const STELLA_DATA_SEED_ENTRIES = [
  "DREAM.md",
  path.join("outputs", "README.md"),
] as const;

export const ensureStellaDataDirSeeded = async (
  stellaAppDir: string,
  stellaDataDir: string,
): Promise<{ synced: boolean }> => {
  await ensureDir(stellaDataDir);
  const seedPath = resolveStellaDataSeedDir(stellaAppDir);
  for (const entry of STELLA_DATA_SEED_ENTRIES) {
    const sourcePath = path.join(seedPath, entry);
    if (!(await pathExists(sourcePath))) {
      continue;
    }
    await copyPathIfMissing(sourcePath, path.join(stellaDataDir, entry));
  }

  await migrateLegacyHomeLayout(stellaDataDir);

  const snapshot = await buildBundledSkillsSnapshot({
    seedSkillsDir: path.join(seedPath, "skills"),
  });
  const { applied } = await syncBundledSkills(stellaDataDir, snapshot);
  if (applied) {
    console.log("[stella-home] bundled skills synchronized");
  }

  return { synced: applied };
};

export const resolveStellaDataDir = async (
  app: App,
  explicitRoot?: string,
  explicitStatePath?: string,
): Promise<StellaDataDir> => {
  const stellaAppDir = resolveStellaAppDir(app, explicitRoot);
  const statePath = resolveRuntimeStatePath(
    app,
    stellaAppDir,
    explicitStatePath,
  );
  // Development may load runtime code from the checkout, but user-created
  // projects must always live in Stella's writable data root. Keeping the
  // workspace under `stellaAppDir` in dev made the external-app scaffold and
  // runtime look in different directories and reintroduced source-tree
  // mutation in the one mode where it is easiest to miss.
  const runtimeRoot = path.join(
    app.isPackaged ? statePath : stellaAppDir,
    "runtime",
  );
  const workspacePath = path.join(statePath, "workspace");

  const extensionsPath = path.join(runtimeRoot, "extensions");
  const workspaceAppsPath = path.join(workspacePath, "apps");

  process.env.STELLA_APP_DIR = stellaAppDir;
  process.env.STELLA_DATA_DIR = statePath;

  // NOTE: `ensureStellaDataDirSeeded` (migration + skills mirror) is
  // intentionally NOT invoked here — nothing on the first-paint path consumes
  // the mirrored dirs, only the deferred runtime worker does. It is awaited in
  // `initializeStellaHostRunner` (host-runner.ts), off the pre-window path,
  // before the worker that reads those dirs connects. `resolveStellaDataDir`
  // keeps only the cheap path resolution + env + dir ensures.
  await ensureDir(workspacePath);
  await ensureDir(workspaceAppsPath);

  return {
    stellaAppDir,
    stellaDataDir: statePath,
    extensionsPath,
    statePath,
    workspacePath,
    workspaceAppsPath,
  };
};
