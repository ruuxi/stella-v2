/**
 * Hash-history reconciliation of bundled skills into Stella home.
 *
 * Stella ships a default skill catalogue at the packaged `home-seed/skills/`
 * resource. `${stellaDataDir}/skills/` is the one root every installed skill
 * resolves from, shipped or user-created (see `shared/skill-catalog.ts`). Each
 * skill (`<id>/` directory) is reconciled as a unit so shipped updates reach
 * users who haven't edited that skill, while a local edit or a pre-existing
 * collision makes that skill user-owned and never overwritten. The
 * reconciliation algorithm itself lives in `bundled-sync.ts` — this module just
 * supplies the skill-specific policy (directory units, platform gating,
 * user-profile exclusion).
 */

import type { Effect } from "effect";

import {
  createDirectoryEntryAdapter,
  listTrackedBundledEntryIds,
  reconcileBundledEntriesEffect,
  type BundledSyncReport,
} from "./bundled-sync.js";
import { withHome } from "./home-runtime.js";

// Live re-export (not a top-level binding read): this module sits inside the
// home facade/service import cycle, and reading the binding at evaluation
// time would hit the temporal dead zone depending on entry order.
export { summarizeBundledSync as summarizeSkillsSync } from "./bundled-sync.js";

const USER_PROFILE_SKILL_ID = "user-profile";
const PLATFORM_SKILL_IDS: Partial<Record<NodeJS.Platform, readonly string[]>> =
  {
    darwin: ["stella-computer-macos", "apple-reminders", "apple-notes"],
    win32: ["stella-computer-windows"],
  };
const PLATFORM_EXCLUSIVE_SKILL_IDS = new Set(
  Object.values(PLATFORM_SKILL_IDS).flat(),
);

export type SkillsSyncOptions = {
  platform?: NodeJS.Platform;
};

export type SkillsSyncReport = BundledSyncReport;

const isBundledSkillIncludedForPlatform = (
  skillId: string,
  platform: NodeJS.Platform,
): boolean => {
  if (!PLATFORM_EXCLUSIVE_SKILL_IDS.has(skillId)) {
    return true;
  }
  return PLATFORM_SKILL_IDS[platform]?.includes(skillId) === true;
};

const bundledSkillAdapter = createDirectoryEntryAdapter(
  (id) => id !== USER_PROFILE_SKILL_ID,
);

/**
 * The skill ids this build ships for the running platform. The legacy
 * `system/` mirror retirement needs the same set the reconciler installs, so
 * it can leave those ids to the reconciler instead of pinning stale mirrored
 * copies as user forks.
 */
export const listIncludedBundledSkillIds = async (
  bundledSkillsDir: string,
  options: SkillsSyncOptions = {},
): Promise<Set<string>> => {
  const platform = options.platform ?? process.platform;
  const ids = await bundledSkillAdapter.listIds(bundledSkillsDir);
  return new Set(
    ids.filter((id) => isBundledSkillIncludedForPlatform(id, platform)),
  );
};

/**
 * Reconcile bundled skills into a Stella home skills tree. `user-profile` is
 * intrinsically user-owned onboarding memory and is excluded entirely.
 */
export const reconcileBundledSkillsEffect = (
  bundledSkillsDir: string,
  homeSkillsDir: string,
  options: SkillsSyncOptions = {},
): Effect.Effect<SkillsSyncReport, unknown> => {
  const platform = options.platform ?? process.platform;
  return reconcileBundledEntriesEffect(
    bundledSkillsDir,
    homeSkillsDir,
    bundledSkillAdapter,
    {
      includeBundledId: (id) => isBundledSkillIncludedForPlatform(id, platform),
      // Manifests seeded before the generic rename stored hashes under
      // `skills`; read them so already-installed users still get updates.
      legacyEntriesKey: "skills",
    },
  );
};

export const reconcileBundledSkills = (
  bundledSkillsDir: string,
  homeSkillsDir: string,
  options: SkillsSyncOptions = {},
): Promise<SkillsSyncReport> =>
  withHome((home) =>
    home.reconcileBundledSkills(bundledSkillsDir, homeSkillsDir, options),
  );

/**
 * Skill ids Stella has installed into the canonical root, including ones the
 * user has since edited. "Use Stella's defaults" clears exactly this set and
 * leaves purely user-created skills alone.
 */
export const listTrackedBundledSkillIds = (
  homeSkillsDir: string,
): Promise<string[]> =>
  listTrackedBundledEntryIds(homeSkillsDir, { legacyEntriesKey: "skills" });
