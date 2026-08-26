import { Cause } from "effect";

/**
 * Tagged failures for the Stella-home subsystem. The plain-Promise facades
 * (stella-home.ts, device.ts, and related modules) rethrow failures
 * across the Effect boundary via `Cause.squash`, so every escaping `message`
 * is byte-identical to the string the pre-Effect implementation threw.
 * Do not reword them.
 */

/**
 * Recover the original failure from a Cause so the Promise facades reject
 * with the same object the Effect failed with (tagged error, fs error, …).
 * Mirrors `host/lifecycle/errors.ts` — `Cause.squash` preserves the
 * `message` every caller and log line observes.
 */
export const causeToThrowable = (cause: Cause.Cause<unknown>): unknown =>
  Cause.squash(cause);
