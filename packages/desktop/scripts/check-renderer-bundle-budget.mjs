import fs from "node:fs";
import path from "node:path";
import { verifyRendererAssetPaths } from "./verify-renderer-asset-paths.mjs";

const distDir = path.resolve("dist");
const assetsDir = path.join(distDir, "assets");

const budgets = {
  maxJsAssetBytes: 2_000_000,
  maxCssAssetBytes: 400_000,
  maxRendererBytes: 24_000_000,
  // Every JS file the main window fetches before it can render: the entry
  // script plus its modulepreload list, i.e. the entry's static import graph.
  // Was 2.95 MB while lazy-only vendors (pdfjs, recharts) leaked onto it;
  // ~2.2 MB after. Ratchet down as the boot path gets lighter.
  maxMainCriticalJsBytes: 2_300_000,
};

// Packages only reachable through lazy imports. Finding one on the main
// window's critical path means a shared module was captured into its chunk.
const lazyOnlyChunkPattern = /^vendor-(pdfjs-dist|react-pdf|recharts)-/;

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
};

const walkFiles = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(target);
    if (!entry.isFile()) return [];
    return [target];
  });
};

if (!fs.existsSync(distDir) || !fs.existsSync(assetsDir)) {
  throw new Error(
    "Renderer dist is missing. Run vite build before bundle budget checks.",
  );
}

verifyRendererAssetPaths({ distDir });

const files = walkFiles(distDir).map((file) => {
  const stat = fs.statSync(file);
  return {
    file,
    relative: path.relative(distDir, file),
    size: stat.size,
  };
});

const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
const jsAssets = files.filter((file) => file.relative.endsWith(".js"));
const cssAssets = files.filter((file) => file.relative.endsWith(".css"));
const largestJs = jsAssets.reduce(
  (largest, file) => (file.size > largest.size ? file : largest),
  { size: 0, relative: "" },
);
const largestCss = cssAssets.reduce(
  (largest, file) => (file.size > largest.size ? file : largest),
  { size: 0, relative: "" },
);

const failures = [];
if (largestJs.size > budgets.maxJsAssetBytes) {
  failures.push(
    `Largest JS asset ${largestJs.relative} is ${formatBytes(largestJs.size)}; budget is ${formatBytes(budgets.maxJsAssetBytes)}.`,
  );
}
if (largestCss.size > budgets.maxCssAssetBytes) {
  failures.push(
    `Largest CSS asset ${largestCss.relative} is ${formatBytes(largestCss.size)}; budget is ${formatBytes(budgets.maxCssAssetBytes)}.`,
  );
}
if (totalBytes > budgets.maxRendererBytes) {
  failures.push(
    `Renderer dist is ${formatBytes(totalBytes)}; budget is ${formatBytes(budgets.maxRendererBytes)}.`,
  );
}

const mainHtml = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
const mainCriticalJs = [
  ...new Set(
    [
      ...mainHtml.matchAll(
        /<(?:script|link)\b[^>]*\b(?:src|href)="(?:\.\/|\/chat-app\/)?(assets\/[^"]+\.js)"/g,
      ),
    ].map((match) => match[1]),
  ),
];
if (mainCriticalJs.length === 0) {
  failures.push("Could not find the main window's entry script in index.html.");
}
const mainCriticalJsBytes = mainCriticalJs.reduce(
  (sum, relative) => sum + fs.statSync(path.join(distDir, relative)).size,
  0,
);
if (mainCriticalJsBytes > budgets.maxMainCriticalJsBytes) {
  failures.push(
    `Main window critical-path JS is ${formatBytes(mainCriticalJsBytes)}; budget is ${formatBytes(budgets.maxMainCriticalJsBytes)}.`,
  );
}
const leakedLazyChunks = mainCriticalJs.filter((relative) =>
  lazyOnlyChunkPattern.test(path.basename(relative)),
);
if (leakedLazyChunks.length > 0) {
  failures.push(
    `Lazy-only chunks are on the main window's critical path: ${leakedLazyChunks.join(", ")}.`,
  );
}

console.log(
  [
    `Renderer dist: ${formatBytes(totalBytes)}`,
    `Largest JS: ${largestJs.relative || "none"} ${formatBytes(largestJs.size)}`,
    `Largest CSS: ${largestCss.relative || "none"} ${formatBytes(largestCss.size)}`,
    `Main window critical-path JS: ${formatBytes(mainCriticalJsBytes)} across ${mainCriticalJs.length} files`,
  ].join("\n"),
);

if (failures.length > 0) {
  throw new Error(`Bundle budget exceeded:\n${failures.join("\n")}`);
}
