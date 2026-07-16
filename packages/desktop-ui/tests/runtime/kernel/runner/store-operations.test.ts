import { describe, expect, it, vi } from "vitest";
import { createStoreOperations } from "@stella/runtime/kernel/runner/store-operations";
import type { StorePackageRecord } from "@stella/contracts";

const refs = {
  data: {
    store_packages: {
      getPublicPackage: "getPublicPackage",
      getPublicRelease: "getPublicRelease",
      listPackages: "listPackages",
      listPublicReleases: "listPublicReleases",
    },
    store_git_artifacts: {
      getReleaseDiff: "getReleaseDiff",
      getReleaseCommits: "getReleaseCommits",
    },
  },
};

const packageRecord: StorePackageRecord = {
  packageId: "large-pack",
  category: "customization",
  displayName: "Large Pack",
  latestReleaseNumber: 1,
  createdAt: 1,
  updatedAt: 1,
};

describe("Store runner browsing", () => {
  it("hydrates R2 diff and commit refs when fetching a release", async () => {
    const client = {
      query: vi.fn(async (ref: unknown) => {
        if (ref === refs.data.store_packages.getPublicPackage) {
          return packageRecord;
        }
        if (ref === refs.data.store_packages.getPublicRelease) {
          return {
            packageId: "large-pack",
            releaseNumber: 1,
            manifest: { category: "customization" },
            blueprintMarkdown: "spec",
            commits: [{ hash: "c".repeat(40), subject: "feat: one" }],
            commitsDiffRef: {
              kind: "r2",
              r2Key: "store/git-diffs/user/large-pack/commits.diff",
              sha256: "sha256:0".padEnd(71, "0"),
              sizeBytes: 100,
            },
            diffRef: {
              kind: "r2",
              r2Key: "store/git-diffs/user/large-pack/diff.diff",
              sha256: "sha256:0".padEnd(71, "0"),
              sizeBytes: 700_000,
            },
            createdAt: 2,
          };
        }
        throw new Error(`Unexpected query ${String(ref)}`);
      }),
      action: vi.fn(async (ref: unknown) => {
        if (ref === refs.data.store_git_artifacts.getReleaseDiff) {
          return "diff --git a/file.ts b/file.ts\n+ok();";
        }
        if (ref === refs.data.store_git_artifacts.getReleaseCommits) {
          return [
            { hash: "c".repeat(40), subject: "feat: one", diff: "diff one" },
          ];
        }
        throw new Error(`Unexpected action ${String(ref)}`);
      }),
    };
    const operations = createStoreOperations({ convexApi: refs } as never, {
      ensureStoreClient: () => client,
    });

    const release = await operations.getStorePackageRelease("large-pack", 1);

    expect(release?.diff).toBe("diff --git a/file.ts b/file.ts\n+ok();");
    expect(release?.commits).toEqual([
      { hash: "c".repeat(40), subject: "feat: one", diff: "diff one" },
    ]);
    expect(client.action).toHaveBeenCalledWith(
      refs.data.store_git_artifacts.getReleaseDiff,
      { packageId: "large-pack", releaseNumber: 1 },
    );
    expect(client.action).toHaveBeenCalledWith(
      refs.data.store_git_artifacts.getReleaseCommits,
      { packageId: "large-pack", releaseNumber: 1 },
    );
  });
});
