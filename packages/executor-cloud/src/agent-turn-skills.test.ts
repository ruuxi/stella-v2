import { describe, expect, test } from "bun:test";
import { CLOUD_GENERAL_PROMPT } from "./agent-turn.js";

const workspace = {
  kind: "drive" as const,
  workspace: "cloud",
  slug: "",
  root: "/workspace/drive",
};

describe("general cloud skill prompt", () => {
  test("discovers an exact pinned sandbox package without widening tools", () => {
    const root =
      "/tmp/stella-cloud-skills/skill-11111111111111111111111111111111/version-22222222222222222222222222222222";
    const prompt = CLOUD_GENERAL_PROMPT({
      workspace,
      office: false,
      skills: {
        loadedAt: 1,
        root: "/tmp/stella-cloud-skills",
        entries: [
          {
            skillId: "skill-1",
            slug: "calendar",
            name: "Calendar",
            description: "Manage the calendar",
            versionId: "version-7",
            revision: 7,
            root,
            allowedToolNames: ["calendar.list"],
          },
        ],
      },
    });

    expect(prompt).toContain('"name":"Calendar"');
    expect(prompt).toContain('"version":"version-7"');
    expect(prompt).toContain(`${root}/SKILL.md`);
    expect(prompt).toContain("they never grant or widen tools");
    expect(prompt).toContain("fixed tool catalog");
  });

  test("rejects a descriptor outside the ephemeral skill root", () => {
    expect(() =>
      CLOUD_GENERAL_PROMPT({
        workspace,
        office: false,
        skills: {
          loadedAt: 1,
          root: "/tmp/stella-cloud-skills",
          entries: [
            {
              skillId: "skill-1",
              slug: "bad",
              name: "Bad",
              description: "Bad",
              versionId: "version-1",
              revision: 1,
              root: "/workspace/drive/.stella/skills/bad",
              allowedToolNames: [],
            },
          ],
        },
      }),
    ).toThrow("descriptor was invalid");
  });
});
