import * as Cause from "effect/Cause";
import * as Data from "effect/Data";

/**
 * Tagged failures for the Stella-home subsystem. The plain-Promise facades
 * (stella-home.ts, prompt-manifest-sync.ts, device.ts, …) rethrow these
 * across the Effect boundary via `Cause.squash`, so every escaping `message`
 * is byte-identical to the string the pre-Effect implementation threw.
 * Do not reword them.
 */

type AppliedPromptState = {
  readonly endpoint: string;
  readonly publishedAt: number;
  readonly revision: string;
};

/**
 * A concurrent writer durably applied a newer prompt publication while this
 * one was being recorded. Control-flow error: `ensureStellaDataDirSeeded` and
 * `syncStellaPromptSnapshot` catch it (by instanceof) and continue with an
 * empty personality report. Keeps the pre-Effect `name`, `message`, and
 * `candidate`/`winner` fields.
 */
export class StalePromptManifestError extends Data.TaggedError(
  "@stella/runtime/home/StalePromptManifestError",
)<{
  readonly candidate: AppliedPromptState;
  readonly winner: AppliedPromptState;
}> {
  override get name(): string {
    return "StalePromptManifestError";
  }
  override get message() {
    return `Prompt publication ${this.candidate.publishedAt}/${this.candidate.revision} is stale; durable maximum is ${this.winner.publishedAt}/${this.winner.revision}`;
  }
}

/** A resolved prompt manifest arrived without the endpoint it came from. */
export class PromptEndpointMissingError extends Data.TaggedError(
  "@stella/runtime/home/PromptEndpointMissingError",
) {
  override get message() {
    return "Resolved prompt manifest is missing its endpoint";
  }
}

/** Applied-state record serialization exceeded its durability size budget. */
export class AppliedStateRecordTooLargeError extends Data.TaggedError(
  "@stella/runtime/home/AppliedStateRecordTooLargeError",
) {
  override get message() {
    return "Prompt applied-state record exceeds the size limit";
  }
}

/** An existing applied-state record disagrees with the one being written. */
export class AppliedStateRecordCollisionError extends Data.TaggedError(
  "@stella/runtime/home/AppliedStateRecordCollisionError",
) {
  override get message() {
    return "Prompt applied-state record collision";
  }
}

/** The durable read-back after an applied-state write found nothing. */
export class AppliedStateVanishedError extends Data.TaggedError(
  "@stella/runtime/home/AppliedStateVanishedError",
) {
  override get message() {
    return "Applied prompt state vanished after write";
  }
}

/** Neither node:sqlite nor bun:sqlite could be resolved at runtime. */
export class SqliteRuntimeUnavailableError extends Data.TaggedError(
  "@stella/runtime/home/SqliteRuntimeUnavailableError",
) {
  override get message() {
    return "No compatible SQLite runtime is available.";
  }
}

/** Bundled agent metadata lacked the frontmatter block remote sync joins on. */
export class AgentMetadataFrontmatterError extends Data.TaggedError(
  "@stella/runtime/home/AgentMetadataFrontmatterError",
)<{ readonly id: string }> {
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
