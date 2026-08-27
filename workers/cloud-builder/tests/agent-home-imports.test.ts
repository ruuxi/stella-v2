import { describe, expect, test } from "bun:test";
import {
  agentHomeGenerationRoot,
  importedMemoryDocumentFromKey,
} from "../src/agent-home.js";

describe("imported agent home", () => {
  test("recognizes product-readable imported memory documents", () => {
    expect(
      importedMemoryDocumentFromKey(
        "agent-home/connected/",
        "agent-home/connected/__stella_imported__/anonymous/memories/MEMORY.md",
      ),
    ).toEqual({
      name: "MEMORY.md (imported anonymous)",
      policyName: "MEMORY.md",
      displayPath: "~/.stella/imported/anonymous/MEMORY.md",
    });
  });

  test("ignores objects outside imported memory document paths", () => {
    expect(
      importedMemoryDocumentFromKey(
        "agent-home/connected/",
        "agent-home/connected/memories/MEMORY.md",
      ),
    ).toBeNull();
    expect(
      importedMemoryDocumentFromKey(
        "agent-home/connected/",
        "agent-home/connected/__stella_imported__/anonymous/random.bin",
      ),
    ).toBeNull();
  });

  test("isolates canonical memory bytes by owner lifecycle generation", async () => {
    const first = await agentHomeGenerationRoot("owner-1", "generation-1");
    const second = await agentHomeGenerationRoot("owner-1", "generation-2");
    expect(first).not.toBe(second);
    expect(first).toMatch(
      /^agent-home\/[0-9a-f]{64}\/generations\/[0-9a-f]{64}\/$/,
    );
  });
});
