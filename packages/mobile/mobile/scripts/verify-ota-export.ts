/**
 * Verify that an exported OTA bundle (`dist/`) was built from EXACTLY the
 * source at a git revision — no dirty-tree drift.
 *
 * Postmortem tool from the 2026-07-02 boot crash: an update was published
 * while the working tree held a mid-refactor ChatPane (it rendered
 * `<ActivityTray/>` without importing it), so the OTA labeled `cc5808e`
 * shipped code that existed in NO commit and crashed every launch of
 * builds 95/96 with a release-mode ReferenceError. The Hermes sourcemap
 * embeds `sourcesContent` for every bundled module, so the shipped JS can be
 * compared byte-for-byte against git.
 *
 * Usage: bun scripts/verify-ota-export.ts [rev]   (default rev: HEAD)
 * Exits non-zero and lists every /src|/app file that differs from the rev.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rev = process.argv[2] ?? "HEAD";
const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(mobileRoot, "dist", "_expo", "static", "js", "ios");

const maps = readdirSync(bundleDir).filter((f) => f.endsWith(".hbc.map"));
if (maps.length === 0) {
  console.error(`No .hbc.map found in ${bundleDir} — run \`expo export\` first.`);
  process.exit(1);
}

const gitShow = (path: string): string | null => {
  try {
    return execFileSync("git", ["show", `${rev}:mobile${path}`], {
      cwd: mobileRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};

let checked = 0;
const mismatches: string[] = [];
for (const mapFile of maps) {
  const map = JSON.parse(readFileSync(join(bundleDir, mapFile), "utf8")) as {
    sources: string[];
    sourcesContent: (string | null)[];
  };
  map.sources.forEach((source, i) => {
    // Only first-party code; skip metro virtual modules (`/app?ctx=...`).
    if (!/^\/(src|app)\//.test(source) && !/^\/(src|app)$/.test(source)) return;
    if (source.includes("?")) return;
    const content = map.sourcesContent[i];
    if (typeof content !== "string") return;
    // Binary assets (png etc.) ride the map with null/placeholder content.
    if (/\.(png|jpg|jpeg|gif|webp|ttf|otf)$/.test(source)) return;
    checked += 1;
    const committed = gitShow(source);
    if (committed === null) {
      mismatches.push(`${source} — not in ${rev}`);
    } else if (committed !== content) {
      mismatches.push(`${source} — differs from ${rev}`);
    }
  });
}

if (mismatches.length > 0) {
  console.error(
    `EXPORT DOES NOT MATCH ${rev} — refusing. ${mismatches.length} file(s) drifted:`,
  );
  for (const m of mismatches) console.error(`  ${m}`);
  process.exit(1);
}
console.log(`OK: ${checked} bundled first-party files match ${rev}.`);
