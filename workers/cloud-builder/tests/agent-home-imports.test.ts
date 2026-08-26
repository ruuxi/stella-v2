import { describe, expect, test } from "bun:test";
import { importedMemoryDocumentFromKey } from "../src/agent-home.js";

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
});
