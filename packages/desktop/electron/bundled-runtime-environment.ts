import path from "node:path";
import os from "node:os";

type PackagedRuntimePaths = {
  bun: string;
  gitBin: string;
  gitRoot: string;
  node: string;
  python: string;
  uv: string;
};

const pathApiFor = (platform: NodeJS.Platform) =>
  platform === "win32" ? path.win32 : path.posix;

export const resolvePackagedRuntimePaths = (
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
): PackagedRuntimePaths => {
  const pathApi = pathApiFor(platform);
  const gitRoot = pathApi.join(resourcesPath, "runtimes", "git");
  const nodeRoot = pathApi.join(resourcesPath, "runtimes", "node");
  const pythonRoot = pathApi.join(resourcesPath, "runtimes", "python");
  return {
    bun: pathApi.join(
      resourcesPath,
      "bin",
      platform === "win32" ? "bun.exe" : "bun",
    ),
    gitBin: pathApi.join(
      gitRoot,
      platform === "win32" ? "cmd" : "bin",
      platform === "win32" ? "git.exe" : "git",
    ),
    gitRoot,
    node: pathApi.join(
      nodeRoot,
      ...(platform === "win32" ? ["node.exe"] : ["bin", "node"]),
    ),
    python: pathApi.join(
      pythonRoot,
      ...(platform === "win32" ? ["python.exe"] : ["bin", "python3"]),
    ),
    uv: pathApi.join(
      resourcesPath,
      "bin",
      platform === "win32" ? "uv.exe" : "uv",
    ),
  };
};

export const resolveBundledBunPath = (
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(
    resourcesPath,
    "bin",
    platform === "win32" ? "bun.exe" : "bun",
  );
};

export const configurePackagedBunEnvironment = (options: {
  resourcesPath: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): string => {
  const env = options.env ?? process.env;
  const existing = env.STELLA_BUN_PATH?.trim();
  if (existing) return existing;

  const bundledPath = resolveBundledBunPath(
    options.resourcesPath,
    options.platform,
  );
  env.STELLA_BUN_PATH = bundledPath;
  return bundledPath;
};

const prependPath = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  entries: string[],
) => {
  const pathApi = pathApiFor(platform);
  const pathKeys = Object.keys(env).filter(
    (key) => key.toLowerCase() === "path",
  );
  const pathKey = pathKeys[0] ?? "PATH";
  const existing = pathKeys.map((key) => env[key]).find(Boolean) ?? "";
  for (const duplicate of pathKeys.slice(1)) delete env[duplicate];
  const seen = new Set<string>();
  env[pathKey] = [...entries, ...existing.split(pathApi.delimiter)]
    .filter(Boolean)
    .filter((entry) => {
      const key = platform === "win32" ? entry.toLowerCase() : entry;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(pathApi.delimiter);
};

export const configurePackagedRuntimeEnvironment = (options: {
  resourcesPath: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): PackagedRuntimePaths => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = pathApiFor(platform);
  const runtimes = resolvePackagedRuntimePaths(options.resourcesPath, platform);

  env.STELLA_BUN_PATH ||= runtimes.bun;
  env.STELLA_UV_BIN ||= runtimes.uv;

  const pathEntries = [pathApi.join(options.resourcesPath, "bin")];

  if (!env.STELLA_NODE_BIN?.trim()) {
    env.STELLA_NODE_BIN = runtimes.node;
    env.STELLA_NODE_IS_ELECTRON = "0";
    pathEntries.push(pathApi.dirname(runtimes.node));
  }

  if (!env.STELLA_PYTHON_BIN?.trim()) {
    env.STELLA_PYTHON_BIN = runtimes.python;
    env.PYTHONDONTWRITEBYTECODE ||= "1";
    env.PIP_USER ||= "1";
    env.PYTHONUSERBASE ||=
      pathApi.join(
        env.STELLA_DATA_DIR?.trim() || pathApi.join(os.homedir(), ".stella"),
        "python",
      );
    pathEntries.push(pathApi.dirname(runtimes.python));
    if (platform === "win32") {
      pathEntries.push(
        pathApi.join(pathApi.dirname(runtimes.python), "Scripts"),
        pathApi.join(env.PYTHONUSERBASE, "Scripts"),
      );
    } else {
      pathEntries.push(pathApi.join(env.PYTHONUSERBASE, "bin"));
    }
  }

  if (platform !== "linux" && !env.STELLA_GIT_BIN?.trim()) {
    env.STELLA_GIT_BIN = runtimes.gitBin;
    env.LOCAL_GIT_DIRECTORY = runtimes.gitRoot;
    if (platform === "win32") {
      env.GIT_EXEC_PATH = pathApi.join(
        runtimes.gitRoot,
        "mingw64",
        "libexec",
        "git-core",
      );
      env.STELLA_GIT_BASH = pathApi.join(
        runtimes.gitRoot,
        "usr",
        "bin",
        "bash.exe",
      );
      pathEntries.push(
        pathApi.join(runtimes.gitRoot, "cmd"),
        pathApi.join(runtimes.gitRoot, "mingw64", "bin"),
        pathApi.join(runtimes.gitRoot, "usr", "bin"),
      );
    } else {
      env.GIT_EXEC_PATH = pathApi.join(runtimes.gitRoot, "libexec", "git-core");
      env.GIT_CONFIG_SYSTEM = pathApi.join(
        runtimes.gitRoot,
        "etc",
        "gitconfig",
      );
      env.GIT_TEMPLATE_DIR = pathApi.join(
        runtimes.gitRoot,
        "share",
        "git-core",
        "templates",
      );
      pathEntries.push(pathApi.join(runtimes.gitRoot, "bin"));
    }
  }

  prependPath(env, platform, pathEntries);
  return runtimes;
};
