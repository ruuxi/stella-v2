import {
  CLOUD_SKILL_RUNTIME_MAX_BYTES,
  CLOUD_SKILL_RUNTIME_MAX_FILES,
  CLOUD_SKILL_RUNTIME_MAX_SKILLS,
  type CloudHomeStore,
  type CloudSkillCatalogSnapshot,
} from "./cloud-home-store.js";
import { sha256Hex } from "./hash.js";

export const CLOUD_SKILL_SANDBOX_ROOT = "/tmp/stella-cloud-skills";

const SAFE_SKILL_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)(?!.*(?:^|\/)\.)[^\u0000-\u001f\u007f]+$/u;

type SandboxFileWriter = {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(
    path: string,
    content: string,
    options?: { encoding?: string },
  ): Promise<{ success?: boolean } | unknown>;
};

export type MaterializedCloudSkill = {
  skillId: string;
  slug: string;
  name: string;
  description: string;
  versionId: string;
  revision: number;
  root: string;
  allowedToolNames: string[];
};

export type MaterializedCloudSkillCatalog = {
  loadedAt: number;
  root: typeof CLOUD_SKILL_SANDBOX_ROOT;
  entries: MaterializedCloudSkill[];
};

const safeRelativePath = (value: string): string => {
  const normalized = value.normalize("NFC");
  if (
    normalized.length < 1 ||
    normalized.length > 240 ||
    normalized.endsWith("/") ||
    !SAFE_SKILL_PATH.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment.length > 96)
  ) {
    throw new Error("Authorized cloud skill contained an unsafe file path.");
  }
  return normalized;
};

const base64Bytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

const directoryOf = (filePath: string): string =>
  filePath.slice(0, Math.max(0, filePath.lastIndexOf("/"))) ||
  CLOUD_SKILL_SANDBOX_ROOT;

/**
 * Materializes an already authorized, immutable catalog snapshot into the
 * sandbox's ephemeral filesystem. The returned turn input contains only safe
 * display metadata and local paths: no R2 locators, service credentials, or
 * host-machine paths cross into the model process.
 */
export const materializeCloudSkillSnapshot = async (args: {
  home: Pick<CloudHomeStore, "readSkillFile">;
  snapshot: CloudSkillCatalogSnapshot;
  session: SandboxFileWriter;
  /** Exact-turn admission latch; checked around every external operation. */
  assertActive: () => void;
}): Promise<MaterializedCloudSkillCatalog> => {
  args.assertActive();
  if (args.snapshot.agentType !== "general") {
    throw new Error("Only a general-agent skill snapshot may be materialized.");
  }
  if (args.snapshot.entries.length > CLOUD_SKILL_RUNTIME_MAX_SKILLS) {
    throw new Error("Cloud skill snapshot exceeded its runtime skill bound.");
  }
  const fileCount = args.snapshot.entries.reduce(
    (total, entry) => total + entry.fileCount,
    0,
  );
  const totalSizeBytes = args.snapshot.entries.reduce(
    (total, entry) => total + entry.totalSizeBytes,
    0,
  );
  if (
    fileCount > CLOUD_SKILL_RUNTIME_MAX_FILES ||
    totalSizeBytes > CLOUD_SKILL_RUNTIME_MAX_BYTES
  ) {
    throw new Error("Cloud skill snapshot exceeded its runtime byte bound.");
  }

  args.assertActive();
  await args.session.mkdir(CLOUD_SKILL_SANDBOX_ROOT, { recursive: true });
  args.assertActive();
  const materialized: MaterializedCloudSkill[] = [];
  for (const entry of args.snapshot.entries) {
    const skillSegment = `skill-${(await sha256Hex(entry.skillId)).slice(
      0,
      32,
    )}`;
    const versionSegment = `version-${(await sha256Hex(entry.versionId)).slice(
      0,
      32,
    )}`;
    const root = `${CLOUD_SKILL_SANDBOX_ROOT}/${skillSegment}/${versionSegment}`;
    args.assertActive();
    await args.session.mkdir(root, { recursive: true });
    args.assertActive();
    for (const file of entry.files) {
      const relative = safeRelativePath(file.path);
      const target = `${root}/${relative}`;
      args.assertActive();
      await args.session.mkdir(directoryOf(target), { recursive: true });
      args.assertActive();
      const bytes = await args.home.readSkillFile(
        args.snapshot,
        entry.skillId,
        relative,
      );
      args.assertActive();
      if (bytes.byteLength !== file.sizeBytes) {
        throw new Error("Cloud skill bytes changed after catalog pinning.");
      }
      args.assertActive();
      const result = await args.session.writeFile(target, base64Bytes(bytes), {
        encoding: "base64",
      });
      args.assertActive();
      if (
        result &&
        typeof result === "object" &&
        "success" in result &&
        result.success === false
      ) {
        throw new Error("Cloud skill file could not be materialized.");
      }
    }
    materialized.push({
      skillId: entry.skillId,
      slug: entry.slug,
      name: entry.name,
      description: entry.description,
      versionId: entry.versionId,
      revision: entry.revision,
      root,
      allowedToolNames: [...entry.allowedToolNames],
    });
  }
  return {
    loadedAt: args.snapshot.loadedAt,
    root: CLOUD_SKILL_SANDBOX_ROOT,
    entries: materialized,
  };
};
