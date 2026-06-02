"use node";

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { ConvexError, Infer, v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireSensitiveUserIdAction } from "../auth";
import { r2 } from "../r2_files";
import { enforceActionRateLimit, RATE_STANDARD } from "../lib/rate_limits";
import {
  store_release_diff_ref_validator,
  store_release_git_artifact_validator,
  store_release_git_object_validator,
} from "../schema/store";
import { requireBoundedString } from "../shared_validators";

const PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_OBJECTS_PER_RELEASE = 20_000;
const MAX_GIT_OBJECT_BYTES = 25 * 1024 * 1024;
const MAX_DIFF_UPLOAD_BYTES = 5 * 1024 * 1024;
const URL_EXPIRES_SECONDS = 5 * 60;
const GIT_OBJECT_VERIFY_CONCURRENCY = 16;

type StoreReleaseGitObject = Infer<typeof store_release_git_object_validator>;
type StoreReleaseGitArtifact = Infer<
  typeof store_release_git_artifact_validator
>;
type StoreReleaseDiffRef = Infer<typeof store_release_diff_ref_validator>;

const normalizePackageId = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  requireBoundedString(normalized, "packageId", 64);
  if (!PACKAGE_ID_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Package ID must use lowercase letters, numbers, hyphens, or underscores.",
    });
  }
  return normalized;
};

const safeKeySegment = (value: string): string =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160) || "unknown";

const normalizeGitSha = (value: string, fieldName: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!GIT_SHA_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} must be a 40-character Git SHA.`,
    });
  }
  return normalized;
};

const normalizeSha256 = (value: string, fieldName: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} must be a sha256 digest.`,
    });
  }
  return normalized;
};

const normalizeObjectSize = (value: number, fieldName: string): number => {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_GIT_OBJECT_BYTES) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} must be between 1 byte and ${MAX_GIT_OBJECT_BYTES} bytes.`,
    });
  }
  return value;
};

const normalizeDiffSize = (value: number): number => {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_DIFF_UPLOAD_BYTES) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Diff uploads must be between 1 byte and ${MAX_DIFF_UPLOAD_BYTES} bytes.`,
    });
  }
  return value;
};

// Store Git objects live in a global content-addressed cache. Do not delete
// these from package/release cleanup without reference counting or a sweeper;
// multiple releases can legitimately share the same SHA.
const gitObjectKey = (sha: string): string =>
  `store/git-objects/${sha.slice(0, 2)}/${sha.slice(2)}`;

const diffR2Prefix = (ownerId: string, packageId: string): string =>
  `store/git-diffs/${safeKeySegment(ownerId)}/${packageId}`;

const mapConcurrent = async <T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (index < values.length) {
        const current = index;
        index += 1;
        results[current] = await mapper(values[current]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

const gitObjectMatchesManifest = (args: {
  object: StoreReleaseGitObject;
  compressedBytes: Uint8Array;
}): boolean => {
  if (args.compressedBytes.byteLength !== args.object.sizeBytes) return false;
  let storeBytes: Buffer;
  try {
    storeBytes = inflateSync(args.compressedBytes);
  } catch {
    return false;
  }
  const nulIndex = storeBytes.indexOf(0);
  if (nulIndex <= 0) return false;
  const header = storeBytes.subarray(0, nulIndex).toString("utf8");
  const match = /^(blob|tree|commit) ([0-9]+)$/.exec(header);
  if (!match || match[1] !== args.object.type) return false;
  const expectedSize = Number(match[2]);
  const actualSize = storeBytes.byteLength - nulIndex - 1;
  if (!Number.isInteger(expectedSize) || expectedSize !== actualSize) {
    return false;
  }
  const sha = createHash("sha1").update(storeBytes).digest("hex");
  return sha === args.object.sha;
};

const fetchGitObjectBytes = async (
  object: StoreReleaseGitObject,
): Promise<Uint8Array | null> => {
  const url = await r2.getUrl(gitObjectKey(object.sha), {
    expiresIn: URL_EXPIRES_SECONDS,
  });
  const response = await fetch(url).catch(() => null);
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined);
    return null;
  }
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength !== object.sizeBytes) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength === object.sizeBytes ? bytes : null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > object.sizeBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  if (total !== object.sizeBytes) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const r2GitObjectMatchesManifest = async (
  object: StoreReleaseGitObject,
): Promise<boolean> => {
  const bytes = await fetchGitObjectBytes(object);
  return bytes
    ? gitObjectMatchesManifest({ object, compressedBytes: bytes })
    : false;
};

