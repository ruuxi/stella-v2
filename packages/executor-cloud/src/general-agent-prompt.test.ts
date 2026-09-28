import { describe, expect, test } from "bun:test";
import { buildGeneralAgentPrompt } from "./general-agent-prompt.js";

describe("general agent prompt", () => {
  test("rejects an oversized skill catalog", () => {
    expect(() =>
      buildGeneralAgentPrompt({
        workspace: "lazy",
        office: false,
        skills: {
          loadedAt: 1,
          root: "/tmp/stella-cloud-skills",
          entries: Array.from(
            { length: 21 },
            () => ({
              skillId: "skill-1", slug: "calendar", name: "Calendar",
              description: "Manage the calendar", versionId: "version-7", revision: 7,
              root: "/tmp/stella-cloud-skills/skill-11111111111111111111111111111111/version-22222222222222222222222222222222",
            }),
          ),
        },
      }),
    ).toThrow("Cloud skill catalog exceeded its runtime bound.");
  });

  test("lazy rejects a skill root outside the pinned sandbox path", () => {
    expect(() =>
      buildGeneralAgentPrompt({
        workspace: "lazy",
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
              root: "/workspace/world/drive",
            },
          ],
        },
      }),
    ).toThrow("Cloud skill descriptor was invalid.");
  });
});
