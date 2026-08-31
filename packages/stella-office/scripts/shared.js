import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";

export const __dirname = import.meta.dirname;
export const projectRoot = join(__dirname, "..");
export const binDir = join(projectRoot, "bin");
export const officeCliRoot = join(projectRoot, "vendor", "officecli");
export const officeCliBuildScript = join(officeCliRoot, "build.sh");
export const officeCliProjectFile = join(
  officeCliRoot,
  "src",
  "officecli",
  "officecli.csproj",
);
export const officeInstallManifestName = ".stella-office.json";
export const OFFICECLI_RELEASE_BASE_URL =
  "https://github.com/iOfficeAI/OfficeCLI/releases/download";

const PLATFORM_TABLE = {
  "darwin-arm64": { os: "darwin", arch: "arm64", asset: "officecli-mac-arm64" },
  "darwin-x64": { os: "darwin", arch: "x64", asset: "officecli-mac-x64" },
  "linux-arm64": {
    os: "linux",
    arch: "arm64",
    asset: "officecli-linux-arm64",
  },
  "linux-x64": { os: "linux", arch: "x64", asset: "officecli-linux-x64" },
  "win32-arm64": {
    os: "win32",
    arch: "arm64",
    asset: "officecli-win-arm64.exe",
  },
  "win32-x64": { os: "win32", arch: "x64", asset: "officecli-win-x64.exe" },
};

const PLATFORM_ALIASES = {
  "win-arm64": "win32-arm64",
  "win-x64": "win32-x64",
};

export const getHostPlatformKey = () => `${platform()}-${arch()}`;

export const normalizeOfficePlatform = (platformKey = getHostPlatformKey()) => {
  const normalized = PLATFORM_ALIASES[platformKey] ?? platformKey;
  const spec = PLATFORM_TABLE[normalized];
  if (!spec) {
    throw new Error(`Unsupported OfficeCLI platform: ${platformKey}`);
  }
  return { key: normalized, ...spec };
};

export const getPlatformKey = () => normalizeOfficePlatform().key;

export const getBinaryTargetName = (platformKey) => {
  const spec = normalizeOfficePlatform(platformKey);
  const ext = spec.os === "win32" ? ".exe" : "";
  return `stella-office-${spec.os}-${spec.arch}${ext}`;
};

export const getOfficeCliAssetName = (platformKey) =>
  normalizeOfficePlatform(platformKey).asset;

export const getOfficeCliReleaseBinaryPath = (platformKey) =>
  join(officeCliRoot, "bin", "release", getOfficeCliAssetName(platformKey));

export const getBundledBinaryPath = (platformKey) =>
  join(binDir, getBinaryTargetName(platformKey));

export const getOfficeInstallManifestPath = () =>
  join(binDir, officeInstallManifestName);

export const ensureBinDir = () => {
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }
};

export const finalizeBundledBinary = (targetPath = getBundledBinaryPath()) => {
  ensureBinDir();
  if (process.platform !== "win32") {
    chmodSync(targetPath, 0o755);
  }
};
