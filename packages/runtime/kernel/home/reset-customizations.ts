import { promises as fs } from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "../shared/private-fs.js";
import { listBundledSkillIds } from "./bundled-skills.js";

export type ResetCustomizationsResult = {
  movedEntries: string[];
  trashDir: string | null;
};

const listMarkdownFiles = async (dir: string): Promise<string[]> => {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

const listDirectories = async (dir: string): Promise<string[]> => {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

export const resetStellaCustomizations = async (
  stellaDataDir: string,
): Promise<ResetCustomizationsResult> => {
  const candidates: string[] = [];

  for (const area of ["agents", "prompts"] as const) {
    for (const name of await listMarkdownFiles(
      path.join(stellaDataDir, area),
    )) {
      candidates.push(path.join(area, name));
    }
  }

  try {
    await fs.access(path.join(stellaDataDir, "PERSONALITY.md"));
    candidates.push("PERSONALITY.md");
  } catch {}

  const bundledSkillIds = new Set(await listBundledSkillIds(stellaDataDir));
  for (const id of await listDirectories(path.join(stellaDataDir, "skills"))) {
    if (bundledSkillIds.has(id)) {
      candidates.push(path.join("skills", id));
    }
  }

  if (candidates.length === 0) {
    return { movedEntries: [], trashDir: null };
  }

  const trashDir = path.join(
    stellaDataDir,
    ".trash",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  const moved: string[] = [];
  for (const relPath of candidates) {
    const source = path.join(stellaDataDir, relPath);
    const target = path.join(trashDir, relPath);
    try {
      await ensurePrivateDir(path.dirname(target));
      await fs.rename(source, target);
      moved.push(relPath);
    } catch {

      try {
        await fs.cp(source, target, { recursive: true });
        await fs.rm(source, { recursive: true, force: true });
        moved.push(relPath);
      } catch {}
    }
  }
  return { movedEntries: moved, trashDir: moved.length > 0 ? trashDir : null };
};
