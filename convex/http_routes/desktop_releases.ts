import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { constantTimeEqual } from "../lib/crypto_utils";

const DESKTOP_RELEASE_PUBLISH_PATH = "/api/desktop-releases/publish";

/**
 * Shared CI secret. Set in Convex deployment env via
 * `bunx convex env set DESKTOP_RELEASE_PUBLISH_SECRET <random>`. The CI
 * workflow passes the same value as `Authorization: Bearer <secret>`
 * after uploading the clone-install manifest to R2.
 */
const getPublishSecret = () =>
  process.env.DESKTOP_RELEASE_PUBLISH_SECRET?.trim() ?? "";

type PublishRequestBody = {
  schemaVersion?: number;
  tag?: string;
  commit?: string;
  publishedAt?: number | string;
  platforms?: Record<
    string,
    {
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

export const normalizeArtifactRefs = (
  value: NonNullable<PublishRequestBody["platforms"]>[string]["artifactRefs"],
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
        body.schemaVersion !== 2 ||
        typeof body.tag !== "string" ||
        typeof body.commit !== "string"
      ) {
        return errorResponse(
          400,
          "Expected a schema v2 release manifest with tag and commit.",
        );
      }
      const publishedAt = normalizePublishedAt(body.publishedAt) ?? Date.now();
      const platformEntries = body.platforms ?? {};
      const platforms = Object.keys(platformEntries);
      if (platforms.length === 0) {
        return errorResponse(400, "Missing platforms map.");
      }
      const written: string[] = [];
      for (const platform of platforms) {
        const platformRelease = platformEntries[platform];
        if (!platformRelease) {
          return errorResponse(400, `Missing release entry for ${platform}.`);
        }
        const artifactRefs = normalizeArtifactRefs(
          platformRelease.artifactRefs,
        );
        if (
          !artifactRefs ||
          artifactRefs.some((ref) => ref.platform !== platform) ||
          !artifactRefs.some((ref) => ref.kind === "native-helpers") ||
          !artifactRefs.some((ref) => ref.kind === "stella-browser")
        ) {
          return errorResponse(
            400,
            `Platform entry for ${platform} must pin native-helpers and stella-browser.`,
          );
        }
        await ctx.runMutation(
          internal.data.desktop_releases.publishDesktopRelease,
          {
            platform,
            tag: body.tag,
            commit: body.commit,
            artifactRefs,
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
