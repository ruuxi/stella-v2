/**
 * Collect All User Signals
 *
 * Orchestrates bounded collection of all user signal sources,
 * organized into 4 onboarding-selectable categories:
 *
 * Category 1 (browsing_bookmarks): Browser history + bookmarks + Safari + Firefox
 * Category 2 (dev_environment): Dev projects + shell + git config + dotfiles
 * Category 3 (apps_system): Apps + Screen Time + Dock + filesystem + Steam + Music
 * Category 4 (messages_notes): iMessage + Notes + Reminders + Calendar (opt-in)
 *
 * This module is the plain-Promise facade over `service.ts`
 * (DiscoveryService): same exported names, signatures, result shapes, and
 * error behavior as the pre-Effect implementation. The fan-out itself —
 * `Effect.forEach` with an explicit concurrency cap (default 1, the old
 * sequential loop) and an optional per-collector timeout (default none) —
 * lives in the service; Effect types never cross this boundary.
 */

import { Effect } from "effect";
import { runDiscovery } from "./effect-io.js";
import * as DiscoveryService from "./service.js";

import type { AllUserSignalsResult } from "./types.js";
import type { DiscoveryCategory } from "@stella/contracts/discovery";
import type {
  DiscoveryCollectionOptions,
  ExtendedUserSignals,
} from "./service.js";

export type { DiscoveryCollectionOptions, ExtendedUserSignals };

const discovery = DiscoveryService.make();

// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------

/**
 * Collect all user signals, filtered by selected categories.
 * When `selectedBrowser` is provided, only that browser's collectors run
 * (skips Firefox, Safari, and generic bookmarks scan for other browsers).
 */
export const collectAllUserSignals = async (
  StellaDataDir: string,
  categories: DiscoveryCategory[] = DiscoveryService.DEFAULT_CATEGORIES,
  selectedBrowser?: string | null,
  selectedProfile?: string | null,
  options?: DiscoveryCollectionOptions,
): Promise<ExtendedUserSignals> =>
  runDiscovery(
    Effect.gen(function* () {
      const service = yield* DiscoveryService.Service;
      return yield* service.collectAllUserSignals(
        StellaDataDir,
        categories,
        selectedBrowser,
        selectedProfile,
        options,
      );
    }).pipe(Effect.provide(DiscoveryService.layer)),
  );

// ---------------------------------------------------------------------------
// IPC Handler Helper
// ---------------------------------------------------------------------------

/**
 * Collect and format all signals - for use in IPC handler
 */
export const collectAllSignals = async (
  StellaDataDir: string,
  categories?: DiscoveryCategory[],
  selectedBrowser?: string | null,
  selectedProfile?: string | null,
  options?: DiscoveryCollectionOptions,
): Promise<AllUserSignalsResult> =>
  runDiscovery(
    Effect.gen(function* () {
      const service = yield* DiscoveryService.Service;
      return yield* service.collectAllSignals(
        StellaDataDir,
        categories,
        selectedBrowser,
        selectedProfile,
        options,
      );
    }).pipe(Effect.provide(DiscoveryService.layer)),
  );
