#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  binDir,
  ensureBinDir,
  finalizeBundledBinary,
  getBinaryTargetName,
  getBundledBinaryPath,
  getOfficeCliAssetName,
  getOfficeInstallManifestPath,
  OFFICECLI_RELEASE_BASE_URL,
  officeInstallManifestName,
  normalizeOfficePlatform,
} from "./shared.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const version = packageJson.version;

const parseArgs = (argv) => {
  const result = {
    platform: undefined,
    force: false,
    bestEffort: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform" && argv[index + 1]) {
      result.platform = argv[++index];
    } else if (arg === "--force") {
      result.force = true;
    } else if (arg === "--best-effort") {
      result.bestEffort = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
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
        headers: { "User-Agent": "stella-office-packager" },
        redirect: "follow",
      });
      if (!response.ok) {
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
    `Could not download ${url}: ${lastError instanceof Error ? lastError.message : lastError}`,
  );
};

const parseChecksums = (text) => {
  const sums = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(\S+)$/u);
    if (!match) continue;
    sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
};

const readInstallManifest = () => {
  const manifestPath = getOfficeInstallManifestPath();
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
};

const removeOtherPlatformBinaries = (keepName) => {
  if (!existsSync(binDir)) return;
  for (const fileName of readdirSync(binDir)) {
    if (fileName === "stella-office.js") continue;
    if (fileName === officeInstallManifestName) continue;
    if (fileName === keepName) continue;
    if (
      fileName.startsWith("stella-office-") ||
      fileName.endsWith(".download")
    ) {
      unlinkSync(join(binDir, fileName));
    }
  }
};

const downloadToFile = async (url, destination) => {
  const response = await fetchWithRetries(url);
  if (!response.body) {
    throw new Error(`No response body for ${url}`);
  }
  await pipeline(response.body, createWriteStream(destination));
};

const alreadyInstalled = async ({
  force,
  version: expectedVersion,
  assetName,
  targetPath,
  expectedSha,
}) => {
  if (force || !existsSync(targetPath)) return false;
  const manifest = readInstallManifest();
  if (
    manifest?.version !== expectedVersion ||
    manifest?.assetName !== assetName ||
    typeof manifest?.sha256 !== "string"
  ) {
    return false;
  }
  const actualSha = await sha256File(targetPath);
  return actualSha === expectedSha && actualSha === manifest.sha256;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const spec = normalizeOfficePlatform(args.platform);
  const assetName = getOfficeCliAssetName(spec.key);
  const targetName = getBinaryTargetName(spec.key);
  const targetPath = getBundledBinaryPath(spec.key);
  const releaseDir = `${OFFICECLI_RELEASE_BASE_URL}/v${version}`;
  const checksumUrl = `${releaseDir}/SHA256SUMS`;
  const downloadUrl = `${releaseDir}/${assetName}`;

  ensureBinDir();
  const checksumText = await (await fetchWithRetries(checksumUrl)).text();
  const checksums = parseChecksums(checksumText);
  const expectedSha = checksums.get(assetName);
  if (!expectedSha) {
    throw new Error(`SHA256SUMS does not list ${assetName}`);
  }

  if (
    await alreadyInstalled({
      force: args.force,
      version,
      assetName,
      targetPath,
      expectedSha,
    })
  ) {
    finalizeBundledBinary(targetPath);
    console.log(`stella-office ${version} already present: ${targetPath}`);
    return;
  }

  const stagingPath = `${targetPath}.download`;
  console.log(`Downloading ${assetName} from ${downloadUrl}`);
  try {
    await downloadToFile(downloadUrl, stagingPath);
    const actualSha = await sha256File(stagingPath);
    if (actualSha !== expectedSha) {
      throw new Error(
        `Checksum mismatch for ${assetName}: ${actualSha} != ${expectedSha}`,
      );
    }
    renameSync(stagingPath, targetPath);
    finalizeBundledBinary(targetPath);
    removeOtherPlatformBinaries(targetName);
    writeFileSync(
      getOfficeInstallManifestPath(),
      `${JSON.stringify(
        {
          version,
          platform: spec.key,
          assetName,
          sha256: actualSha,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Downloaded native binary to ${targetPath}`);
  } catch (error) {
    try {
      unlinkSync(stagingPath);
    } catch {}
    throw error;
  }
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to download native binary: ${message}`);
  process.exit(process.argv.includes("--best-effort") ? 0 : 1);
}
