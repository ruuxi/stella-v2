/**
 * The representative prompt inputs the byte-parity golden is generated from.
 *
 * Shared by the generator script and the parity test so the golden can never
 * drift from the inputs that produced it.
 */

import type { DriveSyncResult } from "./drive-sync.js";
import type { GeneralAgentPromptSkills } from "./general-agent-prompt.js";

const drive = (
  overrides: Partial<DriveSyncResult> = {},
): DriveSyncResult => ({
  known: new Map(),
  uploads: new Set(),
  materialized: [],
  skipped: [],
  deleted: [],
  stale: [],
  conflicts: [],
  ...overrides,
});

const skills: GeneralAgentPromptSkills = {
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
      root: "/tmp/stella-cloud-skills/skill-11111111111111111111111111111111/version-22222222222222222222222222222222",
    },
  ],
};

export type GeneralAgentPromptCase = {
  label: string;
  office: boolean;
  drive?: DriveSyncResult;
  skills?: GeneralAgentPromptSkills;
};

export const GENERAL_AGENT_PROMPT_CASES: readonly GeneralAgentPromptCase[] = [
  { label: "bare", office: false },
  { label: "office", office: true },
  { label: "office-and-skills", office: true, skills },
  {
    label: "one-materialized-file",
    office: false,
    drive: drive({ materialized: ["report.txt"] }),
  },
  {
    label: "empty-drive-sync",
    office: true,
    drive: drive(),
  },
  {
    label: "every-drive-notice",
    office: true,
    skills,
    drive: drive({
      materialized: ["a.txt", "b.txt"],
      skipped: [
        { path: "huge.bin", reason: "too_large" },
        { path: "other.bin", reason: "too_large" },
      ],
      stale: ["gone.txt"],
      conflicts: [
        { path: "unsaved.txt", driveMoved: false },
        { path: "diverged.txt", driveMoved: true },
      ],
    }),
  },
  {
    label: "overflowing-drive-notices",
    office: false,
    drive: drive({
      materialized: Array.from({ length: 3 }, (_, index) => `m${index}.txt`),
      skipped: Array.from({ length: 12 }, (_, index) => ({
        path: `s${index}.bin`,
        reason: "too_large",
      })),
      stale: Array.from({ length: 12 }, (_, index) => `st${index}.txt`),
      conflicts: [
        ...Array.from({ length: 12 }, (_, index) => ({
          path: `u${index}.txt`,
          driveMoved: false,
        })),
        ...Array.from({ length: 12 }, (_, index) => ({
          path: `d${index}.txt`,
          driveMoved: true,
        })),
      ],
    }),
  },
];
