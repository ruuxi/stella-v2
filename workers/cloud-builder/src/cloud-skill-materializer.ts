import {
  CLOUD_SKILL_RUNTIME_MAX_BYTES,
  CLOUD_SKILL_RUNTIME_MAX_FILES,
  CLOUD_SKILL_RUNTIME_MAX_SKILLS,
  type CloudHomeStore,
  type CloudSkillCatalogSnapshot,
} from "./cloud-home-store.js";
import { sha256Hex } from "./hash.js";
import type { ExecutionSession } from "./sandbox-client.js";
import { strictSessionExec } from "./strict-session-process.js";
import { WORLD_ROOT } from "./workspace.js";

export const CLOUD_SKILL_SANDBOX_ROOT = "/tmp/stella-cloud-skills";

/**
 * The same skills where a device keeps them: `~/.stella/skills/<slug>`, HOME
 * being the world. The world sync leaves this subtree out
 * (`WORLD_UNSYNCED_PATHS`), so the bodies never reach the world store.
 */
export const CLOUD_SKILL_HOME_ROOT = `${WORLD_ROOT}/.stella/skills`;

const SKILL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;

/**
 * Run as the tool account, so nothing an agent did to the tree can turn the
 * copy into a write anywhere else. The new copies are built inside the
 * skills directory, which the sync never sees, and renamed into place.
 * Arguments: the skills directory, then slug and version root pairs.
 */
const MIRROR_SKILLS_SCRIPT = `set -eu
umask 022
skills=$1
shift
mkdir -p -- "$skills"
find "$skills" -mindepth 1 -maxdepth 1 \\( -name '.stage-*' -o -name '.old-*' \\) -mmin +10 -exec rm -rf -- {} +
stage=$(mktemp -d "$skills/.stage-XXXXXX")
old=$(mktemp -d "$skills/.old-XXXXXX")
while [ "$#" -gt 1 ]; do cp -R -- "$2" "$stage/$1"; shift 2; done
for entry in "$skills"/*; do
  if [ -e "$entry" ] || [ -L "$entry" ]; then mv -T -- "$entry" "$old/\${entry##*/}"; fi
done
for entry in "$stage"/*; do
  if [ -e "$entry" ]; then mv -T -- "$entry" "$skills/\${entry##*/}"; fi
done
rm -rf -- "$stage" "$old"`;

/**
 * Put a materialized catalog at `~/.stella/skills/<slug>` too, replacing
 * whatever an earlier turn left there.
 */
export const mirrorCloudSkillsIntoHome = async (args: {
  session: Pick<ExecutionSession, "exec">;
  catalog: MaterializedCloudSkillCatalog;
}): Promise<void> => {
  const pairs = args.catalog.entries
    .filter((entry) => SKILL_SLUG.test(entry.slug))
    .flatMap((entry) => [entry.slug, entry.root]);
  const result = await strictSessionExec(
    args.session,
    [
      "/bin/bash",
      "-c",
      MIRROR_SKILLS_SCRIPT,
      "mirror-skills",
      CLOUD_SKILL_HOME_ROOT,
      ...pairs,
    ],
    { origin: "internal" },
  );
  if (!result.success) {
    throw new Error(
      result.stderr.trim().slice(-500) || `exit code ${result.exitCode}`,
    );
  }
};

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
    throw new Error("Mirrored cloud skill contained an unsafe file path.");
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
 * Materializes an immutable catalog snapshot — the mirror of the owner's
 * canonical device skills root — into the sandbox's ephemeral filesystem. The
 * device root decides membership; nothing here narrows it. The turn input
 * contains only safe
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
    });
  }
  return {
    loadedAt: args.snapshot.loadedAt,
    root: CLOUD_SKILL_SANDBOX_ROOT,
    entries: materialized,
  };
};
