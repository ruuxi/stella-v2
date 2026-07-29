import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
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

// This package is not an executor dependency and therefore is deliberately
// not in the image's Bun workspace list. It is immutable seed material copied
// into a user's first `workspace: "stella"` sandbox. Keeping it outside the
// runtime workspace prevents its desktop-only devDependencies from becoming
// cloud-image dependencies.
const imageSourcePackages = ["desktop-ui"];

/**
 * Files that must never reach the image. The checked-in stella-office
 * binaries are macOS-only (60 MB of dead weight in a Linux container) and its
 * vendor tree is the OfficeCLI C# source, which nothing at runtime reads.
 */
const isExcluded = (source) =>
  source.split(path.sep).includes("node_modules") ||
  source.includes(`${path.sep}.git${path.sep}`) ||
  source.includes(`${path.sep}stella-office${path.sep}vendor`) ||
  source.includes(`${path.sep}desktop-ui${path.sep}dist`) ||
  (source.includes(`${path.sep}desktop-ui${path.sep}`) &&
    path.basename(source).startsWith(".env") &&
    path.basename(source) !== ".env") ||
  path.basename(source).startsWith("stella-office-darwin-");

const rootPackage = JSON.parse(
  await readFile(path.join(repoRoot, "package.json"), "utf8"),
);
const exactVersion = (value, label) => {
  const exact = typeof value === "string" ? value.replace(/^[~^]/, "") : "";
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(exact)) {
    throw new Error(`Cloud image ${label} must resolve from a pinned version.`);
  }
  return exact;
};
const imagePackage = {
  name: "stella-cloud-executor-image",
  private: true,
  type: "module",
  workspaces: imagePackages.map((name) => `packages/${name}`),
  dependencies: {
    ...rootPackage.dependencies,
    // Native coding-agent runtimes. These exact versions are part of the
    // sandbox image contract: cloud turns must not change behavior merely
    // because a registry dist-tag moved between image builds.
    "@anthropic-ai/claude-code": "2.1.220",
    "@openai/codex": "0.146.0",
    // The immutable interior config uses Vite 8's rolldownOptions. Pin the
    // same builder pair used by this checkout instead of accidentally taking
    // app-template's older production Vite through workspace resolution.
    vite: exactVersion(rootPackage.devDependencies.vite, "Vite"),
    "@vitejs/plugin-react": exactVersion(
      rootPackage.devDependencies["@vitejs/plugin-react"],
      "React plugin",
    ),
  },
};

await writeFile(
  path.join(imageRoot, "package.json"),
  `${JSON.stringify(imagePackage, null, 2)}\n`,
);

for (const packageName of [...imagePackages, ...imageSourcePackages]) {
  await cp(
    path.join(repoRoot, "packages", packageName),
    path.join(imageRoot, "packages", packageName),
    { recursive: true, filter: (source) => !isExcluded(source) },
  );
}

/**
 * Hash the exact staged source tree, not the working checkout. The digest is
 * the base revision of a first cold Stella workspace and is copied into the
 * image beside the seed. The in-container builder uses the same canonical
 * `path NUL size NUL sha256 LF` aggregate for later source revisions.
 */
const sourceRoot = path.join(imageRoot, "packages", "desktop-ui");
const sourceFiles = [];
const walkSource = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSource(absolute);
    } else if (entry.isFile()) {
      sourceFiles.push(absolute);
    }
  }
};
await walkSource(sourceRoot);
sourceFiles.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
const aggregate = createHash("sha256");
let sourceBytes = 0;
for (const absolute of sourceFiles) {
  const relative = path
    .relative(sourceRoot, absolute)
    .split(path.sep)
    .join("/");
  const bytes = await readFile(absolute);
  const details = await stat(absolute);
  sourceBytes += details.size;
  aggregate.update(relative);
  aggregate.update("\0");
  aggregate.update(String(details.size));
  aggregate.update("\0");
  aggregate.update(createHash("sha256").update(bytes).digest("hex"));
  aggregate.update("\n");
}
await writeFile(
  path.join(imageRoot, "interior-seed.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sourceRevision: `sha256:${aggregate.digest("hex")}`,
      files: sourceFiles.length,
      size: sourceBytes,
    },
    null,
    2,
  )}\n`,
);
