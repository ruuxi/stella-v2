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
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-darwin-aarch64.zip",
      sha256:
        "90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f",
      archive: "zip",
      executable: "bun-darwin-aarch64/bun",
    },
    node: {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz",
      sha256:
        "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
      archive: "tar.gz",
      root: "node-v24.21.0-darwin-arm64",
    },
    python: {
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-aarch64-apple-darwin-install_only_stripped.tar.gz",
      sha256:
        "ad8d0c637c0a36b967b310e2c07254f4d2ca8cabaa7699e55ed6290aceb481a2",
      archive: "tar.gz",
      root: "python",
    },
    ripgrep: {
      url: "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin.tar.gz",
      sha256:
        "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
      archive: "tar.gz",
      executable: "ripgrep-15.2.0-aarch64-apple-darwin/rg",
    },
    uv: {
      url: "https://github.com/astral-sh/uv/releases/download/0.12.23/uv-aarch64-apple-darwin.tar.gz",
      sha256:
        "50487ae565ccd96e499056b4674d438f4c53170202617b4c759defe0c6a1b544",
      archive: "tar.gz",
      executable: "uv-aarch64-apple-darwin/uv",
    },
  },
  "darwin-x64": {
    bun: {
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-darwin-x64.zip",
      sha256:
        "80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012",
      archive: "zip",
      executable: "bun-darwin-x64/bun",
    },
    node: {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-x64.tar.gz",
      sha256:
        "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
      archive: "tar.gz",
      root: "node-v24.21.0-darwin-x64",
    },
    python: {
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-x86_64-apple-darwin-install_only_stripped.tar.gz",
      sha256:
        "562c30864ece2cb1d3e0ad66a1acd498611a47e5a10ce81b99158bef1ccbd355",
      archive: "tar.gz",
      root: "python",
    },
    ripgrep: {
      url: "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-apple-darwin.tar.gz",
      sha256:
        "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
      archive: "tar.gz",
      executable: "ripgrep-15.2.0-x86_64-apple-darwin/rg",
    },
    uv: {
      url: "https://github.com/astral-sh/uv/releases/download/0.12.23/uv-x86_64-apple-darwin.tar.gz",
      sha256:
        "960da44cb4b73685206ddd250b19e0a117fa41095710c1038f081f5cb613efb4",
      archive: "tar.gz",
      executable: "uv-x86_64-apple-darwin/uv",
    },
  },
  "win-x64": {
    bun: {
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-windows-x64.zip",
      sha256:
        "ce4c17497b2f29712a99d3d53f028de28cd42e3bacb8589599e7f000e49b6405",
      archive: "zip",
      executable: "bun-windows-x64/bun.exe",
    },
    node: {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip",
      sha256:
        "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
      archive: "zip",
      root: "node-v24.21.0-win-x64",
    },
    python: {
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
      sha256:
        "6fba7f2ae506facf41d457ea8293c7497910a675c69a4e954875169410a50402",
      archive: "tar.gz",
      root: "python",
    },
    ripgrep: {
      url: "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip",
      sha256:
        "SHA256",
      archive: "zip",
      executable: "ripgrep-15.2.0-x86_64-pc-windows-msvc/rg.exe",
    },
    uv: {
      url: "https://github.com/astral-sh/uv/releases/download/0.12.23/uv-x86_64-pc-windows-msvc.zip",
      sha256:
        "75d05de6762778c31ee183398de7dd15093fad0ed90b1f236d8205ea5ec00c90",
      archive: "zip",
      executable: "uv.exe",
    },
  },
  "linux-x64": {
    bun: {
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip",
      sha256:
        "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913",
      archive: "zip",
      executable: "bun-linux-x64/bun",
    },
    node: {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz",
      sha256:
        "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
      archive: "tar.gz",
      root: "node-v24.21.0-linux-x64",
    },
    python: {
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
      sha256:
        "731af898886c5f821890dc901eca3c651cca8e51fa7308c159d12a1194aeac91",
      archive: "tar.gz",
      root: "python",
    },
    // musl build for glibc-independent portability across distros.
    ripgrep: {
      url: "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz",
      sha256:
        "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
      archive: "tar.gz",
      executable: "ripgrep-15.2.0-x86_64-unknown-linux-musl/rg",
    },
    uv: {
      url: "https://github.com/astral-sh/uv/releases/download/0.12.23/uv-x86_64-unknown-linux-gnu.tar.gz",
      sha256:
        "9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6",
      archive: "tar.gz",
      executable: "uv-x86_64-unknown-linux-gnu/uv",
    },
  },
};

// The Linux beta deliberately ships no bundled git runtime: the hosted
// git-runtime manifest has no linux asset, and a relocatable Linux git is
// fiddly (libc/exec-path assumptions). Packaged Linux installs fall back to
// system git (see bundled-runtime-environment.ts).
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
