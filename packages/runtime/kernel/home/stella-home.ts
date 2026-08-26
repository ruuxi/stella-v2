import path from "path";
import { promises as fs } from "fs";
import type { App } from "electron";

import { Effect } from "effect";

import { ensurePrivateDir } from "../shared/private-fs.js";
import {
  buildSystemSnapshot,
  cleanupAbandonedSystemDirs,
  mirrorSystemDir,
} from "./system-mirror.js";
import { migrateLegacyHomeLayout } from "./legacy-migration.js";
import { type BundledSyncReport } from "./bundled-sync.js";
import {
  StalePromptManifestError,
  applyPromptManifestIfCurrentEffect,
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
  mirrored: boolean;
  /** Present only when the cloud prompt-parity path ran (prompt site URL supplied). */
  promptResolution?: PromptManifestResolution["source"];
  personalitySync?: BundledSyncReport;
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

// One-shot copies into the user's space. Bundled skills are mirrored into
// `system/` instead; system prompts live in the app bundle and never
// materialize into the data dir at all.
const STELLA_DATA_SEED_ENTRIES = [path.join("outputs", "README.md")] as const;

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

    yield* tryIO(() => migrateLegacyHomeLayout(stellaDataDir));

    yield* tryIO(() => cleanupAbandonedSystemDirs(stellaDataDir));
    const snapshot = yield* tryIO(() =>
      buildSystemSnapshot({
        seedSkillsDir: path.join(seedPath, "skills"),
      }),
    );
    const { applied } = yield* tryIO(() =>
      mirrorSystemDir(stellaDataDir, snapshot),
    );
    if (applied) {
      yield* Effect.sync(() =>
        console.log("[stella-home] system skills mirror applied"),
      );
    }

    // Cloud prompt parity: the remote prompt manifest pipeline runs only when
    // a prompt site URL is supplied. The local-first path stays bundle-only —
    // system prompts never materialize into the data dir.
    let promptResolution: PromptManifestResolution["source"] | undefined;
    let personalitySync: BundledSyncReport | undefined;
    if (options.promptSiteUrl) {
      const resolution = yield* resolvePromptManifestEffect({
        stellaDataDir,
        siteUrl: options.promptSiteUrl,
      });
      promptResolution = resolution.source;
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
            personalitySync = yield* reconcileSelectedPersonalityEffect(
              stellaDataDir,
              resolution.manifest!.revision,
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
    }

    return {
      mirrored: applied,
      ...(promptResolution ? { promptResolution } : {}),
      ...(personalitySync ? { personalitySync } : {}),
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

      return {
        stellaAppDir,
        statePath,
        extensionsPath,
        workspacePath,
        workspaceAppsPath,
      };
    });

    // NOTE: `ensureStellaDataDirSeeded` (migration + skills mirror) is
    // intentionally NOT invoked here — nothing on the first-paint path consumes
    // the mirrored dirs, only the deferred runtime worker does. It is awaited in
    // `initializeStellaHostRunner` (host-runner.ts), off the pre-window path,
    // before the worker that reads those dirs connects. `resolveStellaDataDir`
    // keeps only the cheap path resolution + env + dir ensures.
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
