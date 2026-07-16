import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const runtimeRoot = path.join(repoRoot, "packages", "runtime");
const rendererRoot = path.join(repoRoot, "packages", "desktop-ui", "src");
const desktopRoot = path.join(repoRoot, "packages", "desktop", "electron");
const ignoredDirectories = new Set(["node_modules", "dist", "dist-electron"]);
const sourceSuffixes = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
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

const offenders = [];
const inspect = async (root, isForbidden) => {
  for (const file of await walk(root)) {
    const text = await readFile(file, "utf8");
    for (const specifier of moduleSpecifiers(text)) {
      const reason = isForbidden(specifier);
      if (reason) {
        offenders.push({
          file: path.relative(repoRoot, file).replace(/\\/g, "/"),
          specifier,
          reason,
        });
      }
    }
  }
};

await inspect(runtimeRoot, (specifier) => {
  if (specifier === "@stella/desktop" || specifier.startsWith("@stella/desktop/")) {
    return "runtime must not depend on desktop";
  }
  if (specifier === "@stella/desktop-ui" || specifier.startsWith("@stella/desktop-ui/")) {
    return "runtime must not depend on desktop-ui";
  }
  if (/\.\.\/.*(?:desktop|desktop-ui)\//.test(specifier)) {
    return "runtime must not reach into desktop packages by relative path";
  }
  return null;
});

await inspect(rendererRoot, (specifier) => {
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

await inspect(desktopRoot, (specifier) => {
  if (/\.\.\/.*runtime\//.test(specifier)) {
    return "Electron must use @stella/runtime workspace exports";
  }
  return null;
});

if (offenders.length > 0) {
  console.error("Workspace dependency boundary violations:");
  for (const offender of offenders) {
    console.error(`- ${offender.file}: ${offender.specifier} (${offender.reason})`);
  }
  process.exit(1);
}
