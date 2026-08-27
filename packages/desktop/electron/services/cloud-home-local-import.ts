import { createHash } from "node:crypto";
import { constants as fileConstants, promises as fs } from "node:fs";
import path from "node:path";

import {
  CLOUD_HOME_LOCAL_SCAN_VERSION,
  CLOUD_HOME_LOCAL_SKILLS_SCAN_MAX_BYTES,
  CLOUD_HOME_MAX_DOCUMENTS,
  CLOUD_HOME_MAX_EXPORT_BYTES,
  CLOUD_SKILL_MAX_FILES,
  CLOUD_SKILL_MAX_FILE_BYTES,
  CLOUD_SKILL_MAX_PACKAGES,
  CLOUD_SKILL_MAX_TOTAL_BYTES,
  type CloudHomeScanWarning,
  type CloudHomeScanWarningCode,
  type CloudMemoryKind,
  type LocalCloudHomeScan,
  type LocalCloudMemoryDocument,
  type LocalCloudSkillFile,
  type LocalCloudSkillPackage,
} from "@stella/contracts/cloud-home-sync";
import { extractFrontmatter } from "@stella/runtime/kernel/frontmatter";
import { getLocalCloudHomeImportOwnership } from "./cloud-home-import-owner.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const MAX_WARNING_COUNT = 100;
const MAX_TRAVERSAL_ENTRIES = 4_096;
const MAX_BUNDLED_MANIFEST_BYTES = 1024 * 1024;

type ReadFailure = {
  code: CloudHomeScanWarningCode;
  message: string;
};

class LocalImportError extends Error {
  constructor(
    readonly code: CloudHomeScanWarningCode,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const safeDisplayPath = (relativePath: string): string => {
  const normalized = relativePath.replaceAll(path.sep, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return "local item";
  }
  return `~/.stella/${normalized}`.slice(0, 320);
};

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const assertSafeSegment = (segment: string): void => {
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    segment.startsWith(".") ||
    segment.length > 96 ||
    /[\\/\u0000-\u001f\u007f]/u.test(segment)
  ) {
    throw new LocalImportError(
      "invalid_path",
      "The local item has an unsupported path.",
    );
  }
};

const assertSafeRelativePath = (relativePath: string): string => {
  const normalized = relativePath.normalize("NFC").replaceAll(path.sep, "/");
  if (!normalized || normalized.length > 240) {
    throw new LocalImportError(
      "invalid_path",
      "The local item has an unsupported path.",
    );
  }
  for (const segment of normalized.split("/")) assertSafeSegment(segment);
  return normalized;
};

const readRegularFile = async (args: {
  rootRealPath: string;
  absolutePath: string;
  relativePath: string;
  maxBytes: number;
}): Promise<Uint8Array> => {
  const displayPath = safeDisplayPath(args.relativePath);
  let linkStat;
  try {
    linkStat = await fs.lstat(args.absolutePath);
  } catch {
    throw new LocalImportError(
      "read_failed",
      "The local item could not be read.",
    );
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.nlink > 1) {
    throw new LocalImportError(
      "unsafe_file",
      `${displayPath} is not an isolated regular file.`,
    );
  }
  if (linkStat.size > args.maxBytes) {
    throw new LocalImportError(
      "document_too_large",
      `${displayPath} exceeds its size limit.`,
    );
  }

  const resolved = await fs.realpath(args.absolutePath).catch(() => "");
  if (!resolved || !isWithin(args.rootRealPath, resolved)) {
    throw new LocalImportError(
      "unsafe_file",
      `${displayPath} resolves outside Stella data.`,
    );
  }

  const noFollow =
    (fileConstants as typeof fileConstants & { O_NOFOLLOW?: number })
      .O_NOFOLLOW ?? 0;
  const handle = await fs
    .open(args.absolutePath, fileConstants.O_RDONLY | noFollow)
    .catch(() => null);
  if (!handle) {
    throw new LocalImportError(
      "read_failed",
      `The local item ${displayPath} could not be opened.`,
    );
  }
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.nlink > 1 ||
      openedStat.size > args.maxBytes ||
      (linkStat.ino !== 0 &&
        openedStat.ino !== 0 &&
        linkStat.ino !== openedStat.ino) ||
      (linkStat.dev !== 0 &&
        openedStat.dev !== 0 &&
        linkStat.dev !== openedStat.dev)
    ) {
      throw new LocalImportError(
        "unsafe_file",
        `${displayPath} changed during the scan.`,
      );
    }
    const bytes = await handle.readFile();
    if (
      bytes.byteLength !== openedStat.size ||
      bytes.byteLength > args.maxBytes
    ) {
      throw new LocalImportError(
        "unsafe_file",
        `${displayPath} changed during the scan.`,
      );
    }
    return new Uint8Array(bytes);
  } finally {
    await handle.close();
  }
};

