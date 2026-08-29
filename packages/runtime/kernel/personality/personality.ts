/**
 * Stella's voice and register, injected as a hidden startup doc on the first
 * orchestrator turn.
 *
 * Composition is live and mirrors the agent-prompt customization model:
 *
 * - `~/.stella/PERSONALITY.md`, when present, is the user's replacement and is
 *   used verbatim — hand edits always win.
 * - Otherwise the content comes straight from the bundled
 *   `stella-runtime/prompts/personality.md` (via `readRuntimePrompt`), so
 *   shipped updates apply automatically with no reconciliation.
 *
 * A hand edit takes effect on the next fresh conversation, not mid-thread.
 */

import fs from "node:fs";
import path from "node:path";
import { readRuntimePrompt } from "../prompts/home-prompts.js";

const PERSONALITY_FILE_RELATIVE = "PERSONALITY.md";

const personalityFilePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, PERSONALITY_FILE_RELATIVE);

const bundledPersonality = (): string => {
  const content = readRuntimePrompt("personality");
  return content?.trim() ?? "";
};

export const readOrSeedPersonality = (stellaDataDir: string): string => {
  try {
    const existing = fs
      .readFileSync(personalityFilePath(stellaDataDir), "utf-8")
      .trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch {
    // Missing or unreadable file falls through to the bundled prompt.
  }

  // Reading never materializes a file, so shipped updates keep flowing.
  return bundledPersonality();
};
