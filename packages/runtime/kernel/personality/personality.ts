/**
 * Stella's selected voice/register, injected as a hidden startup doc on the
 * first orchestrator turn.
 *
 * Composition is live and mirrors the agent-prompt customization model:
 *
 * - `~/.stella/PERSONALITY.md`, when present, is the user's replacement and is
 *   used verbatim — hand edits always win.
 * - Otherwise the content comes straight from the bundled preset under
 *   `stella-runtime/prompts/personality-<id>.md` (via `readRuntimePrompt`),
 *   so shipped preset updates apply automatically with no reconciliation.
 *
 * Picking a preset in onboarding or settings just updates the preference and
 * clears any replacement file. A new preset (or hand edit) takes effect on the
 * next fresh conversation, not mid-thread.
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
import { readRuntimePrompt } from "../prompts/home-prompts.js";

const PERSONALITY_FILE_RELATIVE = "PERSONALITY.md";

const personalityFilePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, PERSONALITY_FILE_RELATIVE);

export const resolvePersonalityPresetContent = (
  stellaDataDir: string,
  id: PersonalityId,
): string => {
  const content = readRuntimePrompt(`personality-${id}`);
  return content ? `${content.trim()}\n` : "";
};

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
        // Missing/unreadable file falls through to the preset path.
        Effect.catch(() => Effect.succeed(null)),
      );
      if (existing !== null && existing.length > 0) {
        return existing;
      }

      // Reading never materializes a file — the preset is composed live from
      // the bundled prompts, so shipped preset updates keep flowing.
      const prefs = yield* preferences.load(stellaDataDir);
      const selectedId = coercePersonalityId(prefs.personalityVoiceId);
      return yield* Effect.sync(() =>
        resolvePersonalityPresetContent(stellaDataDir, selectedId).trim(),
      );
    });

    const write = Effect.fn("Personality.write")(function* (
      stellaDataDir: string,
      id: PersonalityId,
    ) {
      // Picking a preset is an explicit choice: it clears any user replacement
      // file. Removal is best-effort; the preset content is still returned.
      yield* Effect.try({
        try: () =>
          fs.rmSync(personalityFilePath(stellaDataDir), { force: true }),
        catch: (error) => error,
      }).pipe(Effect.catch(() => Effect.void));
      return yield* Effect.sync(() =>
        resolvePersonalityPresetContent(stellaDataDir, id).trim(),
      );
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
 * Read the personality: the user's `PERSONALITY.md` when present, else the
 * selected preset composed live from the system mirror.
 */
export const readOrSeedPersonality = (stellaDataDir: string): string =>
  runPersonality(
    Effect.gen(function* () {
      const service = yield* Service;
      return yield* service.readOrSeed(stellaDataDir);
    }),
  );

/**
 * Apply a preset pick from onboarding or settings: the preset becomes live
 * immediately by clearing any user replacement file. (The preference itself is
 * persisted by the caller alongside this.)
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
