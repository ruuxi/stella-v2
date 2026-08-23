import { Context, Effect, Layer } from "effect";
import type { App } from "electron";

import type { BundledSyncReport } from "./bundled-sync.js";
import {
  getOrCreateDeviceIdentityEffect,
  resetDeviceIdentityEffect,
  type DeviceIdentity,
} from "./device.js";
import {
  reconcileBundledExtensionsEffect,
  type ExtensionsSyncReport,
} from "./extensions-sync.js";
import { reconcileSelectedPersonalityEffect } from "./personality-sync.js";
import {
  applyPromptManifestIfCurrentEffect,
  reconcileBundledManagerPromptFallbackEffect,
  reconcileRemotePromptManifestEffect,
  recordAppliedPromptManifestEffect,
  resolvePromptManifestEffect,
  type AppliedPromptState,
  type PromptManifestResolution,
  type RemotePromptManifest,
} from "./prompt-manifest-sync.js";
import {
  reconcileBundledSkillsEffect,
  type SkillsSyncOptions,
  type SkillsSyncReport,
} from "./skills-sync.js";
import {
  ensureStellaDataDirSeededEffect,
  resolveStellaDataDirEffect,
  syncStellaPromptSnapshotEffect,
  type StellaDataDir,
  type StellaDataDirSeedReport,
} from "./stella-home.js";

/**
 * The Stella-home subsystem as one Effect-native service: data-dir
 * resolution and seeding, bundled skills/extensions reconciliation, the
 * remote prompt manifest pipeline, personality reconciliation, and device
 * identity. Effect-native runtime code consumes this service; the legacy
 * plain-Promise module exports are facades over the shared home
 * `ManagedRuntime` (see `home-runtime.ts`), preserving every caller-visible
 * signature and error string.
 */
export interface Interface {
  readonly ensureStellaDataDirSeeded: (
    stellaAppDir: string,
    stellaDataDir: string,
    options?: { promptSiteUrl?: string | null },
  ) => Effect.Effect<StellaDataDirSeedReport, unknown>;
  readonly syncStellaPromptSnapshot: (
    stellaAppDir: string,
    stellaDataDir: string,
    promptSiteUrl: string,
  ) => Effect.Effect<PromptManifestResolution, unknown>;
  readonly resolveStellaDataDir: (
    app: App,
    explicitRoot?: string,
    explicitStatePath?: string,
  ) => Effect.Effect<StellaDataDir, unknown>;
  readonly getOrCreateDeviceIdentity: (
    statePath: string,
  ) => Effect.Effect<DeviceIdentity, unknown>;
  readonly resetDeviceIdentity: (
    statePath: string,
    options?: { preservePairings?: boolean },
  ) => Effect.Effect<DeviceIdentity, unknown>;
  readonly reconcileBundledSkills: (
    bundledSkillsDir: string,
    homeSkillsDir: string,
    options?: SkillsSyncOptions,
  ) => Effect.Effect<SkillsSyncReport, unknown>;
  readonly reconcileBundledExtensions: (
    bundledExtensionsDir: string,
    homeExtensionsDir: string,
  ) => Effect.Effect<ExtensionsSyncReport, unknown>;
  readonly reconcileSelectedPersonality: (
    stellaDataDir: string,
    sourceRevision: string,
  ) => Effect.Effect<BundledSyncReport, unknown>;
  readonly resolvePromptManifest: (
    args: Parameters<typeof resolvePromptManifestEffect>[0],
  ) => Effect.Effect<PromptManifestResolution, unknown>;
  readonly recordAppliedPromptManifest: (
    args: Parameters<typeof recordAppliedPromptManifestEffect>[0],
  ) => Effect.Effect<AppliedPromptState, unknown>;
  readonly applyPromptManifestIfCurrent: <T>(args: {
    stellaDataDir: string;
    endpoint: string;
    manifest: RemotePromptManifest;
    reconcile: Effect.Effect<T, unknown>;
  }) => Effect.Effect<T, unknown>;
  readonly reconcileRemotePromptManifest: (
    manifest: RemotePromptManifest,
    stellaDataDir: string,
    agentMetadataDir: string,
  ) => Effect.Effect<BundledSyncReport[], unknown>;
  readonly reconcileBundledManagerPromptFallback: (
    stellaDataDir: string,
    agentMetadataDir: string,
  ) => Effect.Effect<BundledSyncReport, unknown>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/home/HomeService",
) {}

