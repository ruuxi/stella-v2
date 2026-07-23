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

const rootPackage = JSON.parse(
  await readFile(path.join(repoRoot, "package.json"), "utf8"),
);
const imagePackage = {
  name: "stella-cloud-executor-image",
  private: true,
  type: "module",
  workspaces: [
    "packages/app-template",
    "packages/apps-sdk",
    "packages/contracts",
    "packages/runtime",
    "packages/executor-cloud",
  ],
  dependencies: rootPackage.dependencies,
};

await writeFile(
  path.join(imageRoot, "package.json"),
  `${JSON.stringify(imagePackage, null, 2)}\n`,
);

for (const packageName of ["app-template", "apps-sdk", "contracts", "runtime", "executor-cloud"]) {
  await cp(
    path.join(repoRoot, "packages", packageName),
    path.join(imageRoot, "packages", packageName),
    {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}node_modules${path.sep}`) &&
        !source.includes(`${path.sep}.git${path.sep}`),
    },
  );
}
