import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(workerRoot, "..", "..");
const imageRoot = path.join(workerRoot, ".image");

await rm(imageRoot, { recursive: true, force: true });
await mkdir(path.join(imageRoot, "packages"), { recursive: true });

const imagePackages = [
  "app-template",
  "apps-sdk",
  "contracts",
  "runtime",
  "executor-cloud",
  // Document CLI. Only the wrapper + download scripts are staged; the native
  // binary is fetched for the image's own platform during the Docker build.
  "stella-office",
];

/**
 * Files that must never reach the image. The checked-in stella-office
 * binaries are macOS-only (60 MB of dead weight in a Linux container) and its
 * vendor tree is the OfficeCLI C# source, which nothing at runtime reads.
 */
const isExcluded = (source) =>
  source.includes(`${path.sep}node_modules${path.sep}`) ||
  source.includes(`${path.sep}.git${path.sep}`) ||
  source.includes(`${path.sep}stella-office${path.sep}vendor`) ||
  path.basename(source).startsWith("stella-office-darwin-");

const rootPackage = JSON.parse(
  await readFile(path.join(repoRoot, "package.json"), "utf8"),
);
const imagePackage = {
  name: "stella-cloud-executor-image",
  private: true,
  type: "module",
  workspaces: imagePackages.map((name) => `packages/${name}`),
  dependencies: rootPackage.dependencies,
};

await writeFile(
  path.join(imageRoot, "package.json"),
  `${JSON.stringify(imagePackage, null, 2)}\n`,
);

for (const packageName of imagePackages) {
  await cp(
    path.join(repoRoot, "packages", packageName),
    path.join(imageRoot, "packages", packageName),
    { recursive: true, filter: (source) => !isExcluded(source) },
  );
}
