import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  promises as fsPromises,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const scriptDir = import.meta.dirname;
const repoRootDir = path.resolve(scriptDir, "..", "..", "..");
const electronDir = path.join(repoRootDir, "node_modules", "electron");

function log(message) {
  console.log(`[ensure-electron-binary] ${message}`);
}

function getPlatformPath(platform) {
  switch (platform) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(
        `Electron builds are not available on platform: ${platform}`,
      );
  }
}

function readElectronVersion() {
  const pkg = JSON.parse(
    readFileSync(path.join(electronDir, "package.json"), "utf8"),
  );
  return pkg.version;
}

export function isElectronBinaryHealthy() {
  if (!existsSync(electronDir)) {

    return true;
  }

  try {
    const version = readElectronVersion();

    const installedVersion = readFileSync(
      path.join(electronDir, "dist", "version"),
      "utf8",
    )
      .trim()
      .replace(/^v/, "");
    if (installedVersion !== version) {
      return false;
    }

    const recordedPath = readFileSync(
      path.join(electronDir, "path.txt"),
      "utf8",
    ).trim();
    if (!recordedPath) {
      return false;
    }

    return existsSync(path.join(electronDir, "dist", recordedPath));
  } catch {
    return false;
  }
}

function resolveDownloadArch() {
  let arch =
    process.env.ELECTRON_INSTALL_ARCH ||
    process.env.npm_config_arch ||
    process.arch;

  if (
    process.platform === "darwin" &&
    arch === "x64" &&
    process.env.npm_config_arch === undefined
  ) {

    try {
      const output = spawnSync("sysctl", ["-in", "sysctl.proc_translated"], {
        encoding: "utf8",
      });
      if (output.status === 0 && output.stdout.trim() === "1") {
        arch = "arm64";
      }
    } catch {

    }
  }

  return arch;
}

function extractZipNatively(zipPath, distDir) {
  rmSync(distDir, { force: true, recursive: true });
  mkdirSync(distDir, { recursive: true });

  const attempts =
    process.platform === "darwin"
      ? [["ditto", ["-x", "-k", zipPath, distDir]]]
      : process.platform === "win32"
        ? [
            ["tar", ["-xf", zipPath, "-C", distDir]],
            [
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${distDir.replace(/'/g, "''")}' -Force`,
              ],
            ],
          ]
        : [
            ["unzip", ["-o", zipPath, "-d", distDir]],
            ["tar", ["-xf", zipPath, "-C", distDir]],
          ];

  let lastError = "no extraction tool succeeded";
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (!result.error && result.status === 0) {
      return;
    }
    lastError = result.error
      ? result.error.message
      : `${command} exited with code ${result.status}`;
  }

  throw new Error(`Failed to extract Electron zip: ${lastError}`);
}

export async function ensureElectronBinary() {
  if (isElectronBinaryHealthy()) {
    return;
  }

  if (!existsSync(electronDir)) {
    return;
  }

  log("Electron binary is missing or incomplete; repairing...");

  const require = createRequire(import.meta.url);

  const electronRequire = createRequire(
    require.resolve("electron/package.json"),
  );
  const { downloadArtifact } = electronRequire("@electron/get");

  const version = readElectronVersion();
  const platform =
    process.env.ELECTRON_INSTALL_PLATFORM ||
    process.env.npm_config_platform ||
    process.platform;
  const arch = resolveDownloadArch();
  const platformPath = getPlatformPath(platform);

  let checksums;
  try {
    checksums = require(path.join(electronDir, "checksums.json"));
  } catch {
    checksums = undefined;
  }

  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    force: false,
    checksums,
    platform,
    arch,
  });

  const distDir = path.join(electronDir, "dist");
  extractZipNatively(zipPath, distDir);

  const srcTypeDefPath = path.join(distDir, "electron.d.ts");
  if (existsSync(srcTypeDefPath)) {
    renameSync(srcTypeDefPath, path.join(electronDir, "electron.d.ts"));
  }

  await fsPromises.writeFile(path.join(electronDir, "path.txt"), platformPath);

  if (!isElectronBinaryHealthy()) {
    throw new Error(
      "Electron binary still looks incomplete after re-extraction.",
    );
  }

  log(`Repaired Electron ${version} (${platform}/${arch}).`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  ensureElectronBinary().catch((error) => {
    console.error(
      `[ensure-electron-binary] ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
    process.exit(1);
  });
}
