import { describe, expect, it } from "vitest";
import {
  agentHomeGenerationR2Prefix,
  dreamInboxR2Key,
  memoryVersionR2Key,
  skillFileR2Key,
} from "./cloud_home_policy";

describe("cloud-home generation-scoped R2 keys", () => {
  it("changes every writable namespace when the owner generation changes", async () => {
    const base = { ownerId: "owner:one", ownerGeneration: "generation-1" };
    const next = { ...base, ownerGeneration: "generation-2" };
    const prefix = await agentHomeGenerationR2Prefix(base);
    const nextPrefix = await agentHomeGenerationR2Prefix(next);
    expect(prefix).not.toBe(nextPrefix);
    expect(prefix).toMatch(
      /^agent-home\/[0-9a-f]{64}\/generations\/[0-9a-f]{64}\/$/,
    );

    const memory = await memoryVersionR2Key({
      ...base,
      documentId: "document-1",
      versionId: "version-1",
      sha256: "a".repeat(64),
    });
    const dream = await dreamInboxR2Key({
      ...base,
      inboxId: "inbox-1",
      sourceRevision: 1,
      sha256: "b".repeat(64),
    });
    const skill = await skillFileR2Key({
      ...base,
      skillId: "skill-1",
      versionId: "version-1",
      path: "SKILL.md",
    });
    expect(memory.startsWith(prefix)).toBe(true);
    expect(dream.startsWith(prefix)).toBe(true);
    expect(skill.startsWith(prefix)).toBe(true);
  });
});
