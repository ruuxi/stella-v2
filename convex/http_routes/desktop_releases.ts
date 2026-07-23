import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { constantTimeEqual } from "../lib/crypto_utils";

const DESKTOP_RELEASE_PUBLISH_PATH = "/api/desktop-releases/publish";

/**
 * Shared CI secret. Set in Convex deployment env via
 * `bunx convex env set DESKTOP_RELEASE_PUBLISH_SECRET <random>`. The CI
 * workflow passes the same value as `Authorization: Bearer <secret>`
 * after uploading the desktop tarball + R2 manifest.
 */
const getPublishSecret = () =>
  process.env.DESKTOP_RELEASE_PUBLISH_SECRET?.trim() ?? "";

type PublishRequestBody = {
  tag?: string;
  commit?: string;
  publishedAt?: number | string;
  sourcePack?: {
    url?: string;
    sha256?: string;
    size?: number;
  };
  sourceHistory?: {
    url?: string;
    sha256?: string;
    size?: number;
  };
  assets?: Record<
    string,
    {
      url?: string;
      sha256?: string;
      size?: number;
      artifactRefs?: Array<{
        kind?: string;
        platform?: string;
        manifestUrl?: string;
        manifestSha?: string;
        commit?: string;
        builtAt?: string;
        sourceRevisionId?: string;
        asset?: {
          url?: string;
          sha256?: string;
          sizeBytes?: number;
        };
      }>;
    }
  >;
};

const parseRequestJson = async (
  request: Request,
): Promise<PublishRequestBody | null> => {
  try {
    return (await request.json()) as PublishRequestBody;
  } catch {
    return null;
  }
};

const errorResponse = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const normalizePublishedAt = (
  value: PublishRequestBody["publishedAt"],
): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
};

