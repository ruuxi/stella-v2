import { Context, Effect, Layer } from "effect";
import type { App } from "electron";

import {
  getOrCreateDeviceIdentityEffect,
  resetDeviceIdentityEffect,
  type DeviceIdentity,
} from "./device.js";
import {
  reconcileBundledExtensionsEffect,
  type ExtensionsSyncReport,
} from "./extensions-sync.js";
import {
  reconcileBundledSkillsEffect,
  type SkillsSyncOptions,
  type SkillsSyncReport,
} from "./skills-sync.js";
import {
  ensureStellaDataDirSeededEffect,
  resolveStellaDataDirEffect,
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
  ) => Effect.Effect<StellaDataDirSeedReport, unknown>;
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

}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/home/HomeService",
) {}

const make = (): Interface => ({
  ensureStellaDataDirSeeded: Effect.fn("HomeService.ensureStellaDataDirSeeded")(
    function* (stellaAppDir: string, stellaDataDir: string) {
      return yield* ensureStellaDataDirSeededEffect(stellaAppDir, stellaDataDir);
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
