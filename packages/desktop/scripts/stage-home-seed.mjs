import { createHash } from "node:crypto";
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

const listFilesRecursive = async (root, prefix = "") => {
  const entries = await fs.readdir(path.join(root, prefix), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix
      ? path.posix.join(prefix, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Unsupported bundled payload entry: ${relativePath}`);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
};

const describeFiles = async (root, relativePaths) =>
  Promise.all(
    relativePaths.map(async (relativePath) => {
      const content = await fs.readFile(path.join(root, relativePath));
      return {
        relativePath,
        hash: createHash("sha256").update(content).digest("hex"),
      };
    }),
  );

const describeSelectedSourcePayload = async (sourceRoot, skillIds) => {
  const relativePaths = ["DREAM.md", "outputs/README.md"];
  for (const id of skillIds) {
    const skillRoot = path.join(sourceRoot, "skills", id);
    await fs.access(path.join(skillRoot, "SKILL.md"));
    const skillFiles = await listFilesRecursive(skillRoot);
    relativePaths.push(
      ...skillFiles.map((relativePath) =>
        path.posix.join("skills", id, relativePath),
      ),
    );
  }
  relativePaths.sort((a, b) => a.localeCompare(b));
  return describeFiles(sourceRoot, relativePaths);
};

const payloadHash = (files) => {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath, "utf8");
    hash.update("\0");
    hash.update(file.hash, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
};

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
  const verified = await verifyPackagedHomeSeed({
    resourcesRoot: path.dirname(targetRoot),
    platform,
    sourceRoot,
  });
  return {
    packagedIds,
    targetRoot,
    fileCount: verified.fileCount,
    payloadHash: verified.payloadHash,
  };
};

export const verifyPackagedHomeSeed = async ({
  resourcesRoot,
  platform,
  sourceRoot = path.join(REPO_ROOT, "packages", "home-seed"),
}) => {
  const expectedIds = packagedSkillIdsForPlatform(platform);
  const packagedRoot = path.join(resourcesRoot, "home-seed");
  const actualIds = await listDirectories(path.join(packagedRoot, "skills"));
  assertExactIds(actualIds, expectedIds, `Packaged ${platform} skill payload`);

  await Promise.all(
    expectedIds.map((id) =>
      fs.access(path.join(packagedRoot, "skills", id, "SKILL.md")),
    ),
  );
  const [expectedFiles, actualFiles] = await Promise.all([
    describeSelectedSourcePayload(sourceRoot, expectedIds),
    listFilesRecursive(packagedRoot).then((relativePaths) =>
      describeFiles(packagedRoot, relativePaths),
    ),
  ]);
  const expectedPaths = expectedFiles.map((file) => file.relativePath);
  const actualPaths = actualFiles.map((file) => file.relativePath);
  if (
    expectedPaths.length !== actualPaths.length ||
    expectedPaths.some(
      (relativePath, index) => relativePath !== actualPaths[index],
    )
  ) {
    throw new Error(
      `Packaged ${platform} file list mismatch. Expected [${expectedPaths.join(", ")}], received [${actualPaths.join(", ")}].`,
    );
  }
  for (let index = 0; index < expectedFiles.length; index += 1) {
    const expected = expectedFiles[index];
    const actual = actualFiles[index];
    if (expected.hash !== actual.hash) {
      throw new Error(
        `Packaged ${platform} file hash mismatch at ${expected.relativePath}. Expected ${expected.hash}, received ${actual.hash}.`,
      );
    }
  }

  return {
    actualIds,
    packagedRoot,
    fileCount: actualFiles.length,
    payloadHash: payloadHash(actualFiles),
  };
};
