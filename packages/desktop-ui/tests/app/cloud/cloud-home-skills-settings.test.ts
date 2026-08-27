import { describe, expect, test } from "vitest";
import type { CloudSkillHead } from "@stella/contracts/cloud-home-sync";
import {
  buildCloudSkillAuthorizationArgs,
  buildCloudSkillRevocationArgs,
  createCloudSkillAuthorizationDraft,
  normalizeCloudSkillToolNames,
} from "../../../src/features/cloud/cloud-home-skills-settings-policy";

const head = (overrides: Partial<CloudSkillHead> = {}): CloudSkillHead => ({
  skillId: "skill-calendar",
  ownerGeneration: "generation-7",
  slug: "calendar",
  name: "Calendar",
  description: "Use calendar workflows.",
  source: "desktop_sync",
  availability: "both",
  revision: 3,
  versionId: "skill-version-3",
  manifestSha256: "1".repeat(64),
  treeSha256: "2".repeat(64),
  fileCount: 1,
  totalSizeBytes: 100,
  enabled: true,
  updatedAt: 1,
  ...overrides,
});

describe("Cloud Skills settings controls", () => {
  test("builds an exact generation/version/revision-fenced authorization", () => {
    const skill = head({ authorizationRevision: 4 });
    const draft = createCloudSkillAuthorizationDraft(skill);
    draft.allowedAgentTypes = ["orchestrator", "general"];
    draft.toolNamesText = "calendar.read, calendar.write, calendar.read";
    expect(buildCloudSkillAuthorizationArgs(skill, draft)).toEqual({
      skillId: "skill-calendar",
      versionId: "skill-version-3",
      expectedOwnerGeneration: "generation-7",
      expectedAuthorizationRevision: 4,
      allowedAgentTypes: ["orchestrator", "general"],
      allowedToolNames: ["calendar.read", "calendar.write"],
    });
  });

  test("starts narrow and fails closed for invalid agents or tool names", () => {
    expect(
      createCloudSkillAuthorizationDraft(head()).allowedAgentTypes,
    ).toEqual(["orchestrator"]);
    expect(
      normalizeCloudSkillToolNames("calendar.read, ../../shell"),
    ).toBeNull();
    expect(
      buildCloudSkillAuthorizationArgs(head({ availability: "orchestrator" }), {
        allowedAgentTypes: ["general"],
        toolNamesText: "",
      }),
    ).toBeNull();
  });

  test("revokes only the authorization pinned to the visible exact version", () => {
    expect(
      buildCloudSkillRevocationArgs(
        head({
          authorizationState: "active",
          authorizationVersionId: "skill-version-3",
          authorizationRevision: 5,
        }),
      ),
    ).toEqual({
      skillId: "skill-calendar",
      expectedOwnerGeneration: "generation-7",
      expectedAuthorizationRevision: 5,
    });
    expect(
      buildCloudSkillRevocationArgs(
        head({
          authorizationState: "active",
          authorizationVersionId: "old-version",
          authorizationRevision: 5,
        }),
      ),
    ).toBeNull();
  });
});
