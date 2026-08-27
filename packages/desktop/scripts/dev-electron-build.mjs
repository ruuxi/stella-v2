import { build as runEsbuildBuild, stop as stopEsbuildService } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  promises as fsPromises,
  readdirSync,
  readFileSync,
  watch as watchFs,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = import.meta.dirname;
const desktopDir = path.resolve(scriptDir, "..");
const repoRootDir = path.resolve(desktopDir, "..", "..");
const outdir = "dist-electron";
const nodeTarget = `node${process.versions.node.split(".")[0]}`;
const includeLocalUpdateVerification = process.argv.includes(
  "--local-update-verification",
);
const verifyIdentifiers = process.argv.includes("--verify-identifiers");
const runtimeStaticAssetRoots = [
  "packages/runtime/extensions/stella-runtime/agent-metadata",
];

const electronStaticAssetCopies = [
  {
    from: "packages/desktop-ui/src/shared/i18n/locales",
    to: "electron/i18n-locales",
  },
];
const electronRuntimeEntryPoints = {
  "electron/main": "packages/desktop/electron/main.ts",
  ...(includeLocalUpdateVerification
    ? {
        "electron/update-verification-main":
          "packages/desktop/electron/update-verification-main.ts",
      }
    : {}),
  "runtime/kernel/cli/stella-computer":
    "packages/runtime/kernel/cli/stella-computer.ts",
  "runtime/kernel/cli/stella-media":
    "packages/runtime/kernel/cli/stella-media.ts",
};

const workerEntryPoints = {
  "runtime/worker/entry": "packages/runtime/worker/entry.ts",
  "runtime/extensions/stella-runtime/index":
    "packages/runtime/extensions/stella-runtime/index.ts",
};
const preloadEntryPoints = {
  "electron/preload": "packages/desktop/electron/preload.ts",
};

const workspaceAliases = {
  "@stella/contracts": path.join(repoRootDir, "packages", "contracts"),
  "@stella/runtime": path.join(repoRootDir, "packages", "runtime"),
};

const fingerprintFilePath = path.join(
  desktopDir,
  ".dev-electron-bundle-fingerprint.json",
);

const bundleSourceRoots = [
  "packages/contracts",
  "packages/desktop/electron",
  "packages/desktop-ui/src/shared/i18n",
  "packages/runtime",
];
const bundleSourceExcludedPrefixes = ["packages/home-seed/"];
const bundleConfigFiles = [
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "packages/contracts/package.json",
  "packages/desktop/package.json",
  "packages/desktop/tsconfig.electron.json",
  "packages/desktop/tsconfig.preload.json",
  "packages/runtime/package.json",
];
const bundleSourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
]);

const toPosix = (value) => value.split(path.sep).join("/");

const isBundleSourceRelPath = (relPosixPath) => {
  if (bundleSourceExcludedPrefixes.some((p) => relPosixPath.startsWith(p))) {
    return false;
  }
  return bundleSourceExtensions.has(path.posix.extname(relPosixPath));
};

const pruneDependencyPackageMetadataPlugin = {
  name: "prune-dependency-package-metadata",
  setup(build) {
    build.onLoad({ filter: /package\.json$/ }, async (args) => {
      if (!args.path.includes(`${path.sep}node_modules${path.sep}`)) {
        return null;
      }
      const parsed = JSON.parse(await fsPromises.readFile(args.path, "utf8"));
      delete parsed.scripts;
      delete parsed.devDependencies;
      return {
        contents: JSON.stringify(parsed),
        loader: "json",
      };
    });
  },
};

