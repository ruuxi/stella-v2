import { createHash } from "node:crypto";
import { constants as fileConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { CloudHomeImportOwnership } from "@stella/contracts/cloud-home-sync";

const OWNER_FILE = ".cloud-home-import-owner.json";
const MAX_OWNER_FILE_BYTES = 1_024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const accountScopeDigest = (accountScope: string): string => {
  const normalized = accountScope.normalize("NFC").trim();
  if (
    !normalized.startsWith("account:") ||
    normalized !== accountScope ||
    normalized.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error("Connected account scope required for local import.");
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
};

const ownerPaths = async (stellaDataDir: string) => {
  if (!path.isAbsolute(stellaDataDir)) {
    throw new Error("Stella data directory must be absolute.");
  }
  const root = await fs.realpath(stellaDataDir);
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Stella data directory is unsafe.");
  }
  // Keep the marker directly under the already-resolved lifecycle root. A
  // nested marker directory would introduce another parent component that a
  // local process could swap between validation and O_NOFOLLOW open.
  return { marker: path.join(root, OWNER_FILE) };
};

const readMarkerDigest = async (
  stellaDataDir: string,
): Promise<string | "unclaimed" | "corrupt"> => {
  const paths = await ownerPaths(stellaDataDir);
  let stat;
  try {
    stat = await fs.lstat(paths.marker);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "unclaimed"
      : "corrupt";
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink > 1 ||
    stat.size < 2 ||
    stat.size > MAX_OWNER_FILE_BYTES
  ) {
    return "corrupt";
  }
  const noFollow =
    (fileConstants as typeof fileConstants & { O_NOFOLLOW?: number })
      .O_NOFOLLOW ?? 0;
  const handle = await fs
    .open(paths.marker, fileConstants.O_RDONLY | noFollow)
    .catch(() => null);
  if (!handle) return "corrupt";
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      opened.size !== stat.size ||
      (opened.ino !== 0 && stat.ino !== 0 && opened.ino !== stat.ino) ||
      (opened.dev !== 0 && stat.dev !== 0 && opened.dev !== stat.dev)
    ) {
      return "corrupt";
    }
    const raw = await handle.readFile("utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.ownerScopeSha256 !== "string" ||
      !SHA256_PATTERN.test(parsed.ownerScopeSha256) ||
      typeof parsed.confirmedAt !== "number" ||
      !Number.isFinite(parsed.confirmedAt) ||
      parsed.confirmedAt < 0
    ) {
      return "corrupt";
    }
    return parsed.ownerScopeSha256;
  } catch {
    return "corrupt";
  } finally {
    await handle.close();
  }
};

export const getLocalCloudHomeImportOwnership = async (
  stellaDataDir: string,
  accountScope: string,
): Promise<CloudHomeImportOwnership> => {
  let digest: string;
  try {
    digest = accountScopeDigest(accountScope);
  } catch {
    return "anonymous";
  }
  const marker = await readMarkerDigest(stellaDataDir);
  if (marker === "unclaimed" || marker === "corrupt") return marker;
  return marker === digest ? "owned" : "other_owner";
};

/**
 * Atomically binds this local corpus to its first explicitly confirmed cloud
 * account. A different account can never replace the marker implicitly.
 */
export const confirmLocalCloudHomeImportOwnership = async (
  stellaDataDir: string,
  accountScope: string,
  now: () => number = Date.now,
): Promise<boolean> => {
  const digest = accountScopeDigest(accountScope);
  const current = await getLocalCloudHomeImportOwnership(
    stellaDataDir,
    accountScope,
  );
  if (current === "owned") return true;
  if (current !== "unclaimed") return false;
  const confirmedAt = now();
  if (!Number.isFinite(confirmedAt) || confirmedAt < 0) return false;

  const paths = await ownerPaths(stellaDataDir);
  const noFollow =
    (fileConstants as typeof fileConstants & { O_NOFOLLOW?: number })
      .O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(
      paths.marker,
      fileConstants.O_CREAT |
        fileConstants.O_EXCL |
        fileConstants.O_WRONLY |
        noFollow,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    return (
      (await getLocalCloudHomeImportOwnership(stellaDataDir, accountScope)) ===
      "owned"
    );
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({
        schemaVersion: 1,
        ownerScopeSha256: digest,
        confirmedAt,
      })}\n`,
      { encoding: "utf8" },
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
};