const normalizeSourcePack = (
  value: PublishRequestBody["sourcePack"],
): { url: string; sha256: string; size: number } | null => {
  if (!value) return null;
  if (
    typeof value.url !== "string" ||
    typeof value.sha256 !== "string" ||
    typeof value.size !== "number"
  ) {
    return null;
  }
  const url = value.url.trim();
  const sha256 = value.sha256.trim().toLowerCase();
  if (!/^https:\/\//i.test(url)) return null;
  if (!/^sha256:[0-9a-f]{64}$/.test(sha256)) return null;
  if (!Number.isFinite(value.size) || value.size <= 0) return null;
  return { url, sha256, size: value.size };
};

export const normalizeArtifactRefs = (
  value: NonNullable<PublishRequestBody["assets"]>[string]["artifactRefs"],
) => {
  if (!value) return null;
  if (!Array.isArray(value) || value.length > 8) return null;
  const refs = [];
  for (const ref of value) {
    const asset = ref?.asset;
    if (
      (ref?.kind !== "native-helpers" && ref?.kind !== "stella-browser") ||
      typeof ref.platform !== "string" ||
      !asset ||
      typeof asset.url !== "string" ||
      typeof asset.sha256 !== "string" ||
      typeof asset.sizeBytes !== "number"
    ) {
      return null;
    }
    const assetUrl = asset.url.trim();
    const assetSha256 = asset.sha256.trim().toLowerCase();
    if (!/^https:\/\//i.test(assetUrl)) return null;
    if (!/^sha256:[0-9a-f]{64}$/.test(assetSha256)) return null;
    if (!Number.isInteger(asset.sizeBytes) || asset.sizeBytes <= 0) {
      return null;
    }
    const normalizedAsset = {
      url: assetUrl,
      sha256: assetSha256,
      sizeBytes: asset.sizeBytes,
    };
    if (ref.kind === "stella-browser") {
      refs.push({
        kind: "stella-browser" as const,
        platform: ref.platform.trim(),
        asset: normalizedAsset,
      });
      continue;
    }
    if (typeof ref.manifestUrl !== "string") return null;
    const manifestUrl = ref.manifestUrl.trim();
    if (!/^https:\/\//i.test(manifestUrl)) return null;
    refs.push({
      kind: "native-helpers" as const,
      platform: ref.platform.trim(),
      manifestUrl,
      ...(typeof ref.manifestSha === "string" && ref.manifestSha.trim()
        ? { manifestSha: ref.manifestSha.trim() }
        : {}),
      ...(typeof ref.commit === "string" && ref.commit.trim()
        ? { commit: ref.commit.trim() }
        : {}),
      ...(typeof ref.builtAt === "string" && ref.builtAt.trim()
        ? { builtAt: ref.builtAt.trim() }
        : {}),
      ...(typeof ref.sourceRevisionId === "string" &&
      ref.sourceRevisionId.trim()
        ? { sourceRevisionId: ref.sourceRevisionId.trim() }
        : {}),
      asset: normalizedAsset,
    });
  }
  return refs;
};

export const registerDesktopReleaseRoutes = (http: HttpRouter) => {
  http.route({
    path: DESKTOP_RELEASE_PUBLISH_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const expected = getPublishSecret();
      if (!expected) {
        return errorResponse(503, "Desktop release publish endpoint disabled.");
      }
      const auth = request.headers.get("authorization") ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!provided || !constantTimeEqual(provided, expected)) {
        return errorResponse(401, "Invalid publish credentials.");
      }
      const body = await parseRequestJson(request);
      if (
        !body ||
        typeof body.tag !== "string" ||
        typeof body.commit !== "string"
      ) {
        return errorResponse(400, "Missing tag/commit in request body.");
      }
      const publishedAt = normalizePublishedAt(body.publishedAt) ?? Date.now();
      const sourcePack = normalizeSourcePack(body.sourcePack);
      if (body.sourcePack && !sourcePack) {
        return errorResponse(
          400,
          "sourcePack must include https url, sha256, and size.",
        );
      }
      const sourceHistory = normalizeSourcePack(body.sourceHistory);
      if (body.sourceHistory && !sourceHistory) {
        return errorResponse(
          400,
          "sourceHistory must include https url, sha256, and size.",
        );
      }
      const assets = body.assets ?? {};
      const platforms = Object.keys(assets);
      if (platforms.length === 0) {
        return errorResponse(400, "Missing assets map.");
      }
      const written: string[] = [];
      for (const platform of platforms) {
        const asset = assets[platform];
        if (
          !asset ||
          typeof asset.url !== "string" ||
          typeof asset.sha256 !== "string" ||
          typeof asset.size !== "number"
        ) {
          return errorResponse(
            400,
            `Asset entry for ${platform} is missing url/sha256/size.`,
          );
        }
        const artifactRefs = normalizeArtifactRefs(asset.artifactRefs);
        if (asset.artifactRefs && !artifactRefs) {
          return errorResponse(
            400,
            `Asset entry for ${platform} has invalid artifactRefs.`,
          );
        }
        await ctx.runMutation(
          internal.data.desktop_releases.publishDesktopRelease,
          {
            platform,
            tag: body.tag,
            commit: body.commit,
            archiveUrl: asset.url,
            archiveSha256: asset.sha256,
            archiveSize: asset.size,
            ...(sourcePack
              ? {
                  sourcePackUrl: sourcePack.url,
                  sourcePackSha256: sourcePack.sha256,
                  sourcePackSize: sourcePack.size,
                }
              : {}),
            ...(sourceHistory
              ? {
                  sourceHistoryUrl: sourceHistory.url,
                  sourceHistorySha256: sourceHistory.sha256,
                  sourceHistorySize: sourceHistory.size,
                }
              : {}),
            ...(artifactRefs && artifactRefs.length > 0
              ? { artifactRefs }
              : {}),
            publishedAt,
          },
        );
        written.push(platform);
      }
      return new Response(
        JSON.stringify({ tag: body.tag, commit: body.commit, written }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }),
  });
};
