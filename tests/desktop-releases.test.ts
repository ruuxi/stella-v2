import { describe, expect, test } from "bun:test";
import { normalizeArtifactRefs } from "../convex/http_routes/desktop_releases";

describe("desktop release artifact refs", () => {
  test("accepts a pinned Stella Browser executable", () => {
    expect(
      normalizeArtifactRefs([
        {
          kind: "stella-browser",
          platform: "darwin-arm64",
          asset: {
            url: "https://releases.test/stella-browser-darwin-arm64",
            sha256: `sha256:${"a".repeat(64)}`,
            sizeBytes: 1234,
          },
        },
      ]),
    ).toEqual([
      {
        kind: "stella-browser",
        platform: "darwin-arm64",
        asset: {
          url: "https://releases.test/stella-browser-darwin-arm64",
          sha256: `sha256:${"a".repeat(64)}`,
          sizeBytes: 1234,
        },
      },
    ]);
  });

  test("still requires a manifest URL for native helpers", () => {
    expect(
      normalizeArtifactRefs([
        {
          kind: "native-helpers",
          platform: "darwin-arm64",
          asset: {
            url: "https://releases.test/native-helpers",
            sha256: `sha256:${"b".repeat(64)}`,
            sizeBytes: 1234,
          },
        },
      ]),
    ).toBeNull();
  });
});
