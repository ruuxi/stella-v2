/**
 * Electron-main / preload bundles.
 *
 * Stella runs from its source tree. The renderer is served from source
 * (`electron/source/`) and the runtime is Bun running TypeScript, so the only
 * bundles a source launch needs are Electron main and the sandboxed preload.
 * `electron/start.mjs` calls `ensureElectronBundlesFresh` before loading main:
 * a stat fingerprint of the source roots, persisted next to the outputs,
 * skips the build when nothing changed, and otherwise main and preload are
 * rebuilt in place (about a second).
 *
 * Builds use the esbuild API with `write: false` plus write-if-changed, so
 * byte-identical outputs never touch disk, and stop the esbuild service
 * afterwards so nothing stays resident.
 *
 * Run directly (`--once`) it does a clean build of the same bundles and
 * exits.
 */
import { build as runEsbuildBuild, stop as stopEsbuildService } from "esbuild";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  promises as fsPromises,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { isEntryPoint } from "../../../scripts/lib/entry-point.mjs";

const scriptDir = import.meta.dirname;
const desktopDir = path.resolve(scriptDir, "..");
const repoRootDir = path.resolve(desktopDir, "..", "..");
const outdir = "dist-electron";
const nodeTarget = `node${process.versions.node.split(".")[0]}`;
const electronMainEntryPoints = {
  // `launch` enables the V8 compile cache, then imports the `main` bundle
  // through a computed specifier so it stays a separate output instead of
  // being inlined.
  "electron/launch": "packages/desktop/electron/launch.ts",
  "electron/main": "packages/desktop/electron/main.ts",
  "electron/cloud-conversation-cache-worker": "packages/desktop/electron/services/cloud-conversation-cache-worker.ts",
};
const preloadEntryPoints = {
  "electron/preload": "packages/desktop/electron/preload.ts",
};
const desktopUiDir = path.join(repoRootDir, "packages", "desktop-ui");
/** desktop-ui's env files in Vite's order (later files win). */
const desktopEnvFiles = (mode) => [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`];
const desktopPublicEnv = {};
for (const name of desktopEnvFiles(process.env.NODE_ENV || "development")) {
  try {
    Object.assign(desktopPublicEnv, parseEnv(readFileSync(path.join(desktopUiDir, name), "utf8")));
  } catch {
    // A missing env file is normal.
  }
}
const publicTurnstileSiteKey =
  process.env.VITE_TURNSTILE_SITE_KEY ||
  desktopPublicEnv.VITE_TURNSTILE_SITE_KEY ||
  "";

// Workspace packages are source inputs in this monorepo, not installed
// runtime dependencies. Resolve them before `packages: "external"` is applied
// so Electron never attempts to execute their TypeScript sources directly.
/** Loaded by the renderer source server on first use, never bundled. */
const rendererSourceExternals = [
  "rolldown",
  "rolldown/*",
  "@tailwindcss/node",
  "@tailwindcss/oxide",
  "@tanstack/router-generator",
  "cjs-module-lexer",
];

const workspaceAliases = {
  "@stella/contracts": path.join(repoRootDir, "packages", "contracts"),
  "@stella/runtime": path.join(repoRootDir, "packages", "runtime"),
};

const fingerprintFilePath = path.join(
  desktopDir,
  ".dev-electron-bundle-fingerprint.json",
);

/**
 * Everything the bundles can pull in. `desktop/src/shared/` is included
 * because electron-main/preload import contracts and lib shims from there
 * (see e.g. `desktop/electron/preload.ts`). `runtime/home-seed/` is seed
 * data, never bundled, and excluded so seeding churn doesn't trigger builds.
 * `desktop-ui/src/shared/i18n` is the renderer-owned locale set: electron-main
 * imports `locales.ts` from it.
 */
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
  // VITE_TURNSTILE_SITE_KEY is baked into main from these.
  ...desktopEnvFiles("development").map((name) => `packages/desktop-ui/${name}`),
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

// Some dependencies import their own package.json for name/version metadata.
// Keep that runtime metadata without embedding upstream development scripts and
// devDependencies into Stella's production JavaScript bundle.
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

const buildOptions = [
  {
    absWorkingDir: repoRootDir,
    alias: workspaceAliases,
    bundle: true,
    define: {
      "process.env.VITE_TURNSTILE_SITE_KEY": JSON.stringify(
        publicTurnstileSiteKey,
      ),
    },
    entryPoints: electronMainEntryPoints,
    external: [
      "electron",
      ...rendererSourceExternals,
      "bun:*",
      "@silvia-odwyer/photon-node",
      "mac-screen-capture-permissions",
      "uiohook-napi",
    ],
    banner: {
      js: 'import { createRequire as __stellaCreateRequire } from "node:module"; import { fileURLToPath as __stellaFileURLToPath } from "node:url"; import { dirname as __stellaDirname } from "node:path"; const require = __stellaCreateRequire(import.meta.url); const __filename = __stellaFileURLToPath(import.meta.url); const __dirname = __stellaDirname(__filename);',
    },
    format: "esm",
    // Consumed by assertMainBundleStartupBoundary after each build.
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

/**
 * Cold-start boundary for electron-main. esbuild hoists every external
 * `import` statement to the top of the ESM bundle, so a static import of one
 * of these anywhere in the graph — however deep or lazily initialized its
 * importer — is loaded on every launch before `ready`. They are loaded on
 * first use instead (see input/mouse-hook.js).
 */
export const mainStartupDeferredExternals = [
  "uiohook-napi",
  // The renderer source server's tooling (electron/source/tools.ts).
  ...rendererSourceExternals,
];
/**
 * Bundled modules that must stay behind a dynamic `import()`: statically
 * reachable from the startup roots, their whole subgraph evaluates before the
 * window is created. `bootstrap.ts` counts as a root because main.ts loads it
 * immediately.
 */
export const mainStartupDeferredInputs = [
  "packages/runtime/kernel/integrations/claude-code-session-runtime.js",
  "packages/desktop/electron/process-resources/mobile-bridge-resource.js",
  "packages/desktop/electron/source/renderer-source.ts",
  "packages/desktop/electron/source/tools.ts",
];
const mainStartupRootInputs = [
  "packages/desktop/electron/main.ts",
  "packages/desktop/electron/bootstrap.ts",
];
const launchEntryInput = "packages/desktop/electron/launch.ts";

const collectStaticallyReachableInputs = (metafile, roots) => {
  const reached = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const input = pending.pop();
    if (reached.has(input)) {
      continue;
    }
    reached.add(input);
    for (const imported of metafile?.inputs?.[input]?.imports ?? []) {
      if (!imported.external && imported.kind !== "dynamic-import") {
        pending.push(toPosix(imported.path));
      }
    }
  }
  return reached;
};

/**
 * Fails the build when electron-main's cold-start work regresses: a deferred
 * external imported statically again, a deferred bundled module pulled back
 * into the startup graph, or `launch.js` (which must enable the
 * V8 compile cache before the bundle is compiled) inlining the bundle it is
 * meant to load.
 */
export const assertMainBundleStartupBoundary = (metafile) => {
  const violations = [];
  for (const [outputPath, output] of Object.entries(metafile?.outputs ?? {})) {
    const outputPosix = toPosix(outputPath);
    if (outputPosix.endsWith("/electron/launch.js")) {
      const inlined = Object.keys(output.inputs ?? {})
        .map((input) => toPosix(input))
        .filter((input) => input !== launchEntryInput);
      if (inlined.length > 0) {
        violations.push(`electron/launch.js inlines ${inlined.join(", ")}`);
      }
    }
    if (outputPosix.endsWith("/electron/main.js")) {
      for (const imported of output.imports ?? []) {
        if (
          imported.kind === "import-statement" &&
          mainStartupDeferredExternals.includes(imported.path)
        ) {
          violations.push(
            `electron/main.js statically imports ${imported.path}`,
          );
        }
      }
    }
  }
  const startupInputs = collectStaticallyReachableInputs(
    metafile,
    mainStartupRootInputs,
  );
  for (const input of mainStartupDeferredInputs) {
    if (startupInputs.has(input)) {
      violations.push(`${input} is statically reachable from startup`);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Electron main cold-start boundary violated: ${violations.join("; ")}. ` +
        "Load deferred externals on first use (createRequire / dynamic import) " +
        "and keep launch.ts importing the bundle through a computed specifier.",
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
    // Missing file — fall through to the write.
  }
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents);
  return true;
};

