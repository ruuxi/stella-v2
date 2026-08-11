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
 */

import fs from "node:fs";
import path from "node:path";
import {
  coercePersonalityId,
  type PersonalityId,
} from "@stella/contracts/personality";
import { getPersonalityVoiceId } from "../preferences/local-preferences.js";
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

/**
 * Read the personality: the user's `PERSONALITY.md` when present, else the
 * selected preset composed live from the system mirror.
 */
export const readOrSeedPersonality = (stellaDataDir: string): string => {
  try {
    const existing = fs
      .readFileSync(personalityFilePath(stellaDataDir), "utf-8")
      .trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch {
    // No replacement file; fall through to the preset.
  }

  const selectedId = coercePersonalityId(getPersonalityVoiceId(stellaDataDir));
  return resolvePersonalityPresetContent(stellaDataDir, selectedId).trim();
};

/**
 * Apply a preset pick from onboarding or settings: the preset becomes live
 * immediately by clearing any user replacement file. (The preference itself is
 * persisted by the caller alongside this.)
 */
export const writePersonality = (
  stellaDataDir: string,
  id: PersonalityId,
): string => {
  try {
    fs.rmSync(personalityFilePath(stellaDataDir), { force: true });
  } catch {
    // Removal is best-effort; the preset content below is still returned.
  }
  return resolvePersonalityPresetContent(stellaDataDir, id).trim();
};

export const getPersonalityFilePath = (stellaDataDir: string): string =>
  personalityFilePath(stellaDataDir);
