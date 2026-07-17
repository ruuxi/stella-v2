import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { RETIRED_BUNDLED_SKILL_IDS } from "@stella/runtime/kernel/shared/skill-policy";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../..");
const BUNDLED_SKILLS_DIR = path.join(
  REPO_ROOT,
  "packages",
  "home-seed",
  "skills",
);
const TEXT_EXTENSIONS = new Set([
  "",
  ".json",
  ".md",
  ".py",
  ".sh",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);

const EXPECTED_BUNDLED_SKILL_IDS = [
  "apple-notes",
  "apple-reminders",
  "humanizer",
  "pdf",
  "skill-creator",
  "stella-browser",
  "stella-computer-macos",
  "stella-computer-windows",
  "stella-connect-mcp",
  "stella-design",
  "stella-media",
  "stella-office",
  "x-api",
  "youtube-content",
] as const;

const readTextTree = async (root: string): Promise<string> => {
  const chunks: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (
        entry.isFile() &&
        TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        chunks.push(await readFile(fullPath, "utf-8"));
      }
    }
  };
  await walk(root);
  return chunks.join("\n");
};

describe("bundled skill payload", () => {
  it("ships exactly the supported default skill set", async () => {
    const ids = (await readdir(BUNDLED_SKILLS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    expect(ids).toEqual(EXPECTED_BUNDLED_SKILL_IDS);
  });

  it("contains no retired product-source mutation guidance", async () => {
    const payload = await readTextTree(BUNDLED_SKILLS_DIR);

    for (const retiredId of RETIRED_BUNDLED_SKILL_IDS) {
      expect(payload).not.toContain(retiredId);
    }
    expect(payload).not.toMatch(/desktop\/src\/app\/_[a-z]+/iu);
    expect(payload).not.toContain("packages/desktop-ui");
    expect(payload).not.toContain("runtime/extensions/");
    expect(payload).not.toContain("runtime/home-seed/skills");
    expect(payload).not.toMatch(/modify Stella itself/iu);
    expect(payload).not.toMatch(/change Stella/iu);
  });

  it("does not advertise removed mutation capabilities in bundled prompts", async () => {
    const [readme, realtimePrompt, appsSurface, managerPrompt] =
      await Promise.all([
        readFile(path.join(REPO_ROOT, "README.MD"), "utf-8"),
        readFile(
          path.join(REPO_ROOT, "packages/desktop-ui/src/prompts/catalog.ts"),
          "utf-8",
        ),
        readFile(
          path.join(REPO_ROOT, "packages/desktop-ui/src/app/apps/App.tsx"),
          "utf-8",
        ),
        readFile(
          path.join(
            REPO_ROOT,
            "packages/runtime/extensions/stella-runtime/agent-metadata/manager.md",
          ),
          "utf-8",
        ),
      ]);

    expect(readme).not.toContain("Everything can change");
    expect(readme).not.toContain("ask her to add it");
    expect(readme).not.toContain("install what others have built");
    expect(realtimePrompt).not.toContain("change Stella");
    expect(appsSurface).not.toContain("CREATE_APP_PROMPT");
    expect(appsSurface).not.toMatch(/Ask Stella to (?:build|create) an app/iu);
    expect(managerPrompt).toContain("Installed Stella is not source-mutable");
    expect(managerPrompt).not.toContain("so it can be handled directly");
  });
});
