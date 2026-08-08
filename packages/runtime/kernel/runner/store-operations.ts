import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseCommit,
  StoreReleaseDiffRef,
  StoreReleaseGitArtifact,
} from "@stella/contracts";
import type { RunnerContext, StoreOperations } from "./types.js";

const storePackageCoreSchema = z.looseObject({
  packageId: z.string(),
  displayName: z.string(),
  latestReleaseNumber: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const isStorePackageCore = (
  value: unknown,
): value is z.infer<typeof storePackageCoreSchema> =>
  storePackageCoreSchema.safeParse(value).success;

const storeReleaseCoreSchema = z.looseObject({
  packageId: z.string(),
  releaseNumber: z.number(),
  createdAt: z.number(),
  blueprintMarkdown: z.string(),
});

const isStoreReleaseCore = (
  value: unknown,
): value is z.infer<typeof storeReleaseCoreSchema> =>
  storeReleaseCoreSchema.safeParse(value).success;

const gitArtifactSchema = z.looseObject({
  kind: z.literal("git-object-artifact"),
  schemaVersion: z.literal(1),
});

const isGitArtifact = (value: unknown): value is StoreReleaseGitArtifact =>
  gitArtifactSchema.safeParse(value).success;

const diffRefSchema = z.looseObject({
  kind: z.literal("r2"),
  r2Key: z.string(),
  sha256: z.string(),
  sizeBytes: z.number(),
});

const isDiffRef = (value: unknown): value is StoreReleaseDiffRef =>
  diffRefSchema.safeParse(value).success;

const releaseCommitSchema = z.object({
  hash: z.string(),
  subject: z.string(),
  diff: z.string(),
});

export const createStoreOperations = (
  context: RunnerContext,
  deps: {
    ensureStoreClient: () => any;
  },
): StoreOperations => {
  const toSharedStorePackage = (value: unknown): StorePackageRecord | null => {
    if (!isStorePackageCore(value)) {
      return null;
    }
    const record = value;
    const validCategories = new Set([
      "apps-games",
      "productivity",
      "customization",
      "skills-agents",
      "integrations",
      "other",
    ]);
    const tags = Array.isArray(record.tags)
      ? record.tags.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : undefined;
    return {
      packageId: record.packageId,
      ...(typeof record.category === "string" &&
      validCategories.has(record.category)
        ? { category: record.category as StorePackageRecord["category"] }
        : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
      displayName: record.displayName,
      ...(typeof record.description === "string" && record.description
        ? { description: record.description }
        : {}),
      latestReleaseNumber: record.latestReleaseNumber,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(typeof record.iconUrl === "string" && record.iconUrl
        ? { iconUrl: record.iconUrl }
        : {}),
      ...(typeof record.authorUsername === "string" && record.authorUsername
        ? { authorUsername: record.authorUsername }
        : {}),
      ...(record.featured === true ? { featured: true } : {}),
      ...(record.visibility === "public" ||
      record.visibility === "unlisted" ||
      record.visibility === "private"
        ? { visibility: record.visibility }
        : {}),
    };
  };

  const toSharedStoreRelease = (args: {
    release: unknown;
    packageRecord: StorePackageRecord;
  }): StorePackageReleaseRecord | null => {
    if (!isStoreReleaseCore(args.release)) {
      return null;
    }
    const record = args.release;
    const manifest =
      record.manifest && typeof record.manifest === "object"
        ? (record.manifest as Record<string, unknown>)
        : null;
    if (!manifest) {
      return null;
    }
    const gitArtifact = isGitArtifact(record.gitArtifact)
      ? record.gitArtifact
      : undefined;
    const diffRef = isDiffRef(record.diffRef) ? record.diffRef : undefined;
    const commitsDiffRef = isDiffRef(record.commitsDiffRef)
      ? record.commitsDiffRef
      : undefined;
    const validManifestCategories = new Set([
      "apps-games",
      "productivity",
      "customization",
      "skills-agents",
      "integrations",
      "other",
    ]);
    return {
      packageId: record.packageId,
      releaseNumber: record.releaseNumber,
      manifest: {
        packageId: record.packageId,
        releaseNumber: record.releaseNumber,
        category:
          typeof manifest.category === "string" &&
          validManifestCategories.has(manifest.category)
            ? (manifest.category as StorePackageRecord["category"] & string)
            : "other",
        displayName: args.packageRecord.displayName,
        ...(args.packageRecord.description
          ? { description: args.packageRecord.description }
          : {}),
        ...(typeof record.releaseNotes === "string"
          ? { releaseNotes: record.releaseNotes }
          : {}),
        createdAt: record.createdAt,
        ...(typeof manifest.authoredAtCommit === "string" &&
        manifest.authoredAtCommit
          ? { authoredAtCommit: manifest.authoredAtCommit }
          : {}),
        ...(typeof manifest.iconUrl === "string" && manifest.iconUrl
          ? { iconUrl: manifest.iconUrl }
          : args.packageRecord.iconUrl
            ? { iconUrl: args.packageRecord.iconUrl }
            : {}),
      },
      blueprintMarkdown: record.blueprintMarkdown,
      ...(gitArtifact ? { gitArtifact } : {}),
      ...(diffRef ? { diffRef } : {}),
      ...(commitsDiffRef ? { commitsDiffRef } : {}),
      createdAt: record.createdAt,
    };
  };

  const hydrateReleaseDiff = async (
    client: any,
    release: StorePackageReleaseRecord | null,
  ): Promise<StorePackageReleaseRecord | null> => {
    if (!release || release.diff || !release.diffRef) {
      return release;
    }
    const diff = (await client.action(
      (
        context.convexApi as {
          data: {
            store_git_artifacts: { getReleaseDiff: unknown };
          };
        }
      ).data.store_git_artifacts.getReleaseDiff,
      {
        packageId: release.packageId,
        releaseNumber: release.releaseNumber,
      },
    )) as string | null;
    return diff ? { ...release, diff } : release;
  };

  const hydrateReleaseCommits = async (
    client: any,
    release: StorePackageReleaseRecord | null,
  ): Promise<StorePackageReleaseRecord | null> => {
    if (
      !release ||
      (release.commits && release.commits.length > 0) ||
      !release.commitsDiffRef
    ) {
      return release;
    }
    const raw = (await client.action(
      (
        context.convexApi as {
          data: {
            store_git_artifacts: { getReleaseCommits: unknown };
          };
        }
      ).data.store_git_artifacts.getReleaseCommits,
      {
        packageId: release.packageId,
        releaseNumber: release.releaseNumber,
      },
    )) as unknown;
    const commits = Array.isArray(raw)
      ? raw
          .map((entry): StoreReleaseCommit | null => {
            const parsed = releaseCommitSchema.safeParse(entry);
            return parsed.success ? parsed.data : null;
          })
          .filter((entry): entry is StoreReleaseCommit => entry !== null)
      : [];
    return commits.length > 0 ? { ...release, commits } : release;
  };

  const hydrateReleaseArtifact = async (
    client: any,
    release: StorePackageReleaseRecord | null,
  ): Promise<StorePackageReleaseRecord | null> =>
    await hydrateReleaseCommits(
      client,
      await hydrateReleaseDiff(client, release),
    );

  const listStorePackages = async (): Promise<StorePackageRecord[]> => {
    const client = deps.ensureStoreClient();
    const records = (await client.query(
      (
        context.convexApi as {
          data: { store_packages: { listPackages: unknown } };
        }
      ).data.store_packages.listPackages,
      {},
    )) as unknown[];
    return records
      .map((record) => toSharedStorePackage(record))
      .filter((record): record is StorePackageRecord => Boolean(record));
  };

  // The runner's package + release readers go through the *public*
  // queries because the install pipeline must be able to fetch any
  // creator's add-on, not just the current user's. The owner-filtered
  // `listPackages` query still feeds "your add-ons" surfaces directly
  // from the renderer.
  const getStorePackage = async (
    packageId: string,
  ): Promise<StorePackageRecord | null> => {
    const client = deps.ensureStoreClient();
    const record = await client.query(
      (
        context.convexApi as {
          data: { store_packages: { getPublicPackage: unknown } };
        }
      ).data.store_packages.getPublicPackage,
      { packageId },
    );
    return toSharedStorePackage(record);
  };

  const listStorePackageReleases = async (
    packageId: string,
  ): Promise<StorePackageReleaseRecord[]> => {
    const client = deps.ensureStoreClient();
    const packageRecord = await getStorePackage(packageId);
    if (!packageRecord) {
      return [];
    }
    const records = (await client.query(
      (
        context.convexApi as {
          data: { store_packages: { listPublicReleases: unknown } };
        }
      ).data.store_packages.listPublicReleases,
      { packageId },
    )) as unknown[];
    return records
      .map((record) => toSharedStoreRelease({ release: record, packageRecord }))
      .filter((record): record is StorePackageReleaseRecord => Boolean(record));
  };

  const getStorePackageRelease = async (
    packageId: string,
    releaseNumber: number,
  ): Promise<StorePackageReleaseRecord | null> => {
    const client = deps.ensureStoreClient();
    const packageRecord = await getStorePackage(packageId);
    if (!packageRecord) {
      return null;
    }
    const record = await client.query(
      (
        context.convexApi as {
          data: { store_packages: { getPublicRelease: unknown } };
        }
      ).data.store_packages.getPublicRelease,
      { packageId, releaseNumber },
    );
    return await hydrateReleaseArtifact(
      client,
      toSharedStoreRelease({ release: record, packageRecord }),
    );
  };

  return {
    listStorePackages,
    getStorePackage,
    listStorePackageReleases,
    getStorePackageRelease,
  };
};
