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

const MOBILE_SOURCE_PREFIX = "/packages/mobile";

const gitShow = (path: string): string | null => {
  try {
    return execFileSync("git", ["show", `${rev}:packages/mobile${path}`], {
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
    if (!source.startsWith(`${MOBILE_SOURCE_PREFIX}/`)) return;
    const mobileSource = source.slice(MOBILE_SOURCE_PREFIX.length);

    if (
      !/^\/(src|app)\//.test(mobileSource) &&
      !/^\/(src|app)$/.test(mobileSource)
    ) {
      return;
    }
    if (mobileSource.includes("?")) return;
    const content = map.sourcesContent[i];
    if (typeof content !== "string") return;

    if (/\.(png|jpg|jpeg|gif|webp|ttf|otf)$/.test(mobileSource)) return;
    checked += 1;
    const committed = gitShow(mobileSource);
    if (committed === null) {
      mismatches.push(`${mobileSource} — not in ${rev}`);
    } else if (committed !== content) {
      mismatches.push(`${mobileSource} — differs from ${rev}`);
    }
  });
}

if (checked === 0) {
  console.error(
    "No bundled first-party files were verified — refusing to publish.",
  );
  process.exit(1);
}

if (mismatches.length > 0) {
  console.error(
    `EXPORT DOES NOT MATCH ${rev} — refusing. ${mismatches.length} file(s) drifted:`,
  );
  for (const m of mismatches) console.error(`  ${m}`);
  process.exit(1);
}
console.log(`OK: ${checked} bundled first-party files match ${rev}.`);