const createBuildOptions = () => [
  {
    absWorkingDir: repoRootDir,
    alias: workspaceAliases,
    bundle: true,
    entryPoints: electronRuntimeEntryPoints,
    external: [
      "electron",
      "electron-updater",
      "bun:*",
      "@silvia-odwyer/photon-node",
      "mac-screen-capture-permissions",
      "uiohook-napi",
    ],
    banner: {
      js: 'import { createRequire as __stellaCreateRequire } from "node:module"; import { fileURLToPath as __stellaFileURLToPath } from "node:url"; import { dirname as __stellaDirname } from "node:path"; const require = __stellaCreateRequire(import.meta.url); const __filename = __stellaFileURLToPath(import.meta.url); const __dirname = __stellaDirname(__filename);',
    },
    format: "esm",
    logLevel: "warning",
    plugins: [pruneDependencyPackageMetadataPlugin],
    outdir: path.join("packages", "desktop", outdir),
    platform: "node",
    target: nodeTarget,
    tsconfig: path.join("packages", "desktop", "tsconfig.electron.json"),
  },
  {
    absWorkingDir: repoRootDir,
    alias: workspaceAliases,
    bundle: true,
    entryPoints: workerEntryPoints,
    external: [
      "electron",
      "bun:*",

      "undici",
      "@silvia-odwyer/photon-node",
    ],
    format: "esm",

    splitting: true,
    chunkNames: "runtime/worker/chunks/[name]-[hash]",

    metafile: true,
    logLevel: "warning",
    plugins: [pruneDependencyPackageMetadataPlugin],
    outdir: path.join("packages", "desktop", outdir),
    platform: "node",
    target: nodeTarget,
    tsconfig: path.join("packages", "desktop", "tsconfig.electron.json"),
  },
  {
    absWorkingDir: repoRootDir,
    alias: workspaceAliases,
    bundle: true,
    external: ["electron"],
    entryPoints: preloadEntryPoints,
    format: "cjs",
    logLevel: "warning",
    plugins: [pruneDependencyPackageMetadataPlugin],
    outdir: path.join("packages", "desktop", outdir),
    platform: "node",
    target: nodeTarget,
    tsconfig: path.join("packages", "desktop", "tsconfig.preload.json"),
  },
];

const workerBannedInputs = [
  "packages/runtime/kernel/home/stella-home.ts",
  "packages/runtime/kernel/home/bundled-skills.ts",
  "packages/runtime/kernel/home/legacy-migration.ts",
];
const workerBannedInputPrefixes = ["packages/desktop/electron/"];

const assertWorkerBundleBoundary = (metafile) => {
  const inputs = Object.keys(metafile?.inputs ?? {}).map((input) =>
    toPosix(input),
  );
  const violations = inputs.filter(
    (input) =>
      workerBannedInputs.includes(input) ||
      workerBannedInputPrefixes.some((prefix) => input.startsWith(prefix)),
  );
  if (violations.length > 0) {
    throw new Error(
      `Electron-only module(s) bundled into the Bun worker: ${violations.join(", ")}. ` +
        "Import pure path helpers from runtime/kernel/home/stella-paths.ts instead of " +
        "stella-home.ts, or move the shared code into a runtime-safe module.",
    );
  }
};

const writeOutputIfChanged = (absPath, contents) => {
  try {
    const existing = readFileSync(absPath);
    if (existing.length === contents.length && existing.equals(contents)) {
      return false;
    }
  } catch {

  }
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents);
  return true;
};

