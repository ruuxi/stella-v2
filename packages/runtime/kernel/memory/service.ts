import { Context, Effect, Layer } from "effect";
import type { SqliteDatabase } from "../storage/shared.js";
import {
  assertSafeDreamMemoryRootEffect,
  ensureDreamMemoryLayoutEffect,
  readMemoryFileEffect,
  readMemoryMapEffect,
  type DreamMemoryLayoutTelemetry,
} from "./dream-storage.js";
import {
  appendSupersededMemoryTextEffect,
  listMemoryArchiveFilesEffect,
  rotateMemoryFileIfNeededEffect,
  type MemoryRotationHooks,
  type MemoryRotationResult,
} from "./memory-rotation.js";
import {
  applyUserProfileOperationEffect,
  readUserProfileEffect,
  type UserProfileOperation,
  type UserProfileOperationResult,
} from "./user-profile-store.js";
import {
  runChronicleSummaryEffect,
  type ChronicleSummaryResult,
  type RunChronicleSummaryArgs,
} from "./chronicle-summarizer.js";
import {
  readCoreMemoryEffect,
  readMemoryMapDocEffect,
  readStartupDocBodyFromDiskEffect,
  readUserProfileDocEffect,
} from "./resident-docs.js";
import {
  makeDreamInboxEffects,
  type DreamInboxEffects,
} from "./dream-inbox-store.js";

/**
 * MemoryService — the memory subsystem's Effect-native surface, for the
 * session-layer graph (worker/server) to compose once the runner goes
 * Effect-native. Every operation is the same Effect the plain-Promise/sync
 * facades in this directory run through the shared memory ManagedRuntime, so
 * state (profile write mutex, migration queue, cross-tool file locks) is
 * process-global and identical whichever door a caller uses.
 *
 * The service holds no resources of its own: held resources (file handles,
 * the SQLite migration lock, the chronicle mkdir lock) are scoped inside the
 * individual operations via `Effect.acquireRelease`.
 */
export interface Interface {
  /** Dream on-disk layout (create-only migration under the keyed lock). */
  readonly ensureDreamMemoryLayout: (
    stellaDataDir: string,
  ) => Effect.Effect<DreamMemoryLayoutTelemetry, Error>;
  readonly assertSafeDreamMemoryRoot: (
    stellaDataDir: string,
  ) => Effect.Effect<string, Error>;
  readonly readMemoryFile: (
    stellaDataDir: string,
  ) => Effect.Effect<string | null, Error>;
  readonly readMemoryMap: (
    stellaDataDir: string,
  ) => Effect.Effect<string | null, Error>;

  /** Non-destructive MEMORY.md rotation + supersede journal. */
  readonly rotateMemoryFileIfNeeded: (
    stellaDataDir: string,
    hooks?: MemoryRotationHooks,
  ) => Effect.Effect<MemoryRotationResult | null, unknown>;
  readonly appendSupersededMemoryText: (
    stellaDataDir: string,
    removedText: string,
  ) => Effect.Effect<void, Error>;
  readonly listMemoryArchiveFiles: (
    stellaDataDir: string,
  ) => Effect.Effect<string[], Error>;

  /** Resident user profile (Remember tool). */
  readonly applyUserProfileOperation: (
    stellaDataDir: string,
    op: UserProfileOperation,
  ) => Effect.Effect<UserProfileOperationResult, Error>;
  readonly readUserProfile: (
    stellaDataDir: string,
  ) => Effect.Effect<string | null>;

  /** Resident startup-doc reads (model-facing, redacted, capped). */
  readonly readCoreMemory: (
    stellaDataDir: string,
  ) => Effect.Effect<string | undefined>;
  readonly readMemoryMapDoc: (
    stellaDataDir: string,
  ) => Effect.Effect<string | undefined>;
  readonly readUserProfileDoc: (
    stellaDataDir: string,
  ) => Effect.Effect<string | undefined>;
  readonly readStartupDocBodyFromDisk: (
    stellaDataDir: string,
    displayPath: string,
  ) => Effect.Effect<string | undefined>;

  /** Chronicle rolling summary tick (LLM + atomic file writes). */
  readonly runChronicleSummary: (
    args: RunChronicleSummaryArgs,
  ) => Effect.Effect<ChronicleSummaryResult, Error>;

  /** Effect-native Dream inbox over a session's sqlite handle. */
  readonly dreamInbox: (db: SqliteDatabase) => DreamInboxEffects;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/kernel/memory/MemoryService",
) {}

export const make = (): Interface => ({
  ensureDreamMemoryLayout: ensureDreamMemoryLayoutEffect,
  assertSafeDreamMemoryRoot: assertSafeDreamMemoryRootEffect,
  readMemoryFile: readMemoryFileEffect,
  readMemoryMap: readMemoryMapEffect,
  rotateMemoryFileIfNeeded: rotateMemoryFileIfNeededEffect,
  appendSupersededMemoryText: appendSupersededMemoryTextEffect,
  listMemoryArchiveFiles: listMemoryArchiveFilesEffect,
  applyUserProfileOperation: applyUserProfileOperationEffect,
  readUserProfile: readUserProfileEffect,
  readCoreMemory: readCoreMemoryEffect,
  readMemoryMapDoc: readMemoryMapDocEffect,
  readUserProfileDoc: readUserProfileDocEffect,
  readStartupDocBodyFromDisk: readStartupDocBodyFromDiskEffect,
  runChronicleSummary: runChronicleSummaryEffect,
  dreamInbox: makeDreamInboxEffects,
});

export const layer = Layer.effect(Service, Effect.sync(make));
