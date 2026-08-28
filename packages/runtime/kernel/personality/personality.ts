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

  }

  return bundledPersonality();
};
