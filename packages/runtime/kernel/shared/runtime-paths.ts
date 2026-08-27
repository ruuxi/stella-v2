import { existsSync } from "node:fs";
import path from "node:path";

const moduleDir = import.meta.dirname;

let cachedRoot: string | null = null;

export function getStellaAppDir(): string {
  if (cachedRoot) return cachedRoot;

  const fromEnv = process.env.STELLA_APP_DIR?.trim();
  if (fromEnv) {
    cachedRoot = fromEnv;
    return cachedRoot;
  }

  let dir = moduleDir;
  for (let i = 0; i < 16; i += 1) {
    if (
      existsSync(path.join(dir, "package.json")) &&
      existsSync(path.join(dir, "packages", "runtime"))
    ) {
      cachedRoot = dir;
      return cachedRoot;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cachedRoot = path.resolve(moduleDir, "..", "..", "..", "..");
  return cachedRoot;
}

export function resolveRuntimeSourceAsset(...segments: string[]): string {
  const root = getStellaAppDir();
  const resourcesPath = process.env.STELLA_APP_RESOURCES_PATH?.trim();
  const candidates = [
    ...(resourcesPath
      ? [path.join(resourcesPath, "runtime", ...segments)]
      : []),
    path.join(root, "packages", "runtime", ...segments),
    path.join(root, "packages", "desktop", "dist-electron", "runtime", ...segments),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function resolveBundledRuntimeFile(relativeToRuntimeRoot: string): string {
  const root = getStellaAppDir();
  const resourcesPath = process.env.STELLA_APP_RESOURCES_PATH?.trim();
  const segments = relativeToRuntimeRoot.replace(/\\/g, "/").split("/");
  const sourceSegments = segments.map((segment, index) =>
    index === segments.length - 1 ? segment.replace(/\.js$/, ".ts") : segment,
  );
  const candidates = [
    ...(resourcesPath
      ? [path.join(resourcesPath, "runtime", ...segments)]
      : []),
    path.join(root, "packages", "desktop", "dist-electron", "runtime", ...segments),
    path.join(root, "packages", "runtime", ...sourceSegments),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