const contentTypeForPath = (relativePath: string): string => {
  const extension = path.extname(relativePath).toLowerCase();
  const known: Record<string, string> = {
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".ts": "text/typescript; charset=utf-8",
    ".tsx": "text/tsx; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".jsx": "text/jsx; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".yaml": "application/yaml; charset=utf-8",
    ".yml": "application/yaml; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
  };
  return known[extension] ?? "application/octet-stream";
};

const canonicalMemoryCandidates: ReadonlyArray<{
  localPaths: readonly string[];
  name: string;
  displayPath: string;
  kind: CloudMemoryKind;
  maxBytes: number;
}> = [
  {
    localPaths: ["memories/MEMORY.md", "MEMORY.md"],
    name: "MEMORY.md",
    displayPath: "~/.stella/memories/MEMORY.md",
    kind: "memory",
    maxBytes: 256 * 1024,
  },
  {
    localPaths: ["memories/profile.md"],
    name: "memories/profile.md",
    displayPath: "~/.stella/memories/profile.md",
    kind: "profile",
    maxBytes: 32 * 1024,
  },
  {
    localPaths: ["memories/memory_map.md"],
    name: "memories/memory_map.md",
    displayPath: "~/.stella/memories/memory_map.md",
    kind: "memory_map",
    maxBytes: 32 * 1024,
  },
  {
    localPaths: ["core-memory.md"],
    name: "core-memory.md",
    displayPath: "~/.stella/core-memory.md",
    kind: "core_memory",
    maxBytes: 64 * 1024,
  },
  {
    localPaths: ["PERSONALITY.md"],
    name: "PERSONALITY.md",
    displayPath: "~/.stella/PERSONALITY.md",
    kind: "personality",
    maxBytes: 64 * 1024,
  },
];

const pushWarning = (
  warnings: CloudHomeScanWarning[],
  relativePath: string,
  failure: ReadFailure,
): void => {
  if (warnings.length >= MAX_WARNING_COUNT) return;
  warnings.push({
    code: failure.code,
    path: safeDisplayPath(relativePath),
    message: failure.message.slice(0, 240),
  });
};

const failureFrom = (error: unknown): ReadFailure =>
  error instanceof LocalImportError
    ? { code: error.code, message: error.message }
    : { code: "read_failed", message: "The local item could not be read." };

const readUtf8Memory = async (args: {
  rootRealPath: string;
  absolutePath: string;
  relativePath: string;
  name: string;
  displayPath: string;
  kind: CloudMemoryKind;
  maxBytes: number;
}): Promise<LocalCloudMemoryDocument> => {
  const bytes = await readRegularFile(args);
  let content: string;
  try {
    content = UTF8.decode(bytes);
  } catch {
    throw new LocalImportError(
      "unsupported_document",
      "The Markdown document is not valid UTF-8.",
    );
  }
  return {
    name: args.name,
    displayPath: args.displayPath,
    kind: args.kind,
    source: "legacy_local",
    content,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
  };
};

