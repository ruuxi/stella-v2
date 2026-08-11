import fs from "node:fs";
import path from "node:path";

import { resolveRuntimeSourceAsset } from "../shared/runtime-paths.js";

const promptsDir = (): string =>
  process.env.STELLA_RUNTIME_PROMPTS_DIR?.trim() ||
  resolveRuntimeSourceAsset("extensions", "stella-runtime", "prompts");

/**
 * Auxiliary prompt lookup from the bundled `stella-runtime/prompts/` tree.
 * Prompts ship with the app and are not user-customizable; the env override
 * exists for tests.
 */
export const readRuntimePrompt = (id: string): string | undefined => {
  try {
    const content = fs
      .readFileSync(path.join(promptsDir(), `${id}.md`), "utf-8")
      .trim();
    return content || undefined;
  } catch {
    return undefined;
  }
};
