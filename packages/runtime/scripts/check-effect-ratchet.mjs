import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The Effect migration ratchet (M5 completion, phase 0 — see
// ~/projects/stella-v2-effect-completion-plan.md "The ratchet"). Promise-land
// concurrency primitives are banned from every Effect-bearing package:
// packages/runtime, packages/executor-cloud, and workers/cloud-builder. Every
// current offender is pinned in effect-ratchet-allowlist.json with its exact
// hit count. Migration = shrinking the allowlist. CI fails on any new hit or
// any file exceeding its pinned count; `--update` rewrites the allowlist DOWN
// to the measured counts (never up), so the number can only fall.
const bannedPatterns = [
  { label: "new AbortController", regex: /\bnew\s+AbortController\b/g },
  { label: "setTimeout(", regex: /\bsetTimeout\s*\(/g },
  { label: "setInterval(", regex: /\bsetInterval\s*\(/g },
];

const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "coverage",
  "release",
  ".image",
  "tests",
  // Maintenance/CI scripts are not migration targets; the ratchet measures
  // shipped runtime source only.
  "scripts",
]);
const sourceSuffixes = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);
const isTestFile = (name) => /\.test\.[cm]?[jt]sx?$/.test(name);

const walk = async (directory) => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolutePath)));
    } else if (
      entry.isFile() &&
      sourceSuffixes.has(path.extname(entry.name)) &&
      !isTestFile(entry.name)
    ) {
      files.push(absolutePath);
    }
  }
  return files;
};

const effectBearingTargets = [
  { segments: ["packages", "runtime"], keyPrefix: "" },
  {
    segments: ["packages", "executor-cloud"],
    keyPrefix: "packages/executor-cloud/",
  },
  {
    segments: ["workers", "cloud-builder"],
    keyPrefix: "workers/cloud-builder/",
  },
];

/**
 * Scan every Effect-bearing package for banned promise-land patterns.
 * Runtime keys remain relative to packages/runtime for allowlist continuity;
 * the newer executor and Worker keys are repository-relative and explicit.
 * Returns Map<allowlistKey, { total, byPattern: Map<label, count>, lines: [{line, label, text}] }>.
 */
export const scanEffectRatchetTargets = async (repoRoot) => {
  const hitsByFile = new Map();
  for (const target of effectBearingTargets) {
    const targetRoot = path.join(repoRoot, ...target.segments);
    for (const file of await walk(targetRoot)) {
      const text = await readFile(file, "utf8");
      const relativeFile = path.relative(targetRoot, file).replace(/\\/g, "/");
      const allowlistKey = `${target.keyPrefix}${relativeFile}`;
      const lines = text.split("\n");
      let entry = null;
      for (let index = 0; index < lines.length; index += 1) {
        const trimmed = lines[index].trim();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*")
        ) {
          continue; // prose mentions in comments are not migration debt
        }
        for (const pattern of bannedPatterns) {
          const matches = lines[index].match(pattern.regex);
          if (!matches) continue;
          if (!entry) {
            entry = { total: 0, byPattern: new Map(), lines: [] };
            hitsByFile.set(allowlistKey, entry);
          }
          entry.total += matches.length;
          entry.byPattern.set(
            pattern.label,
            (entry.byPattern.get(pattern.label) ?? 0) + matches.length,
          );
          entry.lines.push({
            line: index + 1,
            label: pattern.label,
            text: lines[index].trim(),
          });
        }
      }
    }
  }
  return hitsByFile;
};

const loadAllowlist = async (allowlistPath) => {
  let raw;
  try {
    raw = await readFile(allowlistPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null; // first run: --update bootstraps it
    throw error;
  }
  const parsed = JSON.parse(raw);
  const patternLabels = new Set(bannedPatterns.map(({ label }) => label));
  const validPinnedCount = (count) => Number.isInteger(count) && count >= 1;
  const validEntry = (entry) => {
    if (validPinnedCount(entry)) return true;
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).length === 0
    ) {
      return false;
    }
    return Object.entries(entry).every(
      ([label, count]) => patternLabels.has(label) && validPinnedCount(count),
    );
  };
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((entry) => !validEntry(entry))
  ) {
    throw new Error(
      `Malformed allowlist at ${allowlistPath}: expected positive file counts or positive per-pattern counts`,
    );
  }
  return parsed;
};

const isPatternPinnedEntry = (entry) =>
  typeof entry === "object" && entry !== null && !Array.isArray(entry);

/**
 * Compare measured debt with the pinned baseline. Legacy Runtime entries use
 * one file total; newly admitted cloud packages pin each primitive so swapping
 * a timer for an AbortController cannot hide new debt behind a flat total.
 */
