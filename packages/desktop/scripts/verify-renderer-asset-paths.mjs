import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER_TEXT_EXTENSIONS = new Set([".css", ".html", ".js"]);
const STATIC_ASSET_EXTENSION =
  "(?:css|gif|jpe?g|js|json|mjs|mp3|mp4|ogg|otf|pdf|png|svg|ttf|wasm|wav|webm|webp|woff2?)";
const QUOTED_ROOT_ASSET = new RegExp(
  `([\\"'\\x60])(/(?!/)[^\\"'\\x60\\s?#]+\\.${STATIC_ASSET_EXTENSION}(?:[?#][^\\"'\\x60\\s]*)?)\\1`,
  "gi",
);
const CSS_ROOT_ASSET = new RegExp(
  `url\\(\\s*([\\"']?)(/(?!/)[^\\"')\\s?#]+\\.${STATIC_ASSET_EXTENSION}(?:[?#][^\\"')\\s]*)?)\\1\\s*\\)`,
  "gi",
);

const walkFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(target);
    if (!entry.isFile()) return [];
    return [target];
  });

export const collectRootAbsoluteRendererAssetReferences = ({ distDir }) => {
  if (!fs.existsSync(distDir)) return [];
  const failures = [];
  for (const filePath of walkFiles(distDir)) {
    if (!RENDERER_TEXT_EXTENSIONS.has(path.extname(filePath))) continue;
    const source = fs.readFileSync(filePath, "utf8");
    for (const pattern of [QUOTED_ROOT_ASSET, CSS_ROOT_ASSET]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const reference = match[2];
        if (!reference) continue;
        failures.push({
          filePath,
          reference,
          offset: match.index ?? 0,
        });
      }
    }
  }
  return failures.filter(
    (failure, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.filePath === failure.filePath &&
          candidate.reference === failure.reference &&
          candidate.offset === failure.offset,
      ) === index,
  );
};

export const verifyRendererAssetPaths = ({ distDir }) => {
  const failures = collectRootAbsoluteRendererAssetReferences({ distDir });
  if (failures.length === 0) return;
  const details = failures
    .map(
      ({ filePath, reference }) =>
        `${path.relative(distDir, filePath)}: ${reference}`,
    )
    .join("\n");
  throw new Error(
    `Packaged renderer contains root-absolute static asset references. ` +
      `They resolve from the filesystem root under file://; use Vite's relative BASE_URL or resolve beside window.location.href.\n${details}`,
  );
};

const isCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isCli) {
  const distDir = path.resolve(process.argv[2] ?? "dist");
  verifyRendererAssetPaths({ distDir });
  console.log("Renderer asset paths are package-safe.");
}
