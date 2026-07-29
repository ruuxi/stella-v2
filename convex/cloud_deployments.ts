import { ConvexError, v } from "convex/values";
import {
  internalQuery,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

const INTERIOR_KIND = "stella-interior" as const;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_BUILD_ID_LENGTH = 160;
const MAX_REVISION_LENGTH = 256;
const MAX_VERSION_LENGTH = 96;
const MAX_ARTIFACT_FILES = 2_000;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_FILE_BYTES = 25 * 1024 * 1024;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const STABLE_ROUTE_ID =
  /^sr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SAFE_ARTIFACT_PATH =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUIRED_ENTRIES = {
  full: "index.html",
  mini: "mini.html",
  overlay: "overlay.html",
  pet: "pet.html",
} as const;

const requireOwnerId = async (ctx: {
  auth: { getUserIdentity: () => Promise<{ tokenIdentifier: string } | null> };
}): Promise<string> => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError("Sign in to manage Stella deployments.");
  }
  return identity.tokenIdentifier;
};

const deployableIdForOwner = (ownerId: string): string =>
  `stella-interior:${ownerId}`;

const requireNonEmpty = (
  value: string,
  field: string,
  maxLength: number,
): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ConvexError(`Invalid ${field}.`);
  }
  return normalized;
};

const normalizeDigest = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_DIGEST.test(normalized)) {
    throw new ConvexError(
      "artifactDigest must be a sha256: prefixed lowercase hex digest.",
    );
  }
  return normalized;
};

const sha256Utf8 = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new ConvexError(`${label} contains unsupported or missing fields.`);
  }
};

const requireRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConvexError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const validateManifestJson = async (
  value: string,
  expected: {
    buildId: string;
    artifactPrefix: string;
    artifactDigest: string;
    artifactSizeBytes: number;
    bridgeAbi: number;
    minShellVersion: string;
  },
): Promise<string> => {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_MANIFEST_BYTES
  ) {
    throw new ConvexError("Invalid artifactManifestJson.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ConvexError("artifactManifestJson must encode a JSON object.");
  }
  const manifest = requireRecord(parsed, "artifactManifestJson");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "buildId",
      "version",
      "artifactPrefix",
      "entries",
      "files",
      "artifactSha256",
      "size",
      "bridgeAbi",
      "minShellVersion",
    ],
    "artifactManifestJson",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.buildId !== expected.buildId ||
    manifest.version !== expected.buildId ||
    manifest.artifactPrefix !== expected.artifactPrefix ||
    manifest.size !== expected.artifactSizeBytes ||
    manifest.bridgeAbi !== expected.bridgeAbi ||
    manifest.minShellVersion !== expected.minShellVersion
  ) {
    throw new ConvexError(
      "Artifact manifest metadata contradicts the immutable build candidate.",
    );
  }
  const artifactSha256 = manifest.artifactSha256;
  if (
    typeof artifactSha256 !== "string" ||
    !SHA256_HEX.test(artifactSha256) ||
    `sha256:${artifactSha256}` !== expected.artifactDigest
  ) {
    throw new ConvexError(
      "Artifact manifest digest contradicts the immutable build candidate.",
    );
  }

  const entries = requireRecord(
    manifest.entries,
    "artifactManifestJson.entries",
  );
  exactKeys(
    entries,
    Object.keys(REQUIRED_ENTRIES),
    "artifactManifestJson.entries",
  );
  for (const [name, path] of Object.entries(REQUIRED_ENTRIES)) {
    if (entries[name] !== path) {
      throw new ConvexError(`Invalid Stella interior entrypoint: ${name}.`);
    }
  }

  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > MAX_ARTIFACT_FILES
  ) {
    throw new ConvexError("Artifact manifest files must be a bounded array.");
  }
  const paths = new Set<string>();
  const portablePaths = new Set<string>();
  let totalBytes = 0;
  let previousPath = "";
  const canonicalFiles: Array<{
    path: string;
    size: number;
    sha256: string;
  }> = [];
  const expectedUrlPrefix = `/interior-builds/${expected.artifactPrefix.slice(
    "interiors/".length,
  )}/`;
  for (let index = 0; index < manifest.files.length; index += 1) {
    const file = requireRecord(
      manifest.files[index],
      `artifactManifestJson.files[${index}]`,
    );
    exactKeys(
      file,
      ["path", "url", "size", "sha256", "contentType"],
      `artifactManifestJson.files[${index}]`,
    );
    const path = file.path;
    if (
      typeof path !== "string" ||
      path.length > 512 ||
      path.includes("\\") ||
      path.includes("\0") ||
      !SAFE_ARTIFACT_PATH.test(path) ||
      path.split("/").some((segment) => segment.normalize("NFC") !== segment) ||
      path.toLowerCase() === "manifest.json" ||
      (previousPath && previousPath >= path)
    ) {
      throw new ConvexError(`Invalid artifact file path at index ${index}.`);
    }
    previousPath = path;
    const portablePath = path.toLowerCase();
    if (paths.has(path) || portablePaths.has(portablePath)) {
      throw new ConvexError(`Duplicate artifact file path: ${path}.`);
    }
    paths.add(path);
    portablePaths.add(portablePath);
    if (
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_ARTIFACT_FILE_BYTES
    ) {
      throw new ConvexError(`Invalid artifact file size: ${path}.`);
    }
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARTIFACT_BYTES) {
      throw new ConvexError("Artifact manifest exceeds its total size limit.");
    }
    if (typeof file.sha256 !== "string" || !SHA256_HEX.test(file.sha256)) {
      throw new ConvexError(`Invalid artifact file digest: ${path}.`);
    }
    if (
      typeof file.contentType !== "string" ||
      file.contentType.length === 0 ||
      file.contentType.length > 128 ||
      /[\r\n]/.test(file.contentType)
    ) {
      throw new ConvexError(`Invalid artifact content type: ${path}.`);
    }
    if (typeof file.url !== "string" || file.url.length > 4_096) {
      throw new ConvexError(`Invalid artifact URL: ${path}.`);
    }
    let url: URL;
    try {
      url = new URL(file.url);
    } catch {
      throw new ConvexError(`Invalid artifact URL: ${path}.`);
    }
    const expectedPathname = `${expectedUrlPrefix}${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== expectedPathname
    ) {
      throw new ConvexError(`Artifact URL does not match its path: ${path}.`);
    }
    canonicalFiles.push({ path, size: file.size, sha256: file.sha256 });
  }
  for (const path of Object.values(REQUIRED_ENTRIES)) {
    if (!paths.has(path)) {
      throw new ConvexError(`Artifact manifest is missing ${path}.`);
    }
  }
  if (!Array.from(paths).some((path) => path.startsWith("assets/"))) {
    throw new ConvexError("Artifact manifest is missing compiled assets.");
  }
  if (totalBytes !== expected.artifactSizeBytes) {
    throw new ConvexError(
      "Artifact manifest file sizes contradict the immutable build candidate.",
    );
  }
  const descriptorDigest = await sha256Utf8(JSON.stringify(canonicalFiles));
  if (descriptorDigest !== expected.artifactDigest) {
    throw new ConvexError(
      "Artifact manifest file descriptors do not match artifactDigest.",
    );
  }
  return value;
};

const validateNaturalNumber = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConvexError(`Invalid ${field}.`);
  }
  return value;
};

const buildMetadataValidator = v.object({
  buildId: v.string(),
  deployableId: v.string(),
  turnId: v.string(),
  threadId: v.string(),
  sourceRevision: v.union(v.string(), v.null()),
  baseRevision: v.union(v.string(), v.null()),
  artifactPrefix: v.string(),
  manifestSha256: v.string(),
  artifactDigest: v.string(),
  artifactSizeBytes: v.number(),
  bridgeAbi: v.number(),
  minShellVersion: v.string(),
  createdAt: v.number(),
  isActive: v.boolean(),
  isPrevious: v.boolean(),
});

const buildValidator = v.object({
  buildId: v.string(),
  deployableId: v.string(),
  turnId: v.string(),
  threadId: v.string(),
  sourceRevision: v.union(v.string(), v.null()),
  baseRevision: v.union(v.string(), v.null()),
  artifactPrefix: v.string(),
  artifactManifestJson: v.string(),
  manifestSha256: v.string(),
  artifactDigest: v.string(),
  artifactSizeBytes: v.number(),
  bridgeAbi: v.number(),
  minShellVersion: v.string(),
  createdAt: v.number(),
  isActive: v.boolean(),
  isPrevious: v.boolean(),
});

const deploymentResultValidator = v.object({
  deployableId: v.string(),
  activeBuildId: v.union(v.string(), v.null()),
  previousBuildId: v.union(v.string(), v.null()),
  routeRevision: v.number(),
});

type InteriorBuildRow = {
  buildId: string;
  deployableId: string;
  turnId: string;
  threadId: string;
  sourceRevision?: string;
  baseRevision?: string;
  artifactPrefix: string;
  artifactManifestJson: string;
  manifestSha256: string;
  artifactDigest: string;
  artifactSizeBytes: number;
  bridgeAbi: number;
  minShellVersion: string;
  createdAt: number;
};

const presentBuildMetadata = (
  row: InteriorBuildRow,
  activeBuildId?: string,
  previousBuildId?: string,
) => ({
  buildId: row.buildId,
  deployableId: row.deployableId,
  turnId: row.turnId,
  threadId: row.threadId,
  sourceRevision: row.sourceRevision ?? null,
  baseRevision: row.baseRevision ?? null,
  artifactPrefix: row.artifactPrefix,
  manifestSha256: row.manifestSha256,
  artifactDigest: row.artifactDigest,
  artifactSizeBytes: row.artifactSizeBytes,
  bridgeAbi: row.bridgeAbi,
  minShellVersion: row.minShellVersion,
  createdAt: row.createdAt,
  isActive: row.buildId === activeBuildId,
  isPrevious: row.buildId === previousBuildId,
});

const presentBuild = (
  row: InteriorBuildRow,
  activeBuildId?: string,
  previousBuildId?: string,
) => ({
  ...presentBuildMetadata(row, activeBuildId, previousBuildId),
  artifactManifestJson: row.artifactManifestJson,
});

const getOwnerDeployment = async (
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  ownerId: string,
) =>
  await ctx.db
    .query("cloud_interior_deployables")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

const allocateStableRouteId = async (ctx: Pick<MutationCtx, "db">) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stableRouteId = `sr_${crypto.randomUUID()}`;
    const collision = await ctx.db
      .query("cloud_interior_deployables")
      .withIndex("by_stableRouteId", (q) =>
        q.eq("stableRouteId", stableRouteId),
      )
      .unique();
    if (!collision) return stableRouteId;
  }
  throw new ConvexError("Could not allocate a Stella web route.");
};

export const getMyActiveInteriorManifest = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      deployableId: v.string(),
      routeRevision: v.number(),
      previousBuildId: v.union(v.string(), v.null()),
      build: buildValidator,
    }),
  ),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const deployment = await getOwnerDeployment(ctx, ownerId);
    if (!deployment?.activeBuildId) {
      return null;
    }
    const build = await ctx.db
      .query("cloud_interior_builds")
      .withIndex("by_buildId", (q) =>
        q.eq("buildId", deployment.activeBuildId as string),
      )
      .unique();
    if (
      !build ||
      build.ownerId !== ownerId ||
      build.deployableId !== deployment.deployableId
    ) {
      throw new ConvexError("The active Stella interior build is unavailable.");
    }
    return {
      deployableId: deployment.deployableId,
      routeRevision: deployment.routeRevision,
      previousBuildId: deployment.previousBuildId ?? null,
      build: presentBuild(
        build,
        deployment.activeBuildId,
        deployment.previousBuildId,
      ),
    };
  },
});

export const listMyInteriorBuilds = query({
  args: { limit: v.optional(v.number()) },
  returns: v.object({
    deployableId: v.union(v.string(), v.null()),
    stableRouteId: v.union(v.string(), v.null()),
    activeBuildId: v.union(v.string(), v.null()),
    previousBuildId: v.union(v.string(), v.null()),
    routeRevision: v.number(),
    builds: v.array(buildMetadataValidator),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const requestedLimit = args.limit ?? 20;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new ConvexError("limit must be a positive integer.");
    }
    const limit = Math.min(requestedLimit, 50);
    const deployment = await getOwnerDeployment(ctx, ownerId);
    const builds = await ctx.db
      .query("cloud_interior_builds")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(limit);
    return {
      deployableId: deployment?.deployableId ?? null,
      stableRouteId: deployment?.stableRouteId ?? null,
      activeBuildId: deployment?.activeBuildId ?? null,
      previousBuildId: deployment?.previousBuildId ?? null,
      routeRevision: deployment?.routeRevision ?? 0,
      builds: builds.map((build) =>
        presentBuildMetadata(
          build,
          deployment?.activeBuildId,
          deployment?.previousBuildId,
        ),
      ),
    };
  },
});

export const ensureMyInteriorStableRoute = mutation({
  args: {},
  returns: v.object({ stableRouteId: v.string() }),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const deployment = await getOwnerDeployment(ctx, ownerId);
    if (
      deployment?.stableRouteId &&
      STABLE_ROUTE_ID.test(deployment.stableRouteId)
    ) {
      return { stableRouteId: deployment.stableRouteId };
    }
    const stableRouteId = await allocateStableRouteId(ctx);
    const now = Date.now();
    if (deployment) {
      await ctx.db.patch(deployment._id, { stableRouteId, updatedAt: now });
    } else {
      await ctx.db.insert("cloud_interior_deployables", {
        deployableId: deployableIdForOwner(ownerId),
        ownerId,
        stableRouteId,
        kind: INTERIOR_KIND,
        routeRevision: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
    return { stableRouteId };
  },
});

export const rotateMyInteriorStableRoute = mutation({
  args: {},
  returns: v.object({ stableRouteId: v.string() }),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const deployment = await getOwnerDeployment(ctx, ownerId);
    const stableRouteId = await allocateStableRouteId(ctx);
    const now = Date.now();
    if (deployment) {
      await ctx.db.patch(deployment._id, { stableRouteId, updatedAt: now });
    } else {
      await ctx.db.insert("cloud_interior_deployables", {
        deployableId: deployableIdForOwner(ownerId),
        ownerId,
        stableRouteId,
        kind: INTERIOR_KIND,
        routeRevision: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
    return { stableRouteId };
  },
});

export const recordInteriorBuildInternal = internalMutation({
  args: {
    buildId: v.string(),
    ownerId: v.string(),
    turnId: v.string(),
    threadId: v.string(),
    sourceRevision: v.optional(v.string()),
    baseRevision: v.optional(v.string()),
    artifactPrefix: v.string(),
    artifactManifestJson: v.string(),
    manifestSha256: v.optional(v.string()),
    artifactDigest: v.string(),
    artifactSizeBytes: v.number(),
    bridgeAbi: v.number(),
    minShellVersion: v.string(),
    now: v.number(),
  },
  returns: v.object({
    created: v.boolean(),
    buildId: v.string(),
    deployableId: v.string(),
  }),
  handler: async (ctx, args) => {
    const buildId = requireNonEmpty(
      args.buildId,
      "buildId",
      MAX_BUILD_ID_LENGTH,
    );
    const ownerId = requireNonEmpty(args.ownerId, "ownerId", 1024);
    const turnId = requireNonEmpty(args.turnId, "turnId", 160);
    const threadId = requireNonEmpty(args.threadId, "threadId", 160);
    const sourceRevision =
      args.sourceRevision === undefined
        ? undefined
        : requireNonEmpty(
            args.sourceRevision,
            "sourceRevision",
            MAX_REVISION_LENGTH,
          );
    if (sourceRevision !== undefined && !SHA256_DIGEST.test(sourceRevision)) {
      throw new ConvexError("sourceRevision must be a SHA-256 revision.");
    }
    const baseRevision =
      args.baseRevision === undefined
        ? undefined
        : requireNonEmpty(
            args.baseRevision,
            "baseRevision",
            MAX_REVISION_LENGTH,
          );
    if (baseRevision !== undefined && !SHA256_DIGEST.test(baseRevision)) {
      throw new ConvexError("baseRevision must be a SHA-256 revision.");
    }
    const artifactDigest = normalizeDigest(args.artifactDigest);
    const artifactSizeBytes = validateNaturalNumber(
      args.artifactSizeBytes,
      "artifactSizeBytes",
    );
    if (artifactSizeBytes < 1 || artifactSizeBytes > MAX_ARTIFACT_BYTES) {
      throw new ConvexError("artifactSizeBytes is outside its allowed bounds.");
    }
    const bridgeAbi = validateNaturalNumber(args.bridgeAbi, "bridgeAbi");
    if (bridgeAbi < 1 || bridgeAbi > 10_000) {
      throw new ConvexError("bridgeAbi is outside its allowed bounds.");
    }
    const minShellVersion = requireNonEmpty(
      args.minShellVersion,
      "minShellVersion",
      MAX_VERSION_LENGTH,
    );
    if (!SEMVER.test(minShellVersion)) {
      throw new ConvexError("minShellVersion must be a semantic version.");
    }
    const ownerHash = (await sha256Utf8(ownerId)).slice("sha256:".length);
    const expectedBuildHash = (
      await sha256Utf8(
        `${ownerId}\0${turnId}\0${artifactDigest.slice("sha256:".length)}`,
      )
    ).slice("sha256:".length);
    const expectedBuildId = `interior-${expectedBuildHash.slice(0, 48)}`;
    if (buildId !== expectedBuildId) {
      throw new ConvexError(
        "buildId does not match its owner, turn, and artifact digest.",
      );
    }
    const artifactPrefix = requireNonEmpty(
      args.artifactPrefix,
      "artifactPrefix",
      512,
    );
    if (artifactPrefix !== `interiors/${ownerHash}/${buildId}`) {
      throw new ConvexError(
        "artifactPrefix does not match its owner and buildId.",
      );
    }
    const artifactManifestJson = await validateManifestJson(
      args.artifactManifestJson,
      {
        buildId,
        artifactPrefix,
        artifactDigest,
        artifactSizeBytes,
        bridgeAbi,
        minShellVersion,
      },
    );
    const manifestSha256 = await sha256Utf8(artifactManifestJson);
    if (
      args.manifestSha256 !== undefined &&
      normalizeDigest(args.manifestSha256) !== manifestSha256
    ) {
      throw new ConvexError(
        "manifestSha256 does not match the exact manifestJson bytes.",
      );
    }
    const now = validateNaturalNumber(args.now, "now");
    const deployableId = deployableIdForOwner(ownerId);

    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", turnId))
      .unique();
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .unique();
    if (
      !turn ||
      !thread ||
      turn.ownerId !== ownerId ||
      thread.ownerId !== ownerId ||
      turn.threadId !== threadId ||
      turn.workspace !== "stella" ||
      thread.workspace !== "stella"
    ) {
      throw new ConvexError(
        "Interior candidate does not belong to a Stella workspace turn.",
      );
    }

    const existing = await ctx.db
      .query("cloud_interior_builds")
      .withIndex("by_buildId", (q) => q.eq("buildId", buildId))
      .unique();
    if (existing) {
      const identical =
        existing.ownerId === ownerId &&
        existing.deployableId === deployableId &&
        existing.turnId === turnId &&
        existing.threadId === threadId &&
        existing.sourceRevision === sourceRevision &&
        existing.baseRevision === baseRevision &&
        existing.artifactPrefix === artifactPrefix &&
        existing.artifactManifestJson === artifactManifestJson &&
        existing.manifestSha256 === manifestSha256 &&
        existing.artifactDigest === artifactDigest &&
        existing.artifactSizeBytes === artifactSizeBytes &&
        existing.bridgeAbi === bridgeAbi &&
        existing.minShellVersion === minShellVersion;
      if (!identical) {
        throw new ConvexError(
          "buildId is already bound to a different immutable candidate.",
        );
      }
      return { created: false, buildId, deployableId };
    }

    const deployment = await getOwnerDeployment(ctx, ownerId);
    if (deployment && deployment.deployableId !== deployableId) {
      throw new ConvexError("Invalid Stella interior deployable.");
    }
    if (!deployment) {
      await ctx.db.insert("cloud_interior_deployables", {
        deployableId,
        ownerId,
        stableRouteId: await allocateStableRouteId(ctx),
        kind: INTERIOR_KIND,
        routeRevision: 0,
        createdAt: now,
        updatedAt: now,
      });
    } else if (
      !deployment.stableRouteId ||
      !STABLE_ROUTE_ID.test(deployment.stableRouteId)
    ) {
      await ctx.db.patch(deployment._id, {
        stableRouteId: await allocateStableRouteId(ctx),
        updatedAt: now,
      });
    }
    await ctx.db.insert("cloud_interior_builds", {
      buildId,
      deployableId,
      ownerId,
      turnId,
      threadId,
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
      ...(baseRevision === undefined ? {} : { baseRevision }),
      artifactPrefix,
      artifactManifestJson,
      manifestSha256,
      artifactDigest,
      artifactSizeBytes,
      bridgeAbi,
      minShellVersion,
      createdAt: now,
    });
    return { created: true, buildId, deployableId };
  },
});

export const getInteriorRouteByStableRouteIdInternal = internalQuery({
  args: { stableRouteId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      mode: v.literal("default"),
    }),
    v.object({
      mode: v.literal("custom"),
      ownerHash: v.string(),
      buildId: v.string(),
      artifactPrefix: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    if (!STABLE_ROUTE_ID.test(args.stableRouteId)) return null;
    const deployment = await ctx.db
      .query("cloud_interior_deployables")
      .withIndex("by_stableRouteId", (q) =>
        q.eq("stableRouteId", args.stableRouteId),
      )
      .unique();
    if (!deployment) return null;
    if (!deployment.activeBuildId) return { mode: "default" as const };
    const build = await ctx.db
      .query("cloud_interior_builds")
      .withIndex("by_buildId", (q) =>
        q.eq("buildId", deployment.activeBuildId as string),
      )
      .unique();
    if (
      !build ||
      build.ownerId !== deployment.ownerId ||
      build.deployableId !== deployment.deployableId
    ) {
      return null;
    }
    const ownerHash = (await sha256Utf8(deployment.ownerId)).slice(
      "sha256:".length,
    );
    if (build.artifactPrefix !== `interiors/${ownerHash}/${build.buildId}`) {
      return null;
    }
    return {
      mode: "custom" as const,
      ownerHash,
      buildId: build.buildId,
      artifactPrefix: build.artifactPrefix,
    };
  },
});

export const promoteMyInteriorBuild = mutation({
  args: {
    buildId: v.string(),
    expectedRouteRevision: v.number(),
  },
  returns: deploymentResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const expectedRouteRevision = validateNaturalNumber(
      args.expectedRouteRevision,
      "expectedRouteRevision",
    );
    const deployment = await getOwnerDeployment(ctx, ownerId);
    if (!deployment) {
      throw new ConvexError("No Stella interior candidates are available.");
    }
    if (deployment.routeRevision !== expectedRouteRevision) {
      throw new ConvexError({
        code: "ROUTE_REVISION_CONFLICT",
        currentRouteRevision: deployment.routeRevision,
      });
    }
    const build = await ctx.db
      .query("cloud_interior_builds")
      .withIndex("by_buildId", (q) => q.eq("buildId", args.buildId))
      .unique();
    if (
      !build ||
      build.ownerId !== ownerId ||
      build.deployableId !== deployment.deployableId
    ) {
      throw new ConvexError("Stella interior build not found.");
    }
    if (deployment.activeBuildId === build.buildId) {
      return {
        deployableId: deployment.deployableId,
        activeBuildId: deployment.activeBuildId,
        previousBuildId: deployment.previousBuildId ?? null,
        routeRevision: deployment.routeRevision,
      };
    }
    const routeRevision = deployment.routeRevision + 1;
    await ctx.db.patch(deployment._id, {
      activeBuildId: build.buildId,
      previousBuildId: deployment.activeBuildId,
      routeRevision,
      updatedAt: Date.now(),
    });
    return {
      deployableId: deployment.deployableId,
      activeBuildId: build.buildId,
      previousBuildId: deployment.activeBuildId ?? null,
      routeRevision,
    };
  },
});

export const rollbackMyInteriorBuild = mutation({
  args: { expectedRouteRevision: v.number() },
  returns: deploymentResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const expectedRouteRevision = validateNaturalNumber(
      args.expectedRouteRevision,
      "expectedRouteRevision",
    );
    const deployment = await getOwnerDeployment(ctx, ownerId);
    if (!deployment) {
      throw new ConvexError("No Stella interior deployment exists.");
    }
    if (deployment.routeRevision !== expectedRouteRevision) {
      throw new ConvexError({
        code: "ROUTE_REVISION_CONFLICT",
        currentRouteRevision: deployment.routeRevision,
      });
    }
    if (!deployment.activeBuildId) {
      throw new ConvexError("No active Stella interior build is available.");
    }
    if (!deployment.previousBuildId) {
      // First-build recovery: clear the bad global pointer and retain that
      // candidate as previous history. The packaged renderer then falls back
      // to its bundled last-known-good build, while a later promotion can
      // still inspect or retry this immutable candidate.
      const routeRevision = deployment.routeRevision + 1;
      await ctx.db.patch(deployment._id, {
        activeBuildId: undefined,
        previousBuildId: deployment.activeBuildId,
        routeRevision,
        updatedAt: Date.now(),
      });
      return {
        deployableId: deployment.deployableId,
        activeBuildId: null,
        previousBuildId: deployment.activeBuildId,
        routeRevision,
      };
    }
    const previous = await ctx.db
      .query("cloud_interior_builds")
      .withIndex("by_buildId", (q) =>
        q.eq("buildId", deployment.previousBuildId as string),
      )
      .unique();
    if (
      !previous ||
      previous.ownerId !== ownerId ||
      previous.deployableId !== deployment.deployableId
    ) {
      throw new ConvexError(
        "The previous Stella interior build is unavailable.",
      );
    }
    const routeRevision = deployment.routeRevision + 1;
    const previousBuildId = deployment.activeBuildId;
    await ctx.db.patch(deployment._id, {
      activeBuildId: previous.buildId,
      previousBuildId,
      routeRevision,
      updatedAt: Date.now(),
    });
    return {
      deployableId: deployment.deployableId,
      activeBuildId: previous.buildId,
      previousBuildId,
      routeRevision,
    };
  },
});
