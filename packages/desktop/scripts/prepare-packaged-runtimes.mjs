import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const GIT_VERSION = "2.53.0";
const GIT_MANIFEST_URL = `https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/git-runtime/versions/${GIT_VERSION}/manifest.json`;

const PLATFORM_ASSETS = {
  "darwin-arm64": {
    bun: {
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-aarch64.zip",
      sha256:
        "c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381",
      archive: "zip",
      executable: "bun-darwin-aarch64/bun",
    },
    node: {
      url: "https://nodejs.org/dist/v24.14.1/node-v24.14.1-darwin-arm64.tar.gz",
      sha256:
        "25495ff85bd89e2d8a24d88566d7e2f827c6b0d3d872b2cebf75371f93fcb1fe",
      archive: "tar.gz",
      root: "node-v24.14.1-darwin-arm64",
    },
    python: {
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260211/cpython-3.12.12%2B20260211-aarch64-apple-darwin-install_only_stripped.tar.gz",
      sha256:
        "22625deaf5757e7c266cf1a096c9151a06b598b1e14632a2ec9993d58ec5fe84",
      archive: "tar.gz",
      root: "python",
    },
    ripgrep: {
      url: "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-aarch64-apple-darwin.tar.gz",
      sha256:
        "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
      archive: "tar.gz",
      executable: "ripgrep-15.1.0-aarch64-apple-darwin/rg",
    },
    uv: {
      url: "https://github.com/astral-sh/uv/releases/download/0.11.32/uv-aarch64-apple-darwin.tar.gz",
      sha256:
        "ed336d0ba49db8ef89b2b41fffa372ce63bd032f22a56f001c265891aec32829",
      archive: "tar.gz",
      executable: "uv-aarch64-apple-darwin/uv",
    },
  },
  "darwin-x64": {
    bun: {
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-x64.zip",
      sha256:
        "1d0211b8f1dc991182344687ad15e72ee86f154845a5f7fa477994cd341dd9b0",
      archive: "zip",
      executable: "bun-darwin-x64/bun",
    },
    node: {
      url: "https://nodejs.org/dist/v24.14.1/node-v24.14.1-darwin-x64.tar.gz",
      sha256:
        "2526230ad7d922be82d4fdb1e7ee1e84303e133e3b4b0ec4c2897ab31de0253d",
      archive: "tar.gz",
      root: "node-v24.14.1-darwin-x64",
    },
    python: {
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260211/cpython-3.12.12%2B20260211-x86_64-apple-darwin-install_only_stripped.tar.gz",
      sha256:
        "a84ac7a36d465bc6eb68db84540fdb5da04333900e2c3cb34b5d454f2022048c",
      archive: "tar.gz",
      root: "python",
    },
    ripgrep: {
      url: "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-apple-darwin.tar.gz",
      sha256:
        "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
      archive: "tar.gz",
      executable: "ripgrep-15.1.0-x86_64-apple-darwin/rg",
    },
    uv: {
      url: "https://github.com/astral-sh/uv/releases/download/0.11.32/uv-x86_64-apple-darwin.tar.gz",
      sha256:
        "77f5ca26c0de20e992a3677a174fe1121ee25c36f9b1434a863f75bf077a05eb",
      archive: "tar.gz",
      executable: "uv-x86_64-apple-darwin/uv",
    },
  },
  "win-x64": {
    bun: {
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-windows-x64.zip",
      sha256:
        "e6f093d39da486b20262ca8cdd5ed6a9e8bc9c2f275b78e6d3a0c5b28cc95901",
      archive: "zip",
      executable: "bun-windows-x64/bun.exe",
    },
    node: {
      url: "https://nodejs.org/dist/v24.14.1/node-v24.14.1-win-x64.zip",
      sha256:
        "6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70",
      archive: "zip",
      root: "node-v24.14.1-win-x64",
    },
    python: {
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260211/cpython-3.12.12%2B20260211-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
      sha256:
        "93bf8e8c05ede0077b197a29c99ebdaf253497f27190097494265150b4e70ba8",
      archive: "tar.gz",
      root: "python",
    },
    ripgrep: {
      url: "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-pc-windows-msvc.zip",
      sha256:
        "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
      archive: "zip",
      executable: "ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe",
    },
    uv: {
      url: "https://github.com/astral-sh/uv/releases/download/0.11.32/uv-x86_64-pc-windows-msvc.zip",
      sha256:
        "acfde570451cfdb8689fa159a138ee805ba4e241c466432750302c86254b0984",
      archive: "zip",
      executable: "uv.exe",
    },
  },
  "linux-x64": {
    bun: {
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64.zip",
      sha256:
        "2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452",
      archive: "zip",
      executable: "bun-linux-x64/bun",
    },
    node: {
      url: "https://nodejs.org/dist/v24.14.1/node-v24.14.1-linux-x64.tar.gz",
      sha256:
        "ace9fa104992ed0829642629c46ca7bd7fd6e76278cb96c958c4b387d29658ea",
      archive: "tar.gz",
      root: "node-v24.14.1-linux-x64",
    },
    python: {
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260211/cpython-3.12.12%2B20260211-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
      sha256:
        "1dbaa624a09e15afe7efbdac08d42993135a68db8d34f986ef6977a6d77bdc3c",
      archive: "tar.gz",
      root: "python",
    },

    ripgrep: {
      url: "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz",
      sha256:
        "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
      archive: "tar.gz",
      executable: "ripgrep-15.1.0-x86_64-unknown-linux-musl/rg",
    },
    uv: {
      url: "https://github.com/astral-sh/uv/releases/download/0.11.32/uv-x86_64-unknown-linux-gnu.tar.gz",
      sha256:
        "aab924fd522efd06f1c5f3b93a243864fc453132c94b2dc49f1371b528a4b967",
      archive: "tar.gz",
      executable: "uv-x86_64-unknown-linux-gnu/uv",
    },
  },
};

