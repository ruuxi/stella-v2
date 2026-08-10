import fs from "node:fs";
import path from "node:path";

const readTrimmed = (filePath: string): string | undefined => {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Auxiliary prompt lookup: a user file under `~/.stella/prompts/` replaces the
 * shipped copy under `~/.stella/system/prompts/` wholesale; otherwise the
 * mirrored copy is used.
 */
export const readHomePrompt = (
  stellaDataDir: string,
  id: string,
): string | undefined =>
  readTrimmed(path.join(stellaDataDir, "prompts", `${id}.md`)) ??
  readTrimmed(path.join(stellaDataDir, "system", "prompts", `${id}.md`));
