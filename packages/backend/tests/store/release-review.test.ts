import { describe, expect, it } from "bun:test";
import { parseReviewableStoreArtifact } from "../../convex/lib/store_release_reviews";

describe("parseReviewableStoreArtifact", () => {
  it("threads reference commits through markdown blueprint review", () => {
    const parsed = parseReviewableStoreArtifact("# spec", [
      {
        hash: "abc123",
        subject: "Add quiet mode",
        diff: "diff --git a/runtime/quiet-mode.ts b/runtime/quiet-mode.ts\n+export const quiet = true;\n",
      },
    ]);

    const blueprint = parsed.codeFiles.find(
      (file) => file.path === "blueprint.md",
    );
    expect(blueprint?.contentText).toContain("# Behaviour spec");
    expect(blueprint?.contentText).toContain("# Reference commits");
    expect(blueprint?.contentText).toContain("Subject: Add quiet mode");
  });
});
