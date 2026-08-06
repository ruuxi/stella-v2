import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const GIT_VERSION = "2.53.0";
const GIT_MANIFEST_URL = `https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/git-runtime/versions/${GIT_VERSION}/manifest.json`;

const PLATFORM_ASSETS = {
  "darwin-arm64": {
    bun: {
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip",
      sha256:
        "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
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
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-x64.zip",
      sha256:
        "4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633",
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
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-windows-x64.zip",
      sha256:
        "0a0620930b6675d7ba440e81f4e0e00d3cfbe096c4b140d3fff02205e9e18922",
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
};

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

const run = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
};

const extractArchive = (archivePath, archiveType, destination) => {
  mkdirSync(destination, { recursive: true });
  if (archiveType === "tar.gz") {
    run("tar", ["-xzf", archivePath, "-C", destination]);
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
      }
    }

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
