/**
 * `~/.stella/PERSONALITY.md` — Stella's selected voice/register, injected as a
 * hidden startup doc on the first orchestrator turn (the same path core memory
 * takes) rather than into the system prompt every turn.
 *
 * Lifecycle:
 * - Seeded on first read from the selected preset (or the Stella default when
 *   no preference is set).
 * - Overwritten when the user picks a preset in onboarding or settings.
 * - Read into the agent context at turn start; injected as a startup doc on the
 *   conversation's first turn, then replayed from persisted history. A new
 *   preset (or hand edit) therefore takes effect on the next fresh
 *   conversation, not mid-thread.
 *
 * The file is plain markdown so power users can edit it freely. On each read we
 * use whatever is on disk verbatim — never re-compose from a preset if the file
 * already exists.
 *
 * Effect-native internals (M5): a `Personality` service composed over the
 * `LocalPreferences` layer, run by one module-level `ManagedRuntime`. The
 * exported functions keep their synchronous plain-TS signatures; failures
 * rethrow the ORIGINAL error object via `Cause.squash` so escaping messages
 * stay byte-identical (host/lifecycle.ts pattern).
 */

import fs from "node:fs";
import path from "node:path";
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime } from "effect";
import {
  coercePersonalityId,
  type PersonalityId,
} from "@stella/contracts/personality";
import * as LocalPreferences from "../preferences/local-preferences.js";
import {
  resolvePersonalityPresetContent,
  writePersonalityTransaction,
} from "../home/personality-sync.js";

const PERSONALITY_FILE_RELATIVE = "PERSONALITY.md";

const personalityFilePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, PERSONALITY_FILE_RELATIVE);

const composePersonalityContent = (
  stellaDataDir: string,
  id: PersonalityId,
): string => resolvePersonalityPresetContent(stellaDataDir, id);

// ── Effect service ────────────────────────────────────────────────────────

export interface Interface {
  readonly readOrSeed: (stellaDataDir: string) => Effect.Effect<string>;
  readonly write: (
    stellaDataDir: string,
    id: PersonalityId,
  ) => Effect.Effect<string, unknown>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/kernel/Personality",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const preferences = yield* LocalPreferences.Service;

    const readOrSeed = Effect.fn("Personality.readOrSeed")(function* (
      stellaDataDir: string,
    ) {
      const filePath = personalityFilePath(stellaDataDir);
      const existing = yield* Effect.try({
        try: () => fs.readFileSync(filePath, "utf-8").trim(),
        catch: (error) => error,
      }).pipe(
        // Missing/unreadable file falls through to the seed path.
        Effect.catch(() => Effect.succeed(null)),
      );
      if (existing !== null && existing.length > 0) {
        return existing;
      }

      const prefs = yield* preferences.load(stellaDataDir);
      const selectedId = coercePersonalityId(prefs.personalityVoiceId);
      const seeded = yield* Effect.sync(() =>
        composePersonalityContent(stellaDataDir, selectedId),
      );
      if (!seeded) return "";
      yield* Effect.try({
        try: () => writePersonalityTransaction(stellaDataDir, selectedId, seeded),
        catch: (error) => error,
      }).pipe(
        // Seeding is best-effort; the live string is still returned below.
        Effect.catch(() => Effect.void),
      );
      return seeded.trim();
    });

    const write = Effect.fn("Personality.write")(function* (
      stellaDataDir: string,
      id: PersonalityId,
    ) {
      const content = yield* Effect.sync(() =>
        composePersonalityContent(stellaDataDir, id),
      );
      if (!content) return "";
      // Write failures propagate the ORIGINAL error to the caller.
      yield* Effect.try({
        try: () => writePersonalityTransaction(stellaDataDir, id, content),
        catch: (error) => error,
      });
      return content.trim();
    });

    return { readOrSeed, write };
  }),
).pipe(Layer.provide(LocalPreferences.layer));

// ── Sync facade over one module-level ManagedRuntime ──────────────────────

const personalityRuntime = ManagedRuntime.make(layer);

/** Run a personality Effect, rethrowing the original failure object. */
const runPersonality = <A, E>(effect: Effect.Effect<A, E, Service>): A => {
  const exit = personalityRuntime.runSyncExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/**
 * Read the persisted personality file, seeding it on first access from the
 * backend-synchronized preset selected by the user. If prompt sync has not
 * produced that preset yet, leave the file absent.
 */
export const readOrSeedPersonality = (stellaDataDir: string): string =>
  runPersonality(
    Effect.gen(function* () {
      const service = yield* Service;
      return yield* service.readOrSeed(stellaDataDir);
    }),
  );

/**
 * Overwrite `~/.stella/PERSONALITY.md` with the given preset. Used when the
 * user picks a personality in onboarding or settings.
 */
export const writePersonality = (
  stellaDataDir: string,
  id: PersonalityId,
): string =>
  runPersonality(
    Effect.gen(function* () {
      const service = yield* Service;
      return yield* service.write(stellaDataDir, id);
    }),
  );

export const getPersonalityFilePath = (stellaDataDir: string): string =>
  personalityFilePath(stellaDataDir);
