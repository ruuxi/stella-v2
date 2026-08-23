import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The Effect migration ratchet (M5 completion, phase 0 — see
// ~/projects/stella-v2-effect-completion-plan.md "The ratchet"). Promise-land
// concurrency primitives are banned from packages/runtime source; every
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
  // Maintenance/CI scripts are not migration targets; the ratchet measures
  // shipped runtime source only.
  "scripts",
]);
const sourceSuffixes = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
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

/**
 * Scan packages/runtime for banned promise-land patterns.
 * Returns Map<relativeFile, { total, byPattern: Map<label, count>, lines: [{line, label, text}] }>.
 */
const scanRuntime = async (runtimeRoot) => {
  const hitsByFile = new Map();
  for (const file of await walk(runtimeRoot)) {
    const text = await readFile(file, "utf8");
    const relativeFile = path.relative(runtimeRoot, file).replace(/\\/g, "/");
    const lines = text.split("\n");
    let entry = null;
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        continue; // prose mentions in comments are not migration debt
      }
      for (const pattern of bannedPatterns) {
        const matches = lines[index].match(pattern.regex);
        if (!matches) continue;
        if (!entry) {
          entry = { total: 0, byPattern: new Map(), lines: [] };
          hitsByFile.set(relativeFile, entry);
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
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((count) => !Number.isInteger(count) || count < 1)
  ) {
    throw new Error(
      `Malformed allowlist at ${allowlistPath}: expected { "path/relative/to/packages-runtime.ts": positiveCount }`,
    );
  }
  return parsed;
};

const formatByPattern = (byPattern) =>
  [...byPattern.entries()].map(([label, count]) => `${label} x${count}`).join(", ");

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const update = process.argv.includes("--update");
  const runtimeRoot = path.resolve(import.meta.dirname, "..");
  const allowlistPath = path.join(runtimeRoot, "scripts", "effect-ratchet-allowlist.json");
  const allowlistName = path
    .relative(path.resolve(runtimeRoot, "..", ".."), allowlistPath)
    .replace(/\\/g, "/");

  const hitsByFile = await scanRuntime(runtimeRoot);
  const allowlist = await loadAllowlist(allowlistPath);

  if (allowlist === null && !update) {
    console.error(
      `Effect ratchet allowlist missing (${allowlistName}). Bootstrap it with:\n` +
        "  node packages/runtime/scripts/check-effect-ratchet.mjs --update",
    );
    process.exit(1);
  }

  // Offenders: new files with hits, or files that grew past their pinned
  // count. On the bootstrap run (--update with no allowlist yet) there is no
  // baseline to exceed — the scan itself becomes the baseline.
  const offenders = [];
  if (allowlist !== null) {
    for (const [file, entry] of [...hitsByFile.entries()].sort()) {
      const allowed = allowlist[file] ?? 0;
      if (entry.total > allowed) {
        offenders.push({ file, entry, allowed });
      }
    }
  }

  // Shrinkage: pinned counts higher than reality (or files gone clean).
  const shrinkage = [];
  for (const [file, allowed] of Object.entries(allowlist ?? {}).sort()) {
    const actual = hitsByFile.get(file)?.total ?? 0;
    if (actual < allowed) shrinkage.push({ file, allowed, actual });
  }

  if (offenders.length > 0) {
    console.error(
      "Effect ratchet violations (banned promise-land patterns in packages/runtime):",
    );
    for (const { file, entry, allowed } of offenders) {
      console.error(
        `- ${file}: ${entry.total} hits, ${allowed} allowlisted (${formatByPattern(entry.byPattern)})`,
      );
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
      next[file] = hitsByFile.get(file).total;
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
    console.log("Effect ratchet: shrinkage available — ratchet the allowlist down:");
    for (const { file, allowed, actual } of shrinkage) {
      console.log(
        actual === 0
          ? `- ${file}: clean (was ${allowed}) — remove the entry`
          : `- ${file}: ${actual} actual < ${allowed} allowlisted`,
      );
    }
    console.log("Run: node packages/runtime/scripts/check-effect-ratchet.mjs --update");
  }

  const totalsByPattern = new Map(bannedPatterns.map((pattern) => [pattern.label, 0]));
  let total = 0;
  for (const entry of hitsByFile.values()) {
    total += entry.total;
    for (const [label, count] of entry.byPattern) {
      totalsByPattern.set(label, (totalsByPattern.get(label) ?? 0) + count);
    }
  }
  console.log(
    `Effect ratchet OK: ${total} allowlisted hits across ${hitsByFile.size} files ` +
      `(${formatByPattern(totalsByPattern)})`,
  );
}