export const evaluateEffectRatchet = (hitsByFile, allowlist) => {
  const offenders = [];
  for (const [file, entry] of [...hitsByFile.entries()].sort()) {
    const pinned = allowlist[file];
    if (!isPatternPinnedEntry(pinned)) {
      const allowed = typeof pinned === "number" ? pinned : 0;
      if (entry.total > allowed) {
        offenders.push({ file, entry, allowed, patternOverages: [] });
      }
      continue;
    }

    const patternOverages = [];
    for (const [label, actual] of entry.byPattern) {
      const allowed = pinned[label] ?? 0;
      if (actual > allowed) patternOverages.push({ label, actual, allowed });
    }
    if (patternOverages.length > 0) {
      offenders.push({
        file,
        entry,
        allowed: Object.values(pinned).reduce((sum, count) => sum + count, 0),
        patternOverages,
      });
    }
  }

  const shrinkage = [];
  for (const [file, pinned] of Object.entries(allowlist).sort()) {
    const entry = hitsByFile.get(file);
    if (!isPatternPinnedEntry(pinned)) {
      const actual = entry?.total ?? 0;
      if (actual < pinned) shrinkage.push({ file, allowed: pinned, actual });
      continue;
    }
    for (const [label, allowed] of Object.entries(pinned).sort()) {
      const actual = entry?.byPattern.get(label) ?? 0;
      if (actual < allowed) {
        shrinkage.push({ file, label, allowed, actual });
      }
    }
  }
  return { offenders, shrinkage };
};

const formatByPattern = (byPattern) =>
  [...byPattern.entries()]
    .map(([label, count]) => `${label} x${count}`)
    .join(", ");

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const update = process.argv.includes("--update");
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const runtimeRoot = path.join(repoRoot, "packages", "runtime");
  const allowlistPath = path.join(
    runtimeRoot,
    "scripts",
    "effect-ratchet-allowlist.json",
  );
  const allowlistName = path
    .relative(repoRoot, allowlistPath)
    .replace(/\\/g, "/");

  const hitsByFile = await scanEffectRatchetTargets(repoRoot);
  const allowlist = await loadAllowlist(allowlistPath);

  if (allowlist === null && !update) {
    console.error(
      `Effect ratchet allowlist missing (${allowlistName}). Bootstrap it with:\n` +
        "  node packages/runtime/scripts/check-effect-ratchet.mjs --update",
    );
    process.exit(1);
  }

  // On the bootstrap run there is no baseline to exceed — the scan itself
  // becomes the baseline. Every later run compares against the pinned form.
  const { offenders, shrinkage } =
    allowlist === null
      ? { offenders: [], shrinkage: [] }
      : evaluateEffectRatchet(hitsByFile, allowlist);

  if (offenders.length > 0) {
    console.error(
      "Effect ratchet violations (banned promise-land patterns in Effect-bearing packages):",
    );
    for (const { file, entry, allowed, patternOverages } of offenders) {
      console.error(
        `- ${file}: ${entry.total} hits, ${allowed} allowlisted (${formatByPattern(entry.byPattern)})`,
      );
      for (const {
        label,
        actual,
        allowed: patternAllowed,
      } of patternOverages) {
        console.error(
          `    ${label} debt: ${actual} hits, ${patternAllowed} allowlisted`,
        );
      }
      for (const hit of entry.lines) {
        console.error(`    ${file}:${hit.line} [${hit.label}] ${hit.text}`);
      }
    }
    console.error(
      "\nRewrite these with Effect idioms (Effect.timeout / Schedule / fiber interruption" +
        " — see docs/effect-architecture.md). The allowlist only ratchets down; new or" +
        " grown entries are never added.",
    );
    process.exit(1);
  }

  if (update) {
    const next = {};
    for (const file of [...hitsByFile.keys()].sort()) {
      const entry = hitsByFile.get(file);
      const pinned = allowlist?.[file];
      next[file] = isPatternPinnedEntry(pinned)
        ? Object.fromEntries([...entry.byPattern.entries()].sort())
        : entry.total;
    }
    await writeFile(allowlistPath, `${JSON.stringify(next, null, 2)}\n`);
    const dropped = shrinkage.filter((item) => item.actual === 0).length;
    const lowered = shrinkage.length - dropped;
    console.log(
      `Effect ratchet allowlist ${allowlist === null ? "created" : "updated"}: ` +
        `${Object.keys(next).length} files pinned` +
        (lowered > 0 ? `, ${lowered} lowered` : "") +
        (dropped > 0 ? `, ${dropped} removed` : "") +
        ` (${allowlistName})`,
    );
  } else if (shrinkage.length > 0) {
    console.log(
      "Effect ratchet: shrinkage available — ratchet the allowlist down:",
    );
    for (const { file, label, allowed, actual } of shrinkage) {
      console.log(
        actual === 0
          ? `- ${file}${label ? ` [${label}]` : ""}: clean (was ${allowed}) — remove the entry`
          : `- ${file}${label ? ` [${label}]` : ""}: ${actual} actual < ${allowed} allowlisted`,
      );
    }
    console.log(
      "Run: node packages/runtime/scripts/check-effect-ratchet.mjs --update",
    );
  }

  const totalsByPattern = new Map(
    bannedPatterns.map((pattern) => [pattern.label, 0]),
  );
  let total = 0;
  for (const entry of hitsByFile.values()) {
    total += entry.total;
    for (const [label, count] of entry.byPattern) {
      totalsByPattern.set(label, (totalsByPattern.get(label) ?? 0) + count);
    }
  }
  console.log(
    `Effect ratchet OK: ${total} allowlisted hits across ${hitsByFile.size} Effect-bearing files ` +
      `(${formatByPattern(totalsByPattern)})`,
  );
}