/**
 * One-shot build. Outputs are produced with `write: false` and written only
 * when their bytes differ from what's on disk, so watchers only ever see
 * genuine changes. The esbuild service is stopped afterwards so nothing stays
 * resident between builds.
 */
export const buildElectronBundles = async () => {
  try {
    const results = await Promise.all(
      buildOptions.map((options) =>
        runEsbuildBuild({ ...options, write: false }),
      ),
    );
    assertMainBundleStartupBoundary(results[0].metafile);
    const changedOutputs = [];
    for (const result of results) {
      for (const file of result.outputFiles ?? []) {
        if (writeOutputIfChanged(file.path, file.contents)) {
          changedOutputs.push(file.path);
        }
      }
    }
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
    // Best-effort; a missing fingerprint just means the next launch rebuilds.
  }
};

export const requiredOutputsExist = () => {
  const outBase = path.join(desktopDir, outdir);
  return ["launch.js", "main.js", "preload.js"].every((name) =>
    existsSync(path.join(outBase, "electron", name)),
  );
};

export const cleanOutdir = async () => {
  await fsPromises.rm(path.join(desktopDir, outdir), {
    force: true,
    recursive: true,
  });
};

/**
 * The source launch: skip the build when main and preload exist and the
 * source fingerprint matches the last successful build, otherwise rebuild
 * them in place (a missing output cleans the outdir first).
 */
export const ensureElectronBundlesFresh = async ({ log } = {}) => {
  const fingerprint = computeBundleInputsFingerprint();
  if (requiredOutputsExist() && readBundleFingerprint() === fingerprint) {
    return { built: false };
  }
  if (!requiredOutputsExist()) {
    await cleanOutdir();
  }
  const startedAt = Date.now();
  await buildElectronBundles();
  writeBundleFingerprint(fingerprint);
  log?.(`built main and preload in ${Date.now() - startedAt}ms`);
  return { built: true };
};

if (isEntryPoint(import.meta.url)) {
  // A clean build of main and preload. `--once` is accepted for existing
  // callers.
  try {
    await cleanOutdir();
    await buildElectronBundles();
    writeBundleFingerprint(computeBundleInputsFingerprint());
    process.exit(0);
  } catch (error) {
    console.error(
      `[electron-build] Build failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
