import { Cause, Schema } from "effect";

/**
 * Tagged failures for the Stella-home subsystem. The plain-Promise facades
 * (stella-home.ts, prompt-manifest-sync.ts, device.ts, …) rethrow these
 * across the Effect boundary via `Cause.squash`, so every escaping `message`
 * is byte-identical to the string the pre-Effect implementation threw.
 * Do not reword them.
 */

const AppliedPromptStateSchema = Schema.Struct({
  endpoint: Schema.String,
  publishedAt: Schema.Number,
  revision: Schema.String,
});

/**
 * A concurrent writer durably applied a newer prompt publication while this
 * one was being recorded. Control-flow error: `ensureStellaDataDirSeeded` and
 * `syncStellaPromptSnapshot` catch it (by instanceof) and continue with an
 * empty personality report. Keeps the pre-Effect `name`, `message`, and
 * `candidate`/`winner` fields.
 */
export class StalePromptManifestError extends Schema.TaggedErrorClass<StalePromptManifestError>()(
  "@stella/runtime/home/StalePromptManifestError",
  { candidate: AppliedPromptStateSchema, winner: AppliedPromptStateSchema },
) {
  override get name(): string {
    return "StalePromptManifestError";
  }
  override get message() {
    return `Prompt publication ${this.candidate.publishedAt}/${this.candidate.revision} is stale; durable maximum is ${this.winner.publishedAt}/${this.winner.revision}`;
  }
}

/** A resolved prompt manifest arrived without the endpoint it came from. */
export class PromptEndpointMissingError extends Schema.TaggedErrorClass<PromptEndpointMissingError>()(
  "@stella/runtime/home/PromptEndpointMissingError",
  {},
) {
  override get message() {
    return "Resolved prompt manifest is missing its endpoint";
  }
}

/** Applied-state record serialization exceeded its durability size budget. */
export class AppliedStateRecordTooLargeError extends Schema.TaggedErrorClass<AppliedStateRecordTooLargeError>()(
  "@stella/runtime/home/AppliedStateRecordTooLargeError",
  {},
) {
  override get message() {
    return "Prompt applied-state record exceeds the size limit";
  }
}

/** An existing applied-state record disagrees with the one being written. */
export class AppliedStateRecordCollisionError extends Schema.TaggedErrorClass<AppliedStateRecordCollisionError>()(
  "@stella/runtime/home/AppliedStateRecordCollisionError",
  {},
) {
  override get message() {
    return "Prompt applied-state record collision";
  }
}

/** The durable read-back after an applied-state write found nothing. */
export class AppliedStateVanishedError extends Schema.TaggedErrorClass<AppliedStateVanishedError>()(
  "@stella/runtime/home/AppliedStateVanishedError",
  {},
) {
  override get message() {
    return "Applied prompt state vanished after write";
  }
}

/** Neither node:sqlite nor bun:sqlite could be resolved at runtime. */
export class SqliteRuntimeUnavailableError extends Schema.TaggedErrorClass<SqliteRuntimeUnavailableError>()(
  "@stella/runtime/home/SqliteRuntimeUnavailableError",
  {},
) {
  override get message() {
    return "No compatible SQLite runtime is available.";
  }
}

/** Bundled agent metadata lacked the frontmatter block remote sync joins on. */
export class AgentMetadataFrontmatterError extends Schema.TaggedErrorClass<AgentMetadataFrontmatterError>()(
  "@stella/runtime/home/AgentMetadataFrontmatterError",
  { id: Schema.String },
) {
  override get message() {
    return `Agent metadata ${this.id} is missing valid frontmatter`;
  }
}

/**
 * Recover the original failure from a Cause so the Promise facades reject
 * with the same object the Effect failed with (tagged error, fs error, …).
 * Mirrors `host/lifecycle/errors.ts` — `Cause.squash` preserves the
 * `message` every caller and log line observes.
 */
export const causeToThrowable = (cause: Cause.Cause<unknown>): unknown =>
  Cause.squash(cause);