const make = (): Interface => ({
  ensureStellaDataDirSeeded: Effect.fn("HomeService.ensureStellaDataDirSeeded")(
    function* (
      stellaAppDir: string,
      stellaDataDir: string,
      options?: { promptSiteUrl?: string | null },
    ) {
      return yield* ensureStellaDataDirSeededEffect(
        stellaAppDir,
        stellaDataDir,
        options,
      );
    },
  ),
  syncStellaPromptSnapshot: Effect.fn("HomeService.syncStellaPromptSnapshot")(
    function* (
      stellaAppDir: string,
      stellaDataDir: string,
      promptSiteUrl: string,
    ) {
      return yield* syncStellaPromptSnapshotEffect(
        stellaAppDir,
        stellaDataDir,
        promptSiteUrl,
      );
    },
  ),
  resolveStellaDataDir: Effect.fn("HomeService.resolveStellaDataDir")(
    function* (app: App, explicitRoot?: string, explicitStatePath?: string) {
      return yield* resolveStellaDataDirEffect(
        app,
        explicitRoot,
        explicitStatePath,
      );
    },
  ),
  getOrCreateDeviceIdentity: Effect.fn("HomeService.getOrCreateDeviceIdentity")(
    function* (statePath: string) {
      return yield* getOrCreateDeviceIdentityEffect(statePath);
    },
  ),
  resetDeviceIdentity: Effect.fn("HomeService.resetDeviceIdentity")(function* (
    statePath: string,
    options?: { preservePairings?: boolean },
  ) {
    return yield* resetDeviceIdentityEffect(statePath, options);
  }),
  reconcileBundledSkills: Effect.fn("HomeService.reconcileBundledSkills")(
    function* (
      bundledSkillsDir: string,
      homeSkillsDir: string,
      options?: SkillsSyncOptions,
    ) {
      return yield* reconcileBundledSkillsEffect(
        bundledSkillsDir,
        homeSkillsDir,
        options,
      );
    },
  ),
  reconcileBundledExtensions: Effect.fn(
    "HomeService.reconcileBundledExtensions",
  )(function* (bundledExtensionsDir: string, homeExtensionsDir: string) {
    return yield* reconcileBundledExtensionsEffect(
      bundledExtensionsDir,
      homeExtensionsDir,
    );
  }),
  reconcileSelectedPersonality: Effect.fn(
    "HomeService.reconcileSelectedPersonality",
  )(function* (stellaDataDir: string, sourceRevision: string) {
    return yield* reconcileSelectedPersonalityEffect(
      stellaDataDir,
      sourceRevision,
    );
  }),
  resolvePromptManifest: Effect.fn("HomeService.resolvePromptManifest")(
    function* (args: Parameters<typeof resolvePromptManifestEffect>[0]) {
      return yield* resolvePromptManifestEffect(args);
    },
  ),
  recordAppliedPromptManifest: Effect.fn(
    "HomeService.recordAppliedPromptManifest",
  )(function* (args: Parameters<typeof recordAppliedPromptManifestEffect>[0]) {
    return yield* recordAppliedPromptManifestEffect(args);
  }),
  // Generic in the reconcile result; delegated without a span wrapper so the
  // type parameter survives the interface boundary.
  applyPromptManifestIfCurrent: (args) =>
    applyPromptManifestIfCurrentEffect(args),
  reconcileRemotePromptManifest: Effect.fn(
    "HomeService.reconcileRemotePromptManifest",
  )(function* (
    manifest: RemotePromptManifest,
    stellaDataDir: string,
    agentMetadataDir: string,
  ) {
    return yield* reconcileRemotePromptManifestEffect(
      manifest,
      stellaDataDir,
      agentMetadataDir,
    );
  }),
  reconcileBundledManagerPromptFallback: Effect.fn(
    "HomeService.reconcileBundledManagerPromptFallback",
  )(function* (stellaDataDir: string, agentMetadataDir: string) {
    return yield* reconcileBundledManagerPromptFallbackEffect(
      stellaDataDir,
      agentMetadataDir,
    );
  }),
});

/**
 * Built lazily (first facade call / first Effect-native use): the service
 * holds no OS resources of its own — every held resource (the SQLite
 * prompt-apply lock, temp file handles) is scoped inside the individual
 * operations via acquireRelease.
 */
export const layer = Layer.effect(
  Service,
  Effect.sync(() => make()),
);
