import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const COMMON_BUNDLED_SKILL_IDS = [
  "humanizer",
  "pdf",
  "skill-creator",
  "stella-browser",
  "stella-connect-mcp",
  "stella-design",
  "stella-media",
  "stella-office",
  "x-api",
  "youtube-content",
];

export const PLATFORM_BUNDLED_SKILL_IDS = {
  darwin: ["apple-notes", "apple-reminders", "stella-computer-macos"],
  linux: [],
  win32: ["stella-computer-windows"],
};

export const ALL_BUNDLED_SKILL_IDS = [
  ...COMMON_BUNDLED_SKILL_IDS,
  ...Object.values(PLATFORM_BUNDLED_SKILL_IDS).flat(),
].sort((a, b) => a.localeCompare(b));

const listDirectories = async (root) =>
  (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

const assertExactIds = (actual, expected, label) => {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `${label} mismatch. Expected [${expected.join(", ")}], received [${actual.join(", ")}].`,
    );
  }
};

export const packagedSkillIdsForPlatform = (platform) => {
  const platformIds = PLATFORM_BUNDLED_SKILL_IDS[platform];
  if (!platformIds) {
    throw new Error(`Unsupported Electron packaging platform: ${platform}`);
  }
  return [...COMMON_BUNDLED_SKILL_IDS, ...platformIds].sort((a, b) =>
    a.localeCompare(b),
  );
};

export const stageHomeSeed = async ({
  platform,
  sourceRoot = path.join(REPO_ROOT, "packages", "home-seed"),
  targetRoot = path.join(
    REPO_ROOT,
    "packages",
    "desktop",
    ".packaging",
    "home-seed",
  ),
} = {}) => {
  const expectedSourceIds = ALL_BUNDLED_SKILL_IDS;
  const sourceSkillsRoot = path.join(sourceRoot, "skills");
  const actualSourceIds = await listDirectories(sourceSkillsRoot);
  assertExactIds(
    actualSourceIds,
    expectedSourceIds,
    "Bundled skill source payload",
  );

  const packagedIds = packagedSkillIdsForPlatform(platform);
  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(targetRoot, "skills"), { recursive: true });
  await fs.mkdir(path.join(targetRoot, "outputs"), { recursive: true });

  await Promise.all([
    fs.copyFile(
      path.join(sourceRoot, "DREAM.md"),
      path.join(targetRoot, "DREAM.md"),
    ),
    fs.copyFile(
      path.join(sourceRoot, "outputs", "README.md"),
      path.join(targetRoot, "outputs", "README.md"),
    ),
    ...packagedIds.map((id) =>
      fs.cp(
        path.join(sourceSkillsRoot, id),
        path.join(targetRoot, "skills", id),
        { recursive: true, force: true },
      ),
    ),
  ]);

  const stagedIds = await listDirectories(path.join(targetRoot, "skills"));
  assertExactIds(stagedIds, packagedIds, `Staged ${platform} skill payload`);
  return { packagedIds, targetRoot };
};

export const verifyPackagedHomeSeed = async ({ resourcesRoot, platform }) => {
  const expectedIds = packagedSkillIdsForPlatform(platform);
  const packagedRoot = path.join(resourcesRoot, "home-seed");
  const actualIds = await listDirectories(path.join(packagedRoot, "skills"));
  assertExactIds(actualIds, expectedIds, `Packaged ${platform} skill payload`);
  await Promise.all([
    fs.access(path.join(packagedRoot, "DREAM.md")),
    fs.access(path.join(packagedRoot, "outputs", "README.md")),
  ]);
  return { actualIds, packagedRoot };
};
