import { Cause, Schema } from "effect";

/**
 * Tagged failures for the memory subsystem. The plain-Promise/sync facades
 * rethrow these across the Effect boundary via `Cause.squash`, so every
 * escaping message is byte-identical to the string the pre-Effect modules
 * threw. Do not reword them.
 */

/** `assertSafeDreamMemoryRoot` / layout-migration root ownership failures. */
export class DreamMemoryRootError extends Schema.TaggedErrorClass<DreamMemoryRootError>()(
  "@stella/runtime/kernel/memory/DreamMemoryRootError",
  { root: Schema.String, reason: Schema.String },
) {
  override get message() {
    return this.reason === "escaped"
      ? `Refusing Dream memory root ${this.root}: canonical path escaped the Stella data directory.`
      : `Refusing Dream memory root ${this.root}: expected a real directory owned by Stella.`;
  }
}

/**
 * Legacy `memory_index.md` / `memory_summary.md` snapshot failures during the
 * create-only map migration.
 */
export class LegacyMemorySourceError extends Schema.TaggedErrorClass<LegacyMemorySourceError>()(
  "@stella/runtime/kernel/memory/LegacyMemorySourceError",
  { path: Schema.String, reason: Schema.String },
) {
  override get message() {
    switch (this.reason) {
      case "escaped":
        return `Refusing legacy memory source ${this.path}: canonical path escaped the owned memory root.`;
      case "changed_before_read":
        return `Legacy memory source changed before read: ${this.path}.`;
      case "changed_during_read":
        return `Legacy memory source changed during read: ${this.path}.`;
      case "changed_during_migration":
        return `Legacy memory source changed during migration: ${this.path}.`;
      default:
        return `Refusing legacy memory source ${this.path}: expected a stable regular unaliased file.`;
    }
  }
}

/** Crash-recovery failures around the reserved migration staging namespace. */
export class MigrationStagingError extends Schema.TaggedErrorClass<MigrationStagingError>()(
  "@stella/runtime/kernel/memory/MigrationStagingError",
  { path: Schema.String, reason: Schema.String },
) {
  override get message() {
    switch (this.reason) {
      case "tampered_link":
        return `Refusing tampered linked migration staging artifact ${this.path}.`;
      case "recovery_diverged":
        return `Memory migration staging recovery did not converge for ${this.path}.`;
      default:
        return `Refusing unverified memory migration staging artifact ${this.path}.`;
    }
  }
}

/** The live memory/map target is not a plain single-link regular file. */
export class MemoryLayoutConflictError extends Schema.TaggedErrorClass<MemoryLayoutConflictError>()(
  "@stella/runtime/kernel/memory/MemoryLayoutConflictError",
  { target: Schema.String, reason: Schema.String },
) {
  override get message() {
    return this.reason === "unaccounted_aliases"
      ? `Refusing memory layout conflict at ${this.target}: unaccounted hard-link aliases remain.`
      : `Refusing memory layout conflict at ${this.target}: expected a regular unaliased file.`;
  }
}

/** Neither node:sqlite nor bun:sqlite is available for the migration lock. */
export class MigrationSqliteUnavailableError extends Schema.TaggedErrorClass<MigrationSqliteUnavailableError>()(
  "@stella/runtime/kernel/memory/MigrationSqliteUnavailableError",
  {},
) {
  override get message() {
    return "No compatible SQLite runtime is available for memory migration locking.";
  }
}

/** Dream-inbox memory-note validation ("title" / "memory" empty). */
export class MemoryNoteInvalidError extends Schema.TaggedErrorClass<MemoryNoteInvalidError>()(
  "@stella/runtime/kernel/memory/MemoryNoteInvalidError",
  { field: Schema.String },
) {
  override get message() {
    return `${this.field} must not be empty.`;
  }
}

/** 100 key-probe attempts exhausted while inserting a memory note. */
export class MemoryNoteKeyExhaustedError extends Schema.TaggedErrorClass<MemoryNoteKeyExhaustedError>()(
  "@stella/runtime/kernel/memory/MemoryNoteKeyExhaustedError",
  {},
) {
  override get message() {
    return "could not create a unique memory note key.";
  }
}

/**
 * Recover the original failure from a Cause so the facades rethrow the same
 * object the Effect failed with. Mirrors `host/lifecycle/errors.ts`.
 */
export const causeToThrowable = (cause: Cause.Cause<unknown>): unknown =>
  Cause.squash(cause);
