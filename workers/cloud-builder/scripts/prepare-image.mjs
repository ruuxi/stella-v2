import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(workerRoot, "..", "..");
const sourceLockPath = path.join(workerRoot, "sandbox-image.bun.lock");

let imageRoot = path.join(workerRoot, ".image");
let refreshLock = false;
let customOutput = false;
let generatedRefreshRoot = false;
for (const argument of process.argv.slice(2)) {
  if (argument === "--refresh-lock") {
    refreshLock = true;
  } else if (argument.startsWith("--output=")) {
    const output = argument.slice("--output=".length).trim();
    if (!output) {
      throw new Error("--output requires a directory.");
    }
    imageRoot = path.resolve(output);
    customOutput = true;
  } else {
    throw new Error(`Unknown image preparation argument: ${argument}`);
  }
}

// Bun 1.4 discovers parent workspaces before creating a missing nested lock.
// Refresh outside the monorepo so the image lock is generated from only the
// staged production workspace rather than accidentally rewriting the root
// lock. Ordinary image preparation still targets .image for Docker.
if (refreshLock && !customOutput) {
  imageRoot = await mkdtemp(path.join(tmpdir(), "stella-image-lock-refresh-"));
  customOutput = true;
  generatedRefreshRoot = true;
}

if (customOutput && !generatedRefreshRoot) {
  const outputExists = await stat(imageRoot)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
  if (outputExists) {
    throw new Error("--output must name a new directory.");
  }
} else {
  await rm(imageRoot, { recursive: true, force: true });
}
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
  source.split(path.sep).includes("node_modules") ||
  source.includes(`${path.sep}.git${path.sep}`) ||
  source.includes(`${path.sep}stella-office${path.sep}vendor`) ||
  path.basename(source).startsWith("stella-office-darwin-");

const rootPackage = JSON.parse(
  await readFile(path.join(repoRoot, "package.json"), "utf8"),
);
const workerPackage = JSON.parse(
  await readFile(path.join(workerRoot, "package.json"), "utf8"),
);
const dockerfile = await readFile(path.join(workerRoot, "Dockerfile"), "utf8");
const sandboxPackageVersion =
  workerPackage.dependencies?.["@cloudflare/sandbox"];
const imageBunVersion = workerPackage.devDependencies?.bun;
const imageBunPath = path.join(
  workerRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "bun.exe" : "bun",
);
const bunRuntimeMatch = dockerfile.match(
  /^FROM\s+docker\.io\/oven\/bun:([^\s-]+)-debian@sha256:[0-9a-f]+\s+AS\s+bun-runtime\s*$/m,
);
const bunRuntimeVersion = bunRuntimeMatch?.[1];
const sandboxBaseMatch = dockerfile.match(
  /^FROM\s+docker\.io\/cloudflare\/sandbox:([^\s]+)\s*$/m,
);
const sandboxBaseVersion = sandboxBaseMatch?.[1];
if (
  typeof sandboxPackageVersion !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(sandboxPackageVersion)
) {
  throw new Error(
    "Cloud image @cloudflare/sandbox dependency must use an exact version.",
  );
}
if (sandboxBaseVersion !== sandboxPackageVersion) {
  throw new Error(
    `Cloud image Sandbox SDK ${sandboxPackageVersion} does not match Docker base ${sandboxBaseVersion ?? "<missing>"}.`,
  );
}
if (
  typeof imageBunVersion !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(imageBunVersion)
) {
  throw new Error("Cloud image Bun build tool must use an exact version.");
}
if (bunRuntimeVersion !== imageBunVersion) {
  throw new Error(
    `Cloud image Bun build tool ${imageBunVersion} does not match Docker runtime ${bunRuntimeVersion ?? "<missing>"}.`,
  );
}
const imagePackage = {
  name: "stella-cloud-executor-image",
  private: true,
  type: "module",
  workspaces: imagePackages.map((name) => `packages/${name}`),
  dependencies: {
    ...rootPackage.dependencies,
    // Claude's native coding-agent runtime. This exact version is part of the
    // sandbox image contract: cloud turns must not change behavior merely
    // because a registry dist-tag moved between image builds.
    "@anthropic-ai/claude-code": "2.1.220",
  },
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

const runBunLockCommand = ({ frozen }) => {
  const result = spawnSync(
    imageBunPath,
    [
      "install",
      "--lockfile-only",
      "--ignore-scripts",
      "--save-text-lockfile",
      ...(frozen ? ["--frozen-lockfile"] : []),
    ],
    {
      cwd: imageRoot,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      [
        frozen
          ? "The checked-in Sandbox image lock no longer matches the staged manifests. Run `bun run image:lock:refresh` and review the dependency diff."
          : "Unable to refresh the Sandbox image lock.",
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
};

const stagedLockPath = path.join(imageRoot, "bun.lock");
if (refreshLock) {
  // Refresh is intentionally explicit: ordinary builds never consult registry
  // state to choose a dependency version. The generated lock is scoped to the
  // staged workspaces rather than copying the monorepo's lockfile. Bun 1.4
  // does not emit a new lockfile when --production and --lockfile-only are
  // combined, so the lock records every staged dependency while the Docker
  // install still uses --production.
  runBunLockCommand({ frozen: false });
  await cp(stagedLockPath, sourceLockPath);
} else {
  await cp(sourceLockPath, stagedLockPath);
  runBunLockCommand({ frozen: true });
}

const lockBytes = await readFile(stagedLockPath);
const lockSha256 = createHash("sha256").update(lockBytes).digest("hex");
await writeFile(
  path.join(imageRoot, "image-build.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sandboxSdkVersion: sandboxPackageVersion,
      sandboxBaseImage: `docker.io/cloudflare/sandbox:${sandboxBaseVersion}`,
      dependencyLockSha256: `sha256:${lockSha256}`,
    },
    null,
    2,
  )}\n`,
);

if (generatedRefreshRoot) {
  await rm(imageRoot, { recursive: true, force: true });
}
