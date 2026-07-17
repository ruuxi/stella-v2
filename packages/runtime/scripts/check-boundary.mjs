import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The Effect fence (M5): Effect lives ONLY in packages/runtime, and even
// there it is banned from tool and prompt definitions so those stay plain
// portable TS. Every source-bearing file in the banned packages is scanned —
// src, tests, scripts, configs — not just the app entry roots.
const isEffectImport = (specifier) =>
  specifier === "effect" || specifier.startsWith("effect/");
// Runtime modules whose EXPORTED SIGNATURES carry Effect/Scope types. The
// runtime package.json blocks these subpaths outright (null export targets),
// and the fence flags any attempted import from the Effect-free packages so
// a violation reads as a boundary error, not a resolution failure. The
// plain-Promise facades (@stella/runtime/host, @stella/runtime/host/lifecycle)
// stay importable.
const isEffectBearingRuntimeImport = (specifier) =>
  specifier.startsWith("@stella/runtime/host/lifecycle/") ||
  specifier === "@stella/runtime/host/staleness" ||
  specifier === "@stella/runtime/host/staleness.js" ||
  /(?:^|\/)runtime\/host\/(?:lifecycle\/|staleness(?:\.|$))/.test(specifier);
const runtimeEffectFencedPrefixes = [
  "packages/runtime/kernel/tools/",
  "packages/runtime/kernel/prompts/",
];
const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "coverage",
]);
const sourceSuffixes = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

const walk = async (directory) => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return []; // root may not exist (fixture trees)
  }
  const files = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolutePath)));
    } else if (entry.isFile() && sourceSuffixes.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files;
};

const moduleSpecifiers = (text) => {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
};

/**
 * Scan a repo tree for workspace-boundary violations. Returns the offender
 * list instead of exiting so tests can run it against fixture trees.
 */
export const checkBoundaries = async (repoRoot) => {
  const offenders = [];
  const inspect = async (root, isForbidden) => {
    for (const file of await walk(root)) {
      const text = await readFile(file, "utf8");
      const relativeFile = path.relative(repoRoot, file).replace(/\\/g, "/");
      for (const specifier of moduleSpecifiers(text)) {
        const reason = isForbidden(specifier, relativeFile);
        if (reason) {
          offenders.push({ file: relativeFile, specifier, reason });
        }
      }
    }
  };

  // packages/runtime — the only package allowed to use Effect, minus the
  // tool/prompt definition subtrees.
  await inspect(path.join(repoRoot, "packages", "runtime"), (specifier, file) => {
    if (specifier === "@stella/desktop" || specifier.startsWith("@stella/desktop/")) {
      return "runtime must not depend on desktop";
    }
    if (specifier === "@stella/desktop-ui" || specifier.startsWith("@stella/desktop-ui/")) {
      return "runtime must not depend on desktop-ui";
    }
    if (/\.\.\/.*(?:desktop|desktop-ui)\//.test(specifier)) {
      return "runtime must not reach into desktop packages by relative path";
    }
    if (
      isEffectImport(specifier) &&
      runtimeEffectFencedPrefixes.some((prefix) => file.startsWith(prefix))
    ) {
      return "tool/prompt definitions must stay Effect-free";
    }
    return null;
  });

  // packages/desktop-ui — the whole package is Effect-free. The stricter
  // contracts-only import rule applies to renderer src (tests intentionally
  // exercise @stella/runtime/worker/* internals; configs use build tooling).
  await inspect(path.join(repoRoot, "packages", "desktop-ui"), (specifier, file) => {
    if (isEffectImport(specifier)) {
      return "Effect is fenced inside packages/runtime";
    }
    if (isEffectBearingRuntimeImport(specifier)) {
      return "Effect-bearing runtime host internals are fenced inside packages/runtime";
    }
    if (!file.startsWith("packages/desktop-ui/src/")) {
      return null;
    }
    if (specifier.startsWith("@stella/") &&
        specifier !== "@stella/contracts" &&
        !specifier.startsWith("@stella/contracts/")) {
      return "renderer may import only @stella/contracts workspace modules";
    }
    if (/\.\.\/.*(?:runtime|desktop|contracts)\//.test(specifier)) {
      return "renderer must use the contracts workspace boundary";
    }
    return null;
  });

  // packages/desktop — the whole package (electron, preload, scripts, vite,
  // configs) is Effect-free; Electron main additionally must not reach into
  // runtime internals by relative path.
  await inspect(path.join(repoRoot, "packages", "desktop"), (specifier, file) => {
    if (isEffectImport(specifier)) {
      return "Effect is fenced inside packages/runtime";
    }
    if (isEffectBearingRuntimeImport(specifier)) {
      return "Effect-bearing runtime host internals are fenced inside packages/runtime";
    }
    if (
      file.startsWith("packages/desktop/electron/") &&
      /\.\.\/.*runtime\//.test(specifier)
    ) {
      return "Electron must use @stella/runtime workspace exports";
    }
    return null;
  });

  // packages/contracts — the stable seam stays Effect-free.
  await inspect(path.join(repoRoot, "packages", "contracts"), (specifier) => {
    if (isEffectImport(specifier)) {
      return "Effect is fenced inside packages/runtime";
    }
    if (isEffectBearingRuntimeImport(specifier)) {
      return "Effect-bearing runtime host internals are fenced inside packages/runtime";
    }
    return null;
  });

  return offenders;
};

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const offenders = await checkBoundaries(repoRoot);
  if (offenders.length > 0) {
    console.error("Workspace dependency boundary violations:");
    for (const offender of offenders) {
      console.error(`- ${offender.file}: ${offender.specifier} (${offender.reason})`);
    }
    process.exit(1);
  }
}
