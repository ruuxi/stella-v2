import source from "../../../packages/home-seed/skills/create-stella-cloud-app/SKILL.md";
import { sha256Hex } from "./hash.js";
import type { CloudSkillCatalogEntry } from "./cloud-home-store.js";
export const cloudAppSkillSource = source;
export const CLOUD_APP_SKILL_ID = "builtin-create-stella-cloud-app";
export async function builtinCloudAppSkill(): Promise<CloudSkillCatalogEntry> {
  const sha = await sha256Hex(source);
  const bytes = new TextEncoder().encode(source).byteLength;
  return {
    skillId: CLOUD_APP_SKILL_ID,
    slug: "create-stella-cloud-app",
    name: "create-stella-cloud-app",
    description:
      "Create and update hosted apps during cloud execution using ordinary workspace files. Apps appear on desktop, web, and mobile.",
    source: "bundled",
    availability: "both",
    revision: 1,
    versionId: sha,
    manifestSha256: sha,
    treeSha256: sha,
    fileCount: 1,
    totalSizeBytes: bytes,
    updatedAt: 0,
    files: [
      {
        path: "SKILL.md",
        r2Key: "builtin:cloud-app",
        sha256: sha,
        sizeBytes: bytes,
        contentType: "text/markdown",
      },
    ],
  };
}
