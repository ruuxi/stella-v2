/**
 * Remote prompt manifest fetch + validation + cache.
 *
 * This module only answers "what is the newest trustworthy published
 * snapshot?" — applying it to disk is `system-mirror.ts`'s mirror swap, and
 * the currently-applied publication is whatever `system/revision.json` says.
 *
 * Guarantees:
 * - Strict validation: every prompt's sha256 must match its content and the
 *   recomputed revision must match the declared one.
 * - Forward tolerance: ids this app version doesn't recognize are accepted
 *   (they're skipped at mirror time), so a newer or older backend can never
 *   invalidate the whole manifest.
 * - Rollback protection: a manifest older than the applied system revision or
 *   the on-disk cache is refused.
 * - Offline: falls back to the on-disk cache, else reports `unavailable`.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  STELLA_PROMPT_COUNT,
  STELLA_PROMPT_LEGACY_COUNT,
  STELLA_PROMPT_LEGACY_IDS,
  STELLA_PROMPT_MAX_CONTENT_BYTES,
  STELLA_PROMPT_MAX_MANIFEST_BYTES,
  STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES,
  STELLA_PROMPT_REVISION_PATTERN,
  STELLA_PROMPT_SCHEMA_VERSION,
} from "@stella/contracts/stella-prompts";
import { stellaPromptEndpointFromSiteUrl } from "@stella/contracts/stella-api";
import { ensurePrivateDir } from "../shared/private-fs.js";
import { readSystemRevision } from "./system-mirror.js";

const PROMPT_CACHE_FILE = "prompt-manifest.json";
const FETCH_TIMEOUT_MS = 3_000;
// Generous ceiling for manifests from newer backends carrying ids this app
// doesn't know; total content bytes stay bounded separately.
const MAX_MANIFEST_PROMPTS = STELLA_PROMPT_COUNT + 48;

export type RemotePrompt = { id: string; sha256: string; content: string };
export type RemotePromptManifest = {
  schemaVersion: typeof STELLA_PROMPT_SCHEMA_VERSION;
  revision: string;
  publishedAt: number;
  prompts: RemotePrompt[];
};

type CachedPromptManifest = {
  endpoint: string;
  etag?: string;
  manifest: RemotePromptManifest;
};

export type PromptManifestResolution = {
  source: "fresh-remote" | "cached-remote" | "unavailable";
  manifest: RemotePromptManifest | null;
  endpoint?: string;
};

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const utf8Bytes = (content: string): number =>
  Buffer.byteLength(content, "utf-8");

const revisionForPrompts = (prompts: readonly RemotePrompt[]): string =>
  sha256(
    [...prompts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((prompt) => `${prompt.id}:${prompt.sha256}`)
      .join("\n"),
  );

const publicationEtag = (
  manifest: Pick<RemotePromptManifest, "publishedAt" | "revision">,
): string => `"${manifest.publishedAt}-${manifest.revision}"`;

const PROMPT_ID_PATTERN = /^(agents|prompts)\/[a-z0-9_-]+\.md$/;

export const parseRemotePromptManifest = (
  value: unknown,
): RemotePromptManifest | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RemotePromptManifest>;
  if (
    candidate.schemaVersion !== STELLA_PROMPT_SCHEMA_VERSION ||
    typeof candidate.revision !== "string" ||
    !STELLA_PROMPT_REVISION_PATTERN.test(candidate.revision) ||
    typeof candidate.publishedAt !== "number" ||
    !Number.isSafeInteger(candidate.publishedAt) ||
    candidate.publishedAt < 0 ||
    !Array.isArray(candidate.prompts) ||
    candidate.prompts.length < STELLA_PROMPT_LEGACY_COUNT ||
    candidate.prompts.length > MAX_MANIFEST_PROMPTS
  ) {
    return null;
  }
  const ids = new Set<string>();
  let totalContentBytes = 0;
  for (const prompt of candidate.prompts) {
    if (
      !prompt ||
      typeof prompt.id !== "string" ||
      !PROMPT_ID_PATTERN.test(prompt.id) ||
      ids.has(prompt.id) ||
      typeof prompt.content !== "string" ||
      prompt.content.length === 0 ||
      typeof prompt.sha256 !== "string" ||
      !STELLA_PROMPT_REVISION_PATTERN.test(prompt.sha256) ||
      sha256(prompt.content) !== prompt.sha256
    ) {
      return null;
    }
    const contentBytes = utf8Bytes(prompt.content);
    if (contentBytes > STELLA_PROMPT_MAX_CONTENT_BYTES) return null;
    totalContentBytes += contentBytes;
    if (totalContentBytes > STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES) return null;
    ids.add(prompt.id);
  }
  if (
    ids.size !== candidate.prompts.length ||
    STELLA_PROMPT_LEGACY_IDS.some((id) => !ids.has(id)) ||
    revisionForPrompts(candidate.prompts) !== candidate.revision
  ) {
    return null;
  }
  // The manifest is kept exactly as published — unknown/retired entries
  // included — so `revision` keeps describing the prompt list it was computed
  // over and the cache round-trips. Non-active ids are skipped at mirror time.
  return candidate as RemotePromptManifest;
};

const cachePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "cache", PROMPT_CACHE_FILE);

const readCache = async (
  stellaDataDir: string,
  endpoint: string | undefined,
): Promise<CachedPromptManifest | null> => {
  try {
    const parsed = JSON.parse(
      await fs.readFile(cachePath(stellaDataDir), "utf-8"),
    ) as Partial<CachedPromptManifest>;
    if (typeof parsed.endpoint !== "string") return null;
    if (endpoint && parsed.endpoint !== endpoint) return null;
    const manifest = parseRemotePromptManifest(parsed.manifest);
    if (!manifest) return null;
    return { endpoint: parsed.endpoint, manifest };
  } catch {
    return null;
  }
};

const writeCacheAtomic = async (
  stellaDataDir: string,
  cache: CachedPromptManifest,
): Promise<void> => {
  const filePath = cachePath(stellaDataDir);
  await ensurePrivateDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

const readBoundedJsonResponse = async (
  response: Response,
): Promise<unknown> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > STELLA_PROMPT_MAX_MANIFEST_BYTES
  ) {
    throw new Error("Prompt manifest is too large");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > STELLA_PROMPT_MAX_MANIFEST_BYTES) {
    throw new Error("Prompt manifest is too large");
  }
  return JSON.parse(new TextDecoder().decode(bytes));
};

const isRollback = (
  fresh: Pick<RemotePromptManifest, "publishedAt" | "revision">,
  highWater: Pick<RemotePromptManifest, "publishedAt" | "revision">,
): boolean =>
  fresh.publishedAt < highWater.publishedAt ||
  (fresh.publishedAt === highWater.publishedAt &&
    fresh.revision !== highWater.revision);

export const resolvePromptManifest = async (args: {
  stellaDataDir: string;
  siteUrl?: string | null;
  fetchImpl?: typeof fetch;
  writeCacheImpl?: typeof writeCacheAtomic;
}): Promise<PromptManifestResolution> => {
  const siteUrl = args.siteUrl?.trim();
  const configuredEndpoint = siteUrl
    ? stellaPromptEndpointFromSiteUrl(siteUrl)
    : undefined;
  const cached = await readCache(args.stellaDataDir, configuredEndpoint);
  const endpoint = configuredEndpoint ?? cached?.endpoint;
  if (!endpoint) {
    return { source: "unavailable", manifest: null };
  }
  const applied = await readSystemRevision(args.stellaDataDir);
  // An offline-seeded system dir (revision "offline", publishedAt 0) never
  // blocks a real publication.
  const appliedHighWater =
    applied && STELLA_PROMPT_REVISION_PATTERN.test(applied.revision)
      ? { publishedAt: applied.publishedAt, revision: applied.revision }
      : null;
  const highWater =
    cached &&
    (!appliedHighWater ||
      cached.manifest.publishedAt > appliedHighWater.publishedAt)
      ? cached.manifest
      : appliedHighWater;
  const safeCached =
    cached &&
    (!appliedHighWater || !isRollback(cached.manifest, appliedHighWater))
      ? cached
      : null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (cached) headers["If-None-Match"] = publicationEtag(cached.manifest);
    const response = await (args.fetchImpl ?? fetch)(endpoint, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 304 && safeCached) {
      return {
        source: "fresh-remote",
        manifest: safeCached.manifest,
        endpoint,
      };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = parseRemotePromptManifest(
      await readBoundedJsonResponse(response),
    );
    if (!manifest) throw new Error("Invalid prompt manifest");
    if (highWater && isRollback(manifest, highWater)) {
      return safeCached
        ? { source: "cached-remote", manifest: safeCached.manifest, endpoint }
        : { source: "unavailable", manifest: null, endpoint };
    }

    const nextCache: CachedPromptManifest = {
      endpoint,
      etag: publicationEtag(manifest),
      manifest,
    };
    await (args.writeCacheImpl ?? writeCacheAtomic)(
      args.stellaDataDir,
      nextCache,
    ).catch((error) => {
      console.warn(
        "[stella-home] Could not persist prompt manifest cache:",
        error,
      );
    });
    return { source: "fresh-remote", manifest, endpoint };
  } catch {
    return safeCached
      ? { source: "cached-remote", manifest: safeCached.manifest, endpoint }
      : { source: "unavailable", manifest: null, endpoint };
  } finally {
    clearTimeout(timeout);
  }
};
