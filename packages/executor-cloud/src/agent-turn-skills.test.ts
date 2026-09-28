import { describe, expect, test } from "bun:test";
import { CLOUD_GENERAL_PROMPT } from "./agent-turn.js";

describe("general cloud skill prompt", () => {
  test("rejects a descriptor outside the ephemeral skill root", () => {
    expect(() =>
      CLOUD_GENERAL_PROMPT({
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
              root: "/workspace/world/drive/.stella/skills/bad",
            },
          ],
        },
      }),
    ).toThrow("descriptor was invalid");
  });
});
