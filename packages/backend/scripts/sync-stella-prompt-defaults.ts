import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStellaPromptDefaults,
  generatedPromptDefaultsPath,
} from "./stella-prompt-defaults";

type PromptDefaultsLogger = Pick<Console, "error" | "log">;

export const writeOrCheckStellaPromptDefaults = async ({
  check,
  expectedSource,
  targetPath,
  promptCount,
  revision,
  logger = console,
  temporarySuffix = () => `${process.pid}-${randomUUID()}`,
}: {
  check: boolean;
  expectedSource: string;
  targetPath: string;
  promptCount: number;
  revision: string;
  logger?: PromptDefaultsLogger;
  temporarySuffix?: () => string;
}): Promise<boolean> => {
  if (check) {
    const current = await fs.readFile(targetPath, "utf-8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (current !== expectedSource) {
      logger.error(
        "Stella prompt defaults are stale. Run `bun run prompts:sync-defaults`.",
      );
      return false;
    }
    logger.log(`Verified ${promptCount} prompts at revision ${revision}.`);
    return true;
  }

  const tempPath = `${targetPath}.tmp-${temporarySuffix()}`;
  try {
    await fs.writeFile(tempPath, expectedSource, {
      encoding: "utf-8",
      flag: "wx",
    });
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  logger.log(`Synced ${promptCount} prompts at revision ${revision}.`);
  return true;
};

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";
  if (args.length > 0 && !check) {
    throw new Error("Usage: sync-stella-prompt-defaults.ts [--check]");
  }

  const { snapshot, source } = await buildStellaPromptDefaults();
  const current = await writeOrCheckStellaPromptDefaults({
    check,
    expectedSource: source,
    targetPath: generatedPromptDefaultsPath,
    promptCount: snapshot.prompts.length,
    revision: snapshot.revision,
  });
  if (!current) process.exitCode = 1;
}
