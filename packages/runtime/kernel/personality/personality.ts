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

  const selectedId = coercePersonalityId(getPersonalityVoiceId(stellaDataDir));
  return resolvePersonalityPresetContent(stellaDataDir, selectedId).trim();
};

export const writePersonality = (
  stellaDataDir: string,
  id: PersonalityId,
): string => {
  try {
    fs.rmSync(personalityFilePath(stellaDataDir), { force: true });
  } catch {

  }
  return resolvePersonalityPresetContent(stellaDataDir, id).trim();
};

export const getPersonalityFilePath = (stellaDataDir: string): string =>
  personalityFilePath(stellaDataDir);
