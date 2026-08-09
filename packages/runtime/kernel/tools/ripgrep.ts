import { promises as fs } from "fs";
import path from "path";
import type { ToolContext } from "./types.js";

const __dirname = import.meta.dirname;

let cachedRipgrepPath: string | null = null;
let pendingResolve: Promise<string | null> | null = null;

const executableName = () => (process.platform === "win32" ? "rg.exe" : "rg");

const isExecutableFile = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(
      filePath,
      process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
    );
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const pathEntries = (): string[] => {
  const rawPath = process.env.PATH ?? process.env.Path ?? "";
  return rawPath.split(path.delimiter).filter(Boolean);
};

const pathExts = (): string[] => {
  if (process.platform !== "win32") return [""];
  const raw =
    process.env.PATHEXT ?? process.env.PathExt ?? ".EXE;.CMD;.BAT;.COM";
  return raw.split(";").filter(Boolean);
};

const findOnPath = async (): Promise<string | null> => {
  const name = executableName();
  for (const entry of pathEntries()) {
    const direct = path.join(entry, name);
    if (await isExecutableFile(direct)) return direct;
    if (process.platform !== "win32" || path.extname(name)) continue;
    for (const ext of pathExts()) {
      const candidate = path.join(entry, `${name}${ext.toLowerCase()}`);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
};

const bundledCandidates = (context?: ToolContext): string[] => {
  const platformPackage = `sdk-${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`;
  const roots = [
    process.env.STELLA_APP_RESOURCES_PATH,
    context?.stellaAppDir,
    process.env.STELLA_APP_DIR,
    path.resolve(__dirname, "..", "..", ".."),
  ].filter((entry): entry is string => Boolean(entry?.trim()));
  return roots.flatMap((root) => [
    path.join(root, "node_modules", ".bin", executableName()),
    path.join(
      root,
      "node_modules",
      "@cursor",
      platformPackage,
      "bin",
      executableName(),
    ),
    path.join(root, "resources", "bin", executableName()),
    path.join(root, "bin", executableName()),
  ]);
};

const findBundledRipgrep = async (
  context?: ToolContext,
): Promise<string | null> => {
  for (const candidate of bundledCandidates(context)) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
};

export const resolveRipgrepPath = async (
  context?: ToolContext,
): Promise<string | null> => {
  if (cachedRipgrepPath && (await isExecutableFile(cachedRipgrepPath))) {
    return cachedRipgrepPath;
  }
  if (pendingResolve) return pendingResolve;

  pendingResolve = (async () => {
    const system = await findOnPath();
    if (system) return system;

    return await findBundledRipgrep(context);
  })();

  try {
    cachedRipgrepPath = await pendingResolve;
    return cachedRipgrepPath;
  } finally {
    pendingResolve = null;
  }
};

export const clearRipgrepPathCacheForTests = () => {
  cachedRipgrepPath = null;
  pendingResolve = null;
};
