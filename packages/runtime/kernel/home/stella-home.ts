import path from "path";
import { promises as fs } from "fs";
import type { App } from "electron";

import { Effect } from "effect";

import { ensurePrivateDir } from "../shared/private-fs.js";
import {
  reconcileBundledSkillsEffect,
  summarizeSkillsSync,
  type SkillsSyncReport,
} from "./skills-sync.js";
import {
  summarizeBundledSync,
  type BundledSyncReport,
} from "./bundled-sync.js";
import {
  reconcileBundledExtensionsEffect,
  summarizeExtensionsSync,
  type ExtensionsSyncReport,
} from "./extensions-sync.js";
import {
  StalePromptManifestError,
  applyPromptManifestIfCurrentEffect,
  reconcileBundledManagerPromptFallbackEffect,
  reconcileRemotePromptManifestEffect,
  resolvePromptManifestEffect,
  type PromptManifestResolution,
} from "./prompt-manifest-sync.js";
import { reconcileSelectedPersonalityEffect } from "./personality-sync.js";
import { PromptEndpointMissingError } from "./errors.js";
import { withHome } from "./home-runtime.js";
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

export type StellaDataDirSeedReport = {
  skillsSync: SkillsSyncReport;
  extensionsSync: ExtensionsSyncReport;
  personalitySync: BundledSyncReport;
  promptResolution: PromptManifestResolution["source"];
};

/** Adapt a leaf Promise IO call, failing with the raw thrown value. */
const tryIO = <A>(f: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: f, catch: (error) => error });

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

// `skills/` is intentionally NOT a one-shot seed entry — it goes through
// hash-history reconciliation in `skills-sync.ts` so shipped skill updates
// reach existing users without trampling local edits.
const STELLA_DATA_SEED_ENTRIES = [
  "DREAM.md",
  path.join("outputs", "README.md"),
] as const;

export const ensureStellaDataDirSeededEffect = (
  stellaAppDir: string,
  stellaDataDir: string,
  options: { promptSiteUrl?: string | null } = {},
): Effect.Effect<StellaDataDirSeedReport, unknown> =>
  Effect.gen(function* () {
    yield* tryIO(() => ensureDir(stellaDataDir));
    const seedPath = resolveStellaDataSeedDir(stellaAppDir);
    for (const entry of STELLA_DATA_SEED_ENTRIES) {
      const sourcePath = path.join(seedPath, entry);
      if (!(yield* tryIO(() => pathExists(sourcePath)))) {
        continue;
      }
      yield* tryIO(() =>
        copyPathIfMissing(sourcePath, path.join(stellaDataDir, entry)),
      );
    }

    const bundledSkillsDir = path.join(seedPath, "skills");
    const homeSkillsDir = path.join(stellaDataDir, "skills");
    const skillsSync = yield* reconcileBundledSkillsEffect(
      bundledSkillsDir,
      homeSkillsDir,
    );
    const summary = summarizeSkillsSync(skillsSync);
    if (summary !== "no-op") {
      console.log(`[stella-home] skills sync: ${summary}`);
    }

    const extensionsSync = yield* reconcileBundledExtensionsEffect(
      path.join(seedPath, "extensions"),
      path.join(stellaDataDir, "extensions"),
    );
    const extensionsSummary = summarizeExtensionsSync(extensionsSync);
    if (extensionsSummary !== "no-op") {
      console.log(`[stella-home] extensions sync: ${extensionsSummary}`);
    }

    const promptResolution = yield* resolvePromptManifestEffect({
      stellaDataDir,
      siteUrl: options.promptSiteUrl,
    });
    let personalitySync: BundledSyncReport | null = null;
    if (promptResolution.manifest) {
      if (!promptResolution.endpoint) {
        return yield* Effect.fail(new PromptEndpointMissingError());
      }
      yield* applyPromptManifestIfCurrentEffect({
        stellaDataDir,
        endpoint: promptResolution.endpoint,
        manifest: promptResolution.manifest,
        reconcile: Effect.gen(function* () {
          yield* reconcileRemotePromptManifestEffect(
            promptResolution.manifest!,
            stellaDataDir,
            resolveBundledAgentMetadataDir(stellaAppDir),
          );
          personalitySync = yield* reconcileSelectedPersonalityEffect(
            stellaDataDir,
            promptResolution.manifest!.revision,
          );
        }),
      }).pipe(
        Effect.catch((error) =>
          error instanceof StalePromptManifestError
            ? Effect.sync(() => {
                personalitySync = { actions: [] };
              })
            : Effect.fail(error),
        ),
      );
    }

    const managerFallbackSync =
      yield* reconcileBundledManagerPromptFallbackEffect(
        stellaDataDir,
        resolveBundledAgentMetadataDir(stellaAppDir),
      );
    const managerFallbackSummary = summarizeBundledSync(managerFallbackSync);
    if (managerFallbackSummary !== "no-op") {
      console.log(
        `[stella-home] manager prompt fallback sync: ${managerFallbackSummary}`,
      );
    }

    personalitySync ??= { actions: [] };

    return {
      skillsSync,
      extensionsSync,
      personalitySync,
      promptResolution: promptResolution.source,
    };
  });

