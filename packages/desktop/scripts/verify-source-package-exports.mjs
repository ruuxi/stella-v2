import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = import.meta.dirname;
const repoRootDir = path.resolve(scriptDir, "..", "..", "..");

const toPosix = (value) => value.split(path.sep).join("/");

const walkFiles = (rootDir) => {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };
  visit(rootDir);
  return files;
};

const resolveExportTarget = (exportsMap, subpath) => {
  const exact = exportsMap[subpath];
  if (typeof exact === "string") {
    return exact;
  }

  const patterns = Object.entries(exportsMap)
    .filter(
      ([key, target]) =>
        key.includes("*") && typeof target === "string" && target.includes("*"),
    )
    .sort(([a], [b]) => b.length - a.length);
  for (const [key, target] of patterns) {
    const starIndex = key.indexOf("*");
    const prefix = key.slice(0, starIndex);
    const suffix = key.slice(starIndex + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) {
      continue;
    }
    const matched = subpath.slice(
      prefix.length,
      subpath.length - suffix.length,
    );
    return target.replace("*", matched);
  }
  return null;
};

export const collectSourcePackageExportErrors = ({
  packageDir,
  sourceRoot,
  requireExtensionless,
}) => {
  const packageJsonPath = path.join(packageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const exportsMap = packageJson.exports ?? {};
  const errors = [];

  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (
      typeof target !== "string" ||
      subpath.includes("*") ||
      target.includes("*")
    ) {
      continue;
    }
    const absoluteTarget = path.resolve(packageDir, target);
    if (!existsSync(absoluteTarget)) {
      errors.push(`${subpath} targets missing file ${target}`);
    }
  }

  const convertedFiles = walkFiles(sourceRoot).filter((file) =>
    file.endsWith(".js"),
  );
  for (const file of convertedFiles) {
    const relativePath = toPosix(path.relative(packageDir, file));
    const expectedTarget = `./${relativePath}`;
    const subpaths = [`./${relativePath}`];
    if (requireExtensionless) {
      subpaths.push(`./${relativePath.slice(0, -3)}`);
    }
    for (const subpath of subpaths) {
      const target = resolveExportTarget(exportsMap, subpath);
      if (target !== expectedTarget) {
        errors.push(
          `${subpath} must resolve to ${expectedTarget}, got ${target ?? "no export"}`,
        );
      }
    }
  }

  return errors;
};

export const verifySourcePackageExports = ({ rootDir = repoRootDir } = {}) => {
  const configurations = [
    {
      name: "@stella/runtime",
      packageDir: path.join(rootDir, "packages", "runtime"),
      sourceRoot: path.join(rootDir, "packages", "runtime"),
      requireExtensionless: true,
    },
    {
      name: "@stella/desktop",
      packageDir: path.join(rootDir, "packages", "desktop"),
      sourceRoot: path.join(rootDir, "packages", "desktop", "electron"),
      requireExtensionless: false,
    },
  ];

  const failures = configurations.flatMap((configuration) =>
    collectSourcePackageExportErrors(configuration).map(
      (error) => `${configuration.name}: ${error}`,
    ),
  );
  if (failures.length > 0) {
    throw new Error(
      `Workspace package export verification failed:\n${failures
        .map((failure) => `- ${failure}`)
        .join("\n")}`,
    );
  }
};

const isRunDirectly = (() => {
  try {
    return (
      path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();

if (isRunDirectly) {
  try {
    verifySourcePackageExports();
    console.log(
      "[verify-source-package-exports] converted JS exports resolve to real source files.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