const copyRuntimeStaticAssets = async () => {
  await Promise.all(
    runtimeStaticAssetRoots.map(async (rootRelativePath) => {
      const sourceDir = path.join(repoRootDir, rootRelativePath);
      const targetDir = path.join(
        desktopDir,
        outdir,
        rootRelativePath.replace(/^packages\/runtime/, "runtime"),
      );
      try {
        await fsPromises.rm(targetDir, {
          force: true,
          recursive: true,
        });
        await fsPromises.cp(sourceDir, targetDir, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }),
  );
};

const copyElectronStaticAssets = async () => {
  await Promise.all(
    electronStaticAssetCopies.map(async ({ from, to }) => {
      const sourceDir = path.join(repoRootDir, from);
      const targetDir = path.join(desktopDir, outdir, to);
      try {
        await fsPromises.rm(targetDir, { force: true, recursive: true });
        await fsPromises.cp(sourceDir, targetDir, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }),
  );
};

export const buildElectronBundles = async () => {
  try {
    const optionsList = createBuildOptions();
    const results = await Promise.all(
      optionsList.map((options) =>
        runEsbuildBuild({ ...options, write: false }),
      ),
    );
    const workerResult =
      results[
        optionsList.findIndex(
          (options) => options.entryPoints === workerEntryPoints,
        )
      ];
    assertWorkerBundleBoundary(workerResult.metafile);
    const changedOutputs = [];
    for (const result of results) {
      for (const file of result.outputFiles ?? []) {
        if (writeOutputIfChanged(file.path, file.contents)) {
          changedOutputs.push(file.path);
        }
      }
    }
    await copyRuntimeStaticAssets();
    await copyElectronStaticAssets();
    return changedOutputs;
  } finally {
    await stopEsbuildService();
  }
};

const collectBundleSourceFiles = () => {
  const files = [];

  const visit = (absolutePath) => {
    let entries;
    try {
      entries = readdirSync(absolutePath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childPath = path.join(absolutePath, entry.name);
      const relPosixPath = toPosix(path.relative(repoRootDir, childPath));
      if (entry.isDirectory()) {
        if (
          !bundleSourceExcludedPrefixes.some((p) =>
            `${relPosixPath}/`.startsWith(p),
          )
        ) {
          visit(childPath);
        }
        continue;
      }
      if (entry.isFile() && isBundleSourceRelPath(relPosixPath)) {
        files.push(relPosixPath);
      }
    }
  };

  for (const root of bundleSourceRoots) {
    visit(path.join(repoRootDir, root));
  }
  for (const configFile of bundleConfigFiles) {
    if (existsSync(path.join(repoRootDir, configFile))) {
      files.push(toPosix(configFile));
    }
  }

  files.sort();
  return files;
};

export const computeBundleInputsFingerprint = () => {
  const hash = createHash("sha256");
  for (const relPath of collectBundleSourceFiles()) {
    let stat;
    try {
      stat = lstatSync(path.join(repoRootDir, relPath));
    } catch {
      continue;
    }
    hash.update(relPath);
    hash.update("\0");
    hash.update(String(stat.size));
    hash.update("\0");
    hash.update(String(stat.mtimeMs));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const readBundleFingerprint = () => {
  try {
    const parsed = JSON.parse(readFileSync(fingerprintFilePath, "utf8"));
    return typeof parsed?.fingerprint === "string" ? parsed.fingerprint : null;
  } catch {
    return null;
  }
};

const writeBundleFingerprint = (fingerprint) => {
  try {
    writeFileSync(
      fingerprintFilePath,
      JSON.stringify(
        { fingerprint, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  } catch {

  }
};

export const requiredOutputsExist = () => {
  const outBase = path.join(desktopDir, outdir, "electron");
  return (
    existsSync(path.join(outBase, "main.js")) &&
    existsSync(path.join(outBase, "preload.js"))
  );
};

export const cleanOutdir = async () => {
  await fsPromises.rm(path.join(desktopDir, outdir), {
    force: true,
    recursive: true,
  });
};

export const ensureElectronBundlesFresh = async ({ log } = {}) => {
  const fingerprint = computeBundleInputsFingerprint();
  if (requiredOutputsExist() && readBundleFingerprint() === fingerprint) {
    log?.("electron bundles are current; skipping startup build.");
    return { built: false };
  }
  if (!requiredOutputsExist()) {
    await cleanOutdir();
  }
  log?.("electron bundle inputs changed; rebuilding.");
  await buildElectronBundles();
  writeBundleFingerprint(computeBundleInputsFingerprint());
  return { built: true };
};

export const watchElectronBundleSources = ({
  debounceMs = 300,
  log,
  logError,
} = {}) => {
  const watchers = [];
  let closed = false;
  let debounceTimer = null;
  let buildChain = Promise.resolve();

  const scheduleBuild = () => {
    if (closed) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      buildChain = buildChain
        .catch(() => undefined)
        .then(async () => {
          if (closed) {
            return;
          }
          const startedAt = Date.now();
          try {
            const changedOutputs = await buildElectronBundles();
            writeBundleFingerprint(computeBundleInputsFingerprint());
            log?.(
              `rebuilt electron bundles in ${Date.now() - startedAt}ms (${changedOutputs.length} output${changedOutputs.length === 1 ? "" : "s"} changed)`,
            );
          } catch (error) {
            logError?.(
              `electron bundle rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        });
    }, debounceMs);
  };

  for (const root of bundleSourceRoots) {
    const absoluteRoot = path.join(repoRootDir, root);
    if (!existsSync(absoluteRoot)) {
      continue;
    }
    const watcher = watchFs(
      absoluteRoot,
      { recursive: true },
      (_eventType, filename) => {
        if (typeof filename !== "string") {
          return;
        }
        const relPosixPath = path.posix.join(toPosix(root), toPosix(filename));
        if (!isBundleSourceRelPath(relPosixPath)) {
          return;
        }
        scheduleBuild();
      },
    );
    watchers.push(watcher);
  }

  return {
    close: async () => {
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const watcher of watchers) {
        watcher.close();
      }
      await buildChain.catch(() => undefined);
    },
  };
};

const resolveBunBinary = () => {
  const candidates = [
    process.env.STELLA_BUN_PATH?.trim(),
    process.env.BUN_PATH?.trim(),
  ];
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    candidates.push(
      path.join(
        homeDir,
        ".bun",
        "bin",
        process.platform === "win32" ? "bun.exe" : "bun",
      ),
    );
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return "bun";
};

const smokeTestWorkerChunksUnderBun = () => {
  const chunksDir = path.join(
    desktopDir,
    outdir,
    "runtime",
    "worker",
    "chunks",
  );
  let chunkFiles;
  try {
    chunkFiles = readdirSync(chunksDir).filter((f) => f.endsWith(".js"));
  } catch {
    return;
  }
  const chunkPaths = chunkFiles.map((f) => path.join(chunksDir, f));

  const importScript = [
    `const chunks = ${JSON.stringify(chunkPaths)};`,
    "for (const chunk of chunks) {",
    "  try { await import(chunk); }",
    "  catch (error) {",
    '    console.error("CHUNK_IMPORT_FAILED " + chunk);',
    "    console.error(error);",
    "    process.exit(1);",
    "  }",
    "}",
    "process.exit(0);",
  ].join("\n");
  const result = spawnSync(resolveBunBinary(), ["--eval", importScript], {
    cwd: repoRootDir,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error?.code === "ENOENT") {
    console.warn(
      "[electron-build] bun not found; skipping worker chunk smoke test.",
    );
    return;
  }
  if (result.status !== 0) {
    throw new Error(
      "Worker chunk failed to import under Bun (would crash the detached worker):\n" +
        `${result.stderr || result.stdout || result.error?.message || "unknown error"}`,
    );
  }
  console.log(
    `[electron-build] ${chunkFiles.length} worker chunk(s) import cleanly under Bun.`,
  );
};

export const smokeTestNodeCliEntry = (
  entryPath,
  args = ["--help"],
  { cwd = repoRootDir } = {},
) => {
  const result = spawnSync(process.execPath, [entryPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Node CLI smoke test failed for ${entryPath}:\n` +
        `${result.stderr || result.stdout || result.error?.message || "unknown error"}`,
    );
  }
  return result.stdout;
};

const smokeTestNodeCliBundles = () => {
  const computerCliPath = path.join(
    desktopDir,
    outdir,
    "runtime",
    "kernel",
    "cli",
    "stella-computer.js",
  );
  const stdout = smokeTestNodeCliEntry(computerCliPath);
  if (!stdout.includes("stella-computer - control")) {
    throw new Error(
      "Node CLI smoke test did not return the stella-computer help contract.",
    );
  }
  console.log("[electron-build] stella-computer CLI runs cleanly under Node.");
};

const verifyApplicationIdentifiersInChild = () => {
  const verifierPath = path.join(scriptDir, "verify-packaged-identifiers.mjs");
  const result = spawnSync(
    process.execPath,
    [verifierPath, "--source", "--packaged"],
    {
      cwd: repoRootDir,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      "Application identifier verification failed:\n" +
        `${result.stderr || result.stdout || result.error?.message || "unknown error"}`,
    );
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
};

const isRunDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isRunDirectly) {

  try {
    await cleanOutdir();
    await buildElectronBundles();
    if (verifyIdentifiers) {
      verifyApplicationIdentifiersInChild();
    }
    smokeTestWorkerChunksUnderBun();
    smokeTestNodeCliBundles();
    writeBundleFingerprint(computeBundleInputsFingerprint());
    process.exit(0);
  } catch (error) {
    console.error(
      `[electron-build] Build failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