const GITLESS_PLATFORMS = new Set(["linux-x64"]);

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const resourcesRoot = path.join(repoRoot, "packages", "desktop", "resources");
const binOutput = path.join(resourcesRoot, "bun", "current");
const gitOutput = path.join(resourcesRoot, "git", "current");
const nodeOutput = path.join(resourcesRoot, "node", "current");
const pythonOutput = path.join(resourcesRoot, "python", "current");

const parseArgs = () => {
  const args = process.argv.slice(2);
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--platform") result.platform = args[++index];
    else if (args[index] === "--git-manifest-file") {
      result.gitManifestFile = args[++index];
    } else throw new Error(`Unknown argument: ${args[index]}`);
  }
  return result;
};

const hostPlatform = () => {
  if (process.platform === "darwin" && process.arch === "arm64")
    return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64")
    return "darwin-x64";
  if (process.platform === "win32" && process.arch === "x64") return "win-x64";
  if (process.platform === "linux" && process.arch === "x64")
    return "linux-x64";
  throw new Error(
    `Unsupported packaging host: ${process.platform}-${process.arch}`,
  );
};

const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });

const fetchWithRetries = async (url, attempts = 4) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "stella-packager" },
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
  }
  throw new Error(
    `Could not download ${url}: ${lastError?.message ?? lastError}`,
  );
};

const downloadAsset = async (asset, destination) => {
  const response = await fetchWithRetries(asset.url);
  await pipeline(response.body, createWriteStream(destination));
  const actual = await sha256File(destination);
  if (actual !== asset.sha256) {
    throw new Error(`Checksum mismatch for ${asset.url}: ${actual}`);
  }
  const contentLength = response.headers.get("content-length");
  if (asset.size && contentLength && Number(contentLength) !== asset.size) {
    throw new Error(`Size mismatch for ${asset.url}`);
  }
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
};

