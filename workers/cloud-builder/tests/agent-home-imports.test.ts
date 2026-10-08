import { describe, expect, test } from "bun:test";
import { agentHomeGenerationRoot } from "../src/agent-home.js";

describe("imported agent home", () => {
  test("isolates canonical memory bytes by owner lifecycle generation", async () => {
    const first = await agentHomeGenerationRoot("owner-1", "generation-1");
    const second = await agentHomeGenerationRoot("owner-1", "generation-2");
    expect(first).not.toBe(second);
    expect(first).toMatch(
      /^agent-home\/[0-9a-f]{64}\/generations\/[0-9a-f]{64}\/$/,
    );
  });
});