const validateObjectList = (
  objects: StoreReleaseGitObject[],
): StoreReleaseGitObject[] => {
  if (objects.length === 0) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Git artifacts must include at least one object.",
    });
  }
  if (objects.length > MAX_OBJECTS_PER_RELEASE) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Git artifacts may include at most ${MAX_OBJECTS_PER_RELEASE} objects.`,
    });
  }
  const seen = new Set<string>();
  return objects.map((object, index) => {
    const sha = normalizeGitSha(object.sha, `objects[${index}].sha`);
    if (seen.has(sha)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Duplicate Git object ${sha}.`,
      });
    }
    seen.add(sha);
    return {
      sha,
      type: object.type,
      sizeBytes: normalizeObjectSize(
        object.sizeBytes,
        `objects[${index}].sizeBytes`,
      ),
    };
  });
};

const getReadableGitArtifactRelease = async (
  ctx: any,
  args: {
    packageId: string;
    releaseNumber: number;
  },
) => {
  const identity = await ctx.auth.getUserIdentity();
  return await ctx.runQuery(
    internal.data.store_packages.getReadableReleaseForArtifactInternal,
    {
      packageId: args.packageId,
      releaseNumber: args.releaseNumber,
      ...(identity?.tokenIdentifier
        ? { callerOwnerId: identity.tokenIdentifier }
        : {}),
    },
  );
};