const extractArchive = (archivePath, archiveType, destination) => {
  mkdirSync(destination, { recursive: true });
  if (archiveType === "tar.gz") {
    const archiveDirectory = path.dirname(archivePath);
    run(
      "tar",
      [
        "-xzf",
        path.basename(archivePath),
        "-C",
        path.relative(archiveDirectory, destination),
      ],
      { cwd: archiveDirectory },
    );
    return;
  }
  if (process.platform === "win32") {
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$global:ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`,
    ]);
    return;
  }
  run("unzip", ["-q", archivePath, "-d", destination]);
};

const installTree = (source, destination) => {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
};

const installExecutable = (source, destination) => {
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (process.platform !== "win32") chmodSync(destination, 0o755);
};

const normalizeWindowsNodeLayout = () => {
  const modulesDirectory = path.join(nodeOutput, "node_modules");
  for (const packageName of ["npm", "corepack"]) {
    renameSync(
      path.join(modulesDirectory, packageName),
      path.join(nodeOutput, `${packageName}-dist`),
    );
  }
  rmSync(modulesDirectory, { recursive: true, force: true });

  for (const launcherName of [
    "npm",
    "npm.cmd",
    "npm.ps1",
    "npx",
    "npx.cmd",
    "npx.ps1",
    "corepack",
    "corepack.cmd",
    "corepack.ps1",
  ]) {
    const launcherPath = path.join(nodeOutput, launcherName);
    if (!existsSync(launcherPath)) continue;
    const normalized = readFileSync(launcherPath, "utf8")
      .replaceAll("node_modules\\npm", "npm-dist")
      .replaceAll("node_modules/npm", "npm-dist")
      .replaceAll("node_modules\\corepack", "corepack-dist")
      .replaceAll("node_modules/corepack", "corepack-dist");
    writeFileSync(launcherPath, normalized);
  }
};

const loadGitManifest = async (manifestFile) => {
  const manifest = manifestFile
    ? JSON.parse(readFileSync(path.resolve(manifestFile), "utf8"))
    : await (await fetchWithRetries(GIT_MANIFEST_URL)).json();
  if (manifest.schemaVersion !== 1 || manifest.version !== GIT_VERSION) {
    throw new Error(`Unsupported Git runtime manifest: ${manifest.version}`);
  }
  return manifest;
};

const main = async () => {
  const args = parseArgs();
  const platform = args.platform ?? hostPlatform();
  const config = PLATFORM_ASSETS[platform];
  if (!config) throw new Error(`Unsupported target platform: ${platform}`);

  const scratch = mkdtempSync(
    path.join(os.tmpdir(), "stella-packaged-runtimes-"),
  );
  try {
    rmSync(binOutput, { recursive: true, force: true });
    mkdirSync(binOutput, { recursive: true });

    for (const [name, asset] of Object.entries(config)) {
      const archivePath = path.join(
        scratch,
        `${name}.${asset.archive === "zip" ? "zip" : "tar.gz"}`,
      );
      const extractDir = path.join(scratch, `${name}-extract`);
      console.log(`[packaging] Downloading ${name} for ${platform}.`);
      await downloadAsset(asset, archivePath);
      extractArchive(archivePath, asset.archive, extractDir);
      if (asset.executable) {
        const commandName = name === "ripgrep" ? "rg" : name;
        installExecutable(
          path.join(extractDir, asset.executable),
          path.join(
            binOutput,
            platform.startsWith("win-") ? `${commandName}.exe` : commandName,
          ),
        );
      } else {
        installTree(
          path.join(extractDir, asset.root),
          name === "node" ? nodeOutput : pythonOutput,
        );
        if (name === "node" && platform === "win-x64") {
          normalizeWindowsNodeLayout();
        }
      }
    }

    if (GITLESS_PLATFORMS.has(platform)) {
      console.log(
        `[packaging] Skipping git runtime for ${platform}; packaged installs use system git.`,
      );
      rmSync(gitOutput, { recursive: true, force: true });
      mkdirSync(gitOutput, { recursive: true });
      writeFileSync(
        path.join(gitOutput, "README.txt"),
        "Stella for Linux (beta) does not bundle a git runtime.\nPackaged installs use the git found on the system PATH.\n",
      );
    } else {
      const gitManifest = await loadGitManifest(args.gitManifestFile);
      const gitAsset = gitManifest.assets?.[platform];
      if (!gitAsset?.url || !gitAsset?.sha256) {
        throw new Error(`Git runtime manifest does not contain ${platform}.`);
      }
      const gitArchive = path.join(scratch, "git.tar.gz");
      const gitExtract = path.join(scratch, "git-extract");
      console.log(`[packaging] Downloading git for ${platform}.`);
      await downloadAsset(gitAsset, gitArchive);
      extractArchive(gitArchive, "tar.gz", gitExtract);
      installTree(gitExtract, gitOutput);
    }

    if (platform.startsWith("darwin-")) {
      for (const executable of ["bun", "rg", "uv"]) {
        run("/usr/bin/codesign", [
          "--force",
          "--sign",
          "-",
          path.join(binOutput, executable),
        ]);
      }
    }

    console.log(`[packaging] Prepared managed runtimes for ${platform}.`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

await main();