export const ensureStellaDataDirSeeded = (
  stellaAppDir: string,
  stellaDataDir: string,
  options: { promptSiteUrl?: string | null } = {},
): Promise<StellaDataDirSeedReport> =>
  withHome((home) =>
    home.ensureStellaDataDirSeeded(stellaAppDir, stellaDataDir, options),
  );

/**
 * Re-run only the remote prompt portion after the renderer supplies a site URL
 * later than main-process startup. Agent bodies are live-read per turn and the
 * extension watcher observes the atomic replacements.
 */
export const syncStellaPromptSnapshotEffect = (
  stellaAppDir: string,
  stellaDataDir: string,
  promptSiteUrl: string,
): Effect.Effect<PromptManifestResolution, unknown> =>
  Effect.gen(function* () {
    const resolution = yield* resolvePromptManifestEffect({
      stellaDataDir,
      siteUrl: promptSiteUrl,
    });
    if (resolution.manifest) {
      if (!resolution.endpoint) {
        return yield* Effect.fail(new PromptEndpointMissingError());
      }
      yield* applyPromptManifestIfCurrentEffect({
        stellaDataDir,
        endpoint: resolution.endpoint,
        manifest: resolution.manifest,
        reconcile: Effect.gen(function* () {
          yield* reconcileRemotePromptManifestEffect(
            resolution.manifest!,
            stellaDataDir,
            resolveBundledAgentMetadataDir(stellaAppDir),
          );
          yield* reconcileSelectedPersonalityEffect(
            stellaDataDir,
            resolution.manifest!.revision,
          );
        }),
      }).pipe(
        Effect.catch((error) =>
          error instanceof StalePromptManifestError
            ? Effect.void
            : Effect.fail(error),
        ),
      );
    }
    yield* reconcileBundledManagerPromptFallbackEffect(
      stellaDataDir,
      resolveBundledAgentMetadataDir(stellaAppDir),
    );
    return resolution;
  });

export const syncStellaPromptSnapshot = (
  stellaAppDir: string,
  stellaDataDir: string,
  promptSiteUrl: string,
): Promise<PromptManifestResolution> =>
  withHome((home) =>
    home.syncStellaPromptSnapshot(stellaAppDir, stellaDataDir, promptSiteUrl),
  );

export const resolveStellaDataDirEffect = (
  app: App,
  explicitRoot?: string,
  explicitStatePath?: string,
): Effect.Effect<StellaDataDir, unknown> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.sync(() => {
      const stellaAppDir = resolveStellaAppDir(app, explicitRoot);
      const statePath = resolveRuntimeStatePath(
        app,
        stellaAppDir,
        explicitStatePath,
      );
      const mutableRoot = app.isPackaged ? statePath : stellaAppDir;
      const workspacePath = path.join(mutableRoot, "workspace");

      const extensionsPath = path.join(statePath, "extensions");
      const workspaceAppsPath = path.join(workspacePath, "apps");

      process.env.STELLA_APP_DIR = stellaAppDir;
      process.env.STELLA_DATA_DIR = statePath;

      return {
        stellaAppDir,
        statePath,
        extensionsPath,
        workspacePath,
        workspaceAppsPath,
      };
    });

    // NOTE: `ensureStellaDataDirSeeded` (skills/agents hash-history reconciliation)
    // is intentionally NOT invoked here. It does ~100 awaited fs ops + sha256 over
    // hundreds of KB across ~17 skill dirs + ~8 agent files, and nothing on the
    // first-paint path consumes the seeded dirs — only the deferred runtime worker
    // does. It is now awaited in `initializeStellaHostRunner` (host-runner.ts),
    // off the pre-window path, before the worker that reads those dirs connects.
    // `resolveStellaDataDir` keeps only the cheap path resolution + env + dir
    // ensures that the rest of bootstrap depends on synchronously.
    yield* tryIO(() => ensureDir(resolved.workspacePath));
    yield* tryIO(() => ensureDir(resolved.workspaceAppsPath));

    return {
      stellaAppDir: resolved.stellaAppDir,
      stellaDataDir: resolved.statePath,
      extensionsPath: resolved.extensionsPath,
      statePath: resolved.statePath,
      workspacePath: resolved.workspacePath,
      workspaceAppsPath: resolved.workspaceAppsPath,
    };
  });

export const resolveStellaDataDir = (
  app: App,
  explicitRoot?: string,
  explicitStatePath?: string,
): Promise<StellaDataDir> =>
  withHome((home) =>
    home.resolveStellaDataDir(app, explicitRoot, explicitStatePath),
  );