export const prepareGitObjectUploads = action({
  args: {
    objects: v.array(store_release_git_object_validator),
  },
  returns: v.object({
    uploads: v.array(
      v.object({
        sha: v.string(),
        r2Key: v.string(),
        uploadUrl: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "store_git_object_prepare_upload",
      ownerId,
      RATE_STANDARD,
      "Too many Store object uploads. Please wait before publishing again.",
    );
    const objects = validateObjectList(args.objects);
    const uploadCandidates = await mapConcurrent(
      objects,
      GIT_OBJECT_VERIFY_CONCURRENCY,
      async (object) => ({
        object,
        existsWithMatchingBytes: await r2GitObjectMatchesManifest(object),
      }),
    );
    const uploads = [];
    for (const { object, existsWithMatchingBytes } of uploadCandidates) {
      const r2Key = gitObjectKey(object.sha);
      if (existsWithMatchingBytes) {
        continue;
      }
      const upload = await r2.generateUploadUrl(r2Key);
      uploads.push({ sha: object.sha, r2Key, uploadUrl: upload.url });
    }
    return { uploads };
  },
});

export const verifyGitObjectUploads = action({
  args: {
    objects: v.array(store_release_git_object_validator),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "store_git_object_verify_upload",
      ownerId,
      RATE_STANDARD,
      "Too many Store object verifications. Please wait before publishing again.",
    );
    const objects = validateObjectList(args.objects);
    const results = await mapConcurrent(
      objects,
      GIT_OBJECT_VERIFY_CONCURRENCY,
      async (object) => ({
        sha: object.sha,
        matches: await r2GitObjectMatchesManifest(object),
      }),
    );
    const failed = results.find((result) => !result.matches);
    if (failed) {
      throw new ConvexError({
        code: "STORE_GIT_OBJECT_INTEGRITY_FAILED",
        message: `Uploaded Store Git object ${failed.sha} does not match its manifest.`,
      });
    }
    return { ok: true };
  },
});

export const prepareDiffUpload = action({
  args: {
    packageId: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
  },
  returns: v.object({
    ref: store_release_diff_ref_validator,
    uploadUrl: v.string(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "store_git_diff_prepare_upload",
      ownerId,
      RATE_STANDARD,
      "Too many Store diff uploads. Please wait before publishing again.",
    );
    const packageId = normalizePackageId(args.packageId);
    const sha256 = normalizeSha256(args.sha256, "diffRef.sha256");
    const sizeBytes = normalizeDiffSize(args.sizeBytes);
    const shortHash = sha256.slice("sha256:".length, "sha256:".length + 16);
    const r2Key = `${diffR2Prefix(ownerId, packageId)}/${shortHash}.diff`;
    const upload = await r2.generateUploadUrl(r2Key);
    return {
      ref: {
        kind: "r2" as const,
        r2Key,
        sha256,
        sizeBytes,
      },
      uploadUrl: upload.url,
    };
  },
});

const fetchDiffRefText = async (ref: StoreReleaseDiffRef): Promise<string> => {
  const url = await r2.getUrl(ref.r2Key, { expiresIn: URL_EXPIRES_SECONDS });
  const response = await fetch(url);
  if (!response.ok) {
    throw new ConvexError({
      code: "STORE_DIFF_UNAVAILABLE",
      message: `Could not read Store diff from R2 (${response.status}).`,
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== ref.sizeBytes) {
    throw new ConvexError({
      code: "STORE_DIFF_INTEGRITY_FAILED",
      message: "Store diff size does not match its recorded metadata.",
    });
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  if (sha256 !== ref.sha256) {
    throw new ConvexError({
      code: "STORE_DIFF_INTEGRITY_FAILED",
      message: "Store diff hash does not match its recorded metadata.",
    });
  }
  return new TextDecoder().decode(bytes);
};

export const validateDiffRef = internalAction({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
    ref: store_release_diff_ref_validator,
  },
  returns: v.string(),
  handler: async (_ctx, args) => {
    const packageId = normalizePackageId(args.packageId);
    const expectedPrefix = `${diffR2Prefix(args.ownerId, packageId)}/`;
    if (!args.ref.r2Key.startsWith(expectedPrefix)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "diffRef does not belong to this package.",
      });
    }
    normalizeSha256(args.ref.sha256, "diffRef.sha256");
    normalizeDiffSize(args.ref.sizeBytes);
    return await fetchDiffRefText(args.ref);
  },
});

export const deleteDiffRef = internalAction({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
    ref: store_release_diff_ref_validator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const packageId = normalizePackageId(args.packageId);
    const expectedPrefix = `${diffR2Prefix(args.ownerId, packageId)}/`;
    if (!args.ref.r2Key.startsWith(expectedPrefix)) return null;
    await r2.deleteObject(ctx, args.ref.r2Key).catch((error) => {
      console.warn("[store-git-artifacts] failed to delete diff:", error);
    });
    return null;
  },
});

export const getReleaseDiff = action({
  args: {
    packageId: v.string(),
    releaseNumber: v.number(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args): Promise<string | null> => {
    const release = await getReadableGitArtifactRelease(ctx, args);
    if (!release) return null;
    if (typeof release.diff === "string") return release.diff;
    if (!release.diffRef) return null;
    return await fetchDiffRefText(release.diffRef);
  },
});

export const getReleaseGitObjectUrls = action({
  args: {
    packageId: v.string(),
    releaseNumber: v.number(),
    shas: v.array(v.string()),
  },
  returns: v.array(
    v.object({
      sha: v.string(),
      r2Key: v.string(),
      downloadUrl: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const release = await getReadableGitArtifactRelease(ctx, args);
    if (!release?.gitArtifact) return [];
    const allowed = new Set(
      release.gitArtifact.objects.map((object: StoreReleaseGitObject) =>
        object.sha.toLowerCase(),
      ),
    );
    const uniqueShas = Array.from(
      new Set(args.shas.map((sha) => normalizeGitSha(sha, "sha"))),
    );
    for (const sha of uniqueShas) {
      if (!allowed.has(sha)) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: `Git object ${sha} is not part of this Store release.`,
        });
      }
    }
    return await Promise.all(
      uniqueShas.map(async (sha) => {
        const r2Key = gitObjectKey(sha);
        return {
          sha,
          r2Key,
          downloadUrl: await r2.getUrl(r2Key, {
            expiresIn: URL_EXPIRES_SECONDS,
          }),
        };
      }),
    );
  },
});
