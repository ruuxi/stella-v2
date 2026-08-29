/**
 * Regenerate the byte-parity golden for the materialized general-agent prompt.
 *
 * Run it against a revision whose `CLOUD_GENERAL_PROMPT` is the behavior you
 * want pinned. The parity test then proves `buildGeneralAgentPrompt` with
 * `workspace: "materialized"` reproduces those bytes exactly.
 *
 *   bun packages/executor-cloud/scripts/generate-general-agent-prompt-golden.mjs
 */

import { writeFile } from "node:fs/promises";
import { CLOUD_GENERAL_PROMPT } from "../src/agent-turn.ts";
import { GENERAL_AGENT_PROMPT_CASES } from "../src/general-agent-prompt-cases.ts";

const golden = {};
for (const testCase of GENERAL_AGENT_PROMPT_CASES) {
  golden[testCase.label] = CLOUD_GENERAL_PROMPT({
    office: testCase.office,
    ...(testCase.drive ? { drive: testCase.drive } : {}),
    ...(testCase.skills ? { skills: testCase.skills } : {}),
  });
}

const target = new URL(
  "../src/general-agent-prompt-golden.json",
  import.meta.url,
);
await writeFile(target, `${JSON.stringify(golden, null, 2)}\n`);
console.log(
  `wrote ${Object.keys(golden).length} cases to ${target.pathname}`,
);
