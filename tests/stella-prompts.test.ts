import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { STELLA_PROMPT_DEFAULTS } from "../convex/stella_prompt_defaults.generated";

describe("Stella prompt defaults", () => {
  it("matches every canonical markdown file byte-for-byte", async () => {
    expect(STELLA_PROMPT_DEFAULTS.prompts).toHaveLength(9);
    for (const prompt of STELLA_PROMPT_DEFAULTS.prompts) {
      const content = await readFile(
        path.join(
          import.meta.dirname,
          "..",
          "prompts",
          "stella-runtime",
          prompt.id,
        ),
        "utf-8",
      );
      const sha256 = createHash("sha256").update(content).digest("hex");
      expect(content).toBe(prompt.content);
      expect(sha256).toBe(prompt.sha256);
    }
    const expectedRevision = createHash("sha256")
      .update(
        STELLA_PROMPT_DEFAULTS.prompts
          .map((prompt) => `${prompt.id}:${prompt.sha256}`)
          .join("\n"),
      )
      .digest("hex");
    expect(STELLA_PROMPT_DEFAULTS.revision).toBe(expectedRevision);
  });
});