const listSafeFiles = async (args: {
  rootRealPath: string;
  directoryPath: string;
  relativePrefix: string;
  markdownOnly?: boolean;
}): Promise<string[]> => {
  const output: string[] = [];
  let visited = 0;

  const visit = async (
    directoryPath: string,
    relativePrefix: string,
  ): Promise<void> => {
    visited += 1;
    if (visited > MAX_TRAVERSAL_ENTRIES) {
      throw new LocalImportError(
        "skill_limit",
        "The local tree has too many entries.",
      );
    }
    const stat = await fs.lstat(directoryPath).catch(() => null);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new LocalImportError(
        "unsafe_file",
        "The local tree contains an unsafe directory.",
      );
    }
    const resolved = await fs.realpath(directoryPath).catch(() => "");
    if (!resolved || !isWithin(args.rootRealPath, resolved)) {
      throw new LocalImportError(
        "unsafe_file",
        "The local tree resolves outside Stella data.",
      );
    }
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_TRAVERSAL_ENTRIES) {
        throw new LocalImportError(
          "skill_limit",
          "The local tree has too many entries.",
        );
      }
      assertSafeSegment(entry.name);
      const relative = relativePrefix
        ? `${relativePrefix}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) {
        throw new LocalImportError(
          "unsafe_file",
          "The local tree contains a symbolic link.",
        );
      }
      if (entry.isDirectory()) {
        await visit(path.join(directoryPath, entry.name), relative);
      } else if (entry.isFile()) {
        if (!args.markdownOnly || entry.name.toLowerCase().endsWith(".md")) {
          output.push(assertSafeRelativePath(relative));
        }
      } else {
        throw new LocalImportError(
          "unsafe_file",
          "The local tree contains a non-regular item.",
        );
      }
    }
  };

  await visit(args.directoryPath, args.relativePrefix);
  return output.sort((left, right) => left.localeCompare(right));
};

type BundledSkillEntry = { lastSyncedHash: string; customized: boolean };

const readBundledSkillEntries = async (
  rootRealPath: string,
  skillsRoot: string,
): Promise<Record<string, BundledSkillEntry>> => {
  const manifestPath = path.join(skillsRoot, ".bundled-manifest.json");
  let bytes: Uint8Array;
  try {
    bytes = await readRegularFile({
      rootRealPath,
      absolutePath: manifestPath,
      relativePath: "skills/.bundled-manifest.json",
      maxBytes: MAX_BUNDLED_MANIFEST_BYTES,
    });
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(UTF8.decode(bytes)) as Record<string, unknown>;
    const rawEntries = parsed.entries ?? parsed.skills;
    if (
      !rawEntries ||
      typeof rawEntries !== "object" ||
      Array.isArray(rawEntries)
    )
      return {};
    const output: Record<string, BundledSkillEntry> = {};
    for (const [slug, raw] of Object.entries(
      rawEntries as Record<string, unknown>,
    )) {
      if (typeof raw === "string" && SHA256_PATTERN.test(raw)) {
        output[slug] = { lastSyncedHash: raw, customized: false };
      } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const entry = raw as Record<string, unknown>;
        if (
          typeof entry.lastSyncedHash === "string" &&
          SHA256_PATTERN.test(entry.lastSyncedHash)
        ) {
          output[slug] = {
            lastSyncedHash: entry.lastSyncedHash,
            customized: entry.customized === true,
          };
        }
      }
    }
    return output;
  } catch {
    return {};
  }
};

const scanSkill = async (args: {
  rootRealPath: string;
  skillsRoot: string;
  slug: string;
  bundledEntry?: BundledSkillEntry;
}): Promise<LocalCloudSkillPackage | null> => {
  if (!SKILL_SLUG_PATTERN.test(args.slug)) {
    throw new LocalImportError(
      "skill_invalid",
      "The skill folder name is not a supported slug.",
    );
  }
  const skillRoot = path.join(args.skillsRoot, args.slug);
  const relativeFiles = await listSafeFiles({
    rootRealPath: args.rootRealPath,
    directoryPath: skillRoot,
    relativePrefix: "",
  });
  if (
    relativeFiles.length === 0 ||
    relativeFiles.length > CLOUD_SKILL_MAX_FILES
  ) {
    throw new LocalImportError(
      "skill_limit",
      "The skill package has an unsupported file count.",
    );
  }

  const files: Array<LocalCloudSkillFile & { bytes: Uint8Array }> = [];
  let totalSizeBytes = 0;
  const legacyHash = createHash("sha256");
  for (const relativeFile of relativeFiles) {
    const bytes = await readRegularFile({
      rootRealPath: args.rootRealPath,
      absolutePath: path.join(skillRoot, ...relativeFile.split("/")),
      relativePath: `skills/${args.slug}/${relativeFile}`,
      maxBytes: CLOUD_SKILL_MAX_FILE_BYTES,
    });
    totalSizeBytes += bytes.byteLength;
    if (totalSizeBytes > CLOUD_SKILL_MAX_TOTAL_BYTES) {
      throw new LocalImportError(
        "skill_too_large",
        "The skill package exceeds its total size limit.",
      );
    }
    legacyHash.update(relativeFile, "utf8");
    legacyHash.update("\0");
    legacyHash.update(bytes);
    legacyHash.update("\0");
    files.push({
      path: relativeFile,
      contentType: contentTypeForPath(relativeFile),
      base64: Buffer.from(bytes).toString("base64"),
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      bytes,
    });
  }

  // Untouched bundled packages are already part of Stella's system skill
  // catalog. Upload only user-created or user-diverged packages.
  if (
    args.bundledEntry &&
    !args.bundledEntry.customized &&
    legacyHash.digest("hex") === args.bundledEntry.lastSyncedHash
  ) {
    return null;
  }

  const skillMarkdown = files.find((file) => file.path === "SKILL.md");
  if (!skillMarkdown) {
    throw new LocalImportError(
      "skill_invalid",
      "The skill package does not contain SKILL.md.",
    );
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = extractFrontmatter(UTF8.decode(skillMarkdown.bytes)).metadata;
  } catch {
    throw new LocalImportError(
      "skill_invalid",
      "SKILL.md is not valid UTF-8 frontmatter.",
    );
  }
  const name =
    typeof metadata.name === "string"
      ? metadata.name.normalize("NFC").trim()
      : "";
  const description =
    typeof metadata.description === "string"
      ? metadata.description.normalize("NFC").replace(/\s+/gu, " ").trim()
      : "";
  if (
    !name ||
    name.length > 120 ||
    !description ||
    description.length > 1_000
  ) {
    throw new LocalImportError(
      "skill_invalid",
      "SKILL.md needs bounded name and description frontmatter.",
    );
  }

  const treeInput = files
    .map(
      (file) =>
        `${file.path}\0${file.sha256}\0${file.sizeBytes}\0${file.contentType}\n`,
    )
    .join("");
  return {
    slug: args.slug,
    name,
    description,
    source: "desktop_sync",
    availability: "both",
    treeSha256: sha256(treeInput),
    fileCount: files.length,
    totalSizeBytes,
    files: files.map(({ bytes: _bytes, ...file }) => file),
  };
};

/**
 * Read-only scan of the explicitly supplied Stella data directory.
 *
 * There is intentionally no default to `~/.stella` and no environment
 * fallback. Production calls receive the configured directory from Electron
 * lifecycle state; tests pass a temporary fixture path directly.
 */
export const scanLocalCloudHome = async (
  stellaDataDir: string,
): Promise<LocalCloudHomeScan> => {
  if (!path.isAbsolute(stellaDataDir)) {
    throw new Error(
      "Cloud Home import requires a configured absolute data directory.",
    );
  }
  const rootStat = await fs.lstat(stellaDataDir).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("The configured Stella data directory is unavailable.");
  }
  const rootRealPath = await fs.realpath(stellaDataDir);
  const memories: LocalCloudMemoryDocument[] = [];
  const skills: LocalCloudSkillPackage[] = [];
  const warnings: CloudHomeScanWarning[] = [];
  let memoryBytes = 0;

  for (const candidate of canonicalMemoryCandidates) {
    for (const localPath of candidate.localPaths) {
      const absolutePath = path.join(stellaDataDir, ...localPath.split("/"));
      const exists = await fs
        .lstat(absolutePath)
        .then(() => true)
        .catch(() => false);
      if (!exists) continue;
      try {
        const document = await readUtf8Memory({
          rootRealPath,
          absolutePath,
          relativePath: localPath,
          ...candidate,
        });
        if (memoryBytes + document.sizeBytes > CLOUD_HOME_MAX_EXPORT_BYTES) {
          pushWarning(warnings, localPath, {
            code: "document_limit",
            message: "Local Markdown exceeds the bounded migration total.",
          });
        } else {
          memories.push(document);
          memoryBytes += document.sizeBytes;
        }
      } catch (error) {
        pushWarning(warnings, localPath, failureFrom(error));
      }
      break;
    }
  }

  const markdownRoots: ReadonlyArray<{
    localRoot: string;
    cloudPrefix: "imports" | "markdown";
  }> = [
    { localRoot: "imports", cloudPrefix: "imports" },
    { localRoot: "memories/imports", cloudPrefix: "imports" },
    { localRoot: "markdown", cloudPrefix: "markdown" },
  ];
  for (const markdownRoot of markdownRoots) {
    const absoluteRoot = path.join(
      stellaDataDir,
      ...markdownRoot.localRoot.split("/"),
    );
    const exists = await fs
      .lstat(absoluteRoot)
      .then(() => true)
      .catch(() => false);
    if (!exists) continue;
    let relativeFiles: string[];
    try {
      relativeFiles = await listSafeFiles({
        rootRealPath,
        directoryPath: absoluteRoot,
        relativePrefix: "",
        markdownOnly: true,
      });
    } catch (error) {
      pushWarning(warnings, markdownRoot.localRoot, failureFrom(error));
      continue;
    }
    for (const relativeFile of relativeFiles) {
      if (memories.length >= CLOUD_HOME_MAX_DOCUMENTS) {
        pushWarning(warnings, `${markdownRoot.localRoot}/${relativeFile}`, {
          code: "document_limit",
          message:
            "Only the bounded number of Markdown documents can be migrated.",
        });
        break;
      }
      const importedRelative =
        markdownRoot.cloudPrefix === "imports" && !relativeFile.includes("/")
          ? `local/${relativeFile}`
          : relativeFile;
      const name = `${markdownRoot.cloudPrefix}/${importedRelative}`;
      const relativePath = `${markdownRoot.localRoot}/${relativeFile}`;
      try {
        const document = await readUtf8Memory({
          rootRealPath,
          absolutePath: path.join(absoluteRoot, ...relativeFile.split("/")),
          relativePath,
          name,
          displayPath: `~/.stella/${name}`,
          kind:
            markdownRoot.cloudPrefix === "imports"
              ? "imported_markdown"
              : "user_markdown",
          maxBytes: 512 * 1024,
        });
        if (memoryBytes + document.sizeBytes > CLOUD_HOME_MAX_EXPORT_BYTES) {
          pushWarning(warnings, relativePath, {
            code: "document_limit",
            message: "Local Markdown exceeds the bounded migration total.",
          });
          continue;
        }
        memories.push(document);
        memoryBytes += document.sizeBytes;
      } catch (error) {
        pushWarning(warnings, relativePath, failureFrom(error));
      }
    }
  }

  const skillsRoot = path.join(stellaDataDir, "skills");
  const bundledEntries = await readBundledSkillEntries(
    rootRealPath,
    skillsRoot,
  );
  const skillEntries = await fs
    .readdir(skillsRoot, { withFileTypes: true })
    .catch(() => []);
  const skillSlugs = skillEntries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !entry.name.startsWith("."),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  let totalSkillBytes = 0;
  for (const slug of skillSlugs) {
    if (skills.length >= CLOUD_SKILL_MAX_PACKAGES) {
      pushWarning(warnings, `skills/${slug}`, {
        code: "skill_limit",
        message:
          "Only the bounded number of local skill packages can be migrated.",
      });
      break;
    }
    try {
      const skill = await scanSkill({
        rootRealPath,
        skillsRoot,
        slug,
        bundledEntry: bundledEntries[slug],
      });
      if (!skill) continue;
      if (
        totalSkillBytes + skill.totalSizeBytes >
        CLOUD_HOME_LOCAL_SKILLS_SCAN_MAX_BYTES
      ) {
        pushWarning(warnings, `skills/${slug}`, {
          code: "skill_limit",
          message: "Local skills exceed the bounded migration total.",
        });
        break;
      }
      skills.push(skill);
      totalSkillBytes += skill.totalSizeBytes;
    } catch (error) {
      pushWarning(warnings, `skills/${slug}`, failureFrom(error));
    }
  }

  return {
    schemaVersion: CLOUD_HOME_LOCAL_SCAN_VERSION,
    memories,
    skills,
    warnings,
  };
};

/**
 * Privileged renderer entry point. Ownership is checked in the same main
 * process operation that starts the scan; client sequencing is not authority.
 */
export const scanOwnedLocalCloudHome = async (
  stellaDataDir: string,
  accountScope: string,
): Promise<LocalCloudHomeScan> => {
  const ownership = await getLocalCloudHomeImportOwnership(
    stellaDataDir,
    accountScope,
  );
  if (ownership !== "owned") {
    throw new Error("Local Cloud Home import is not owned by this account.");
  }
  return await scanLocalCloudHome(stellaDataDir);
};
