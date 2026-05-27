import { describe, expect, it } from "bun:test";
import { parseReviewableStoreArtifact } from "../../convex/lib/store_release_reviews";

const legacyArtifact = JSON.stringify({
  kind: "self_mod_blueprint",
  schemaVersion: 1,
  manifest: {
    packageId: "quiet-mode",
    releaseNumber: 1,
    displayName: "Quiet Mode",
    description: "Adds quiet mode.",
    batchIds: [],
    commitHashes: [],
    files: [],
    createdAt: 1,
  },
  applyGuidance: "Apply the feature.",
  batches: [],
  files: [],
});

describe("parseReviewableStoreArtifact", () => {
  it("threads source packs through legacy JSON artifact review", () => {
    const parsed = parseReviewableStoreArtifact(legacyArtifact, [], {
      kind: "stella-source-pack",
      schemaVersion: 1,
      baseRevisionId: "git:base",
      revisionId: "sha256:next",
      changeSets: [
        {
          schemaVersion: 1,
          baseRevisionId: "git:base",
          parentRevisionIds: ["git:base"],
          revisionId: "sha256:next",
          changes: [
            {
              path: "runtime/quiet-mode.ts",
              baseHash: null,
              nextHash: "sha256:next",
              next: { kind: "text", content: "export const quiet = true;\n" },
            },
          ],
        },
      ],
    });

    expect(parsed.codeFiles.map((file) => file.path)).toContain(
      "SOURCE_PACK_MANIFEST.json",
    );
    expect(parsed.codeFiles.map((file) => file.path)).toContain(
      "runtime/quiet-mode.ts",
    );
  });

  it("rejects non-image binary source-pack changes", () => {
    expect(() =>
      parseReviewableStoreArtifact("# spec", [], {
        kind: "stella-source-pack",
        schemaVersion: 1,
        baseRevisionId: "git:base",
        revisionId: "sha256:next",
        changeSets: [
          {
            schemaVersion: 1,
            baseRevisionId: "git:base",
            parentRevisionIds: ["git:base"],
            revisionId: "sha256:next",
            changes: [
              {
                path: "desktop/native/out/helper.node",
                baseHash: null,
                nextHash: "sha256:next",
                next: {
                  kind: "binary",
                  contentBase64: Buffer.from("native").toString("base64"),
                },
              },
            ],
          },
        ],
      }),
    ).toThrow("unreviewable binary change");
  });
});
