/**
 * Canonical cloud prompt loading and assembly.
 *
 * Convex publishes the same versioned prompt set used by desktop Stella. A
 * Durable Object may recover from a transient refresh failure with a cached
 * last-known-good snapshot, but only after re-verifying its schema, per-prompt
 * digests and aggregate revision. A cold miss or corrupt/stale cache blocks the
 * turn before model construction; there is deliberately no hand-written prompt
 * fallback that could silently change policy.
 */

import {
  STELLA_PROMPT_IDS,
  STELLA_PROMPT_MAX_CONTENT_BYTES,
  STELLA_PROMPT_MAX_MANIFEST_BYTES,
  STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES,
  STELLA_PROMPT_SCHEMA_VERSION,
} from "@stella/contracts/stella-prompts";

import { buildStartupDocBlock } from "./agent-home.js";
import { sha256Hex } from "./hash.js";

export const CANONICAL_ORCHESTRATOR_PROMPT_ID = "agents/orchestrator.md";
export const CANONICAL_PERSONALITY_PROMPT_ID = "prompts/personality.md";

const PROMPT_REFRESH_INTERVAL_MS = 5 * 60_000;
const PROMPT_LKG_MAX_AGE_MS = 24 * 60 * 60_000;
const PROMPT_FETCH_TIMEOUT_MS = 10_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const EXPECTED_PROMPT_IDS = STELLA_PROMPT_IDS;

const transportEtagMatchesCanonical = (
  observed: string | null,
  canonical: string,
): boolean => {
  if (observed === canonical) return true;
  if (!canonical.startsWith('"') || !canonical.endsWith('"')) return false;
  const value = canonical.slice(1, -1);
  // Convex's HTTP edge may transparently gzip a 200 response and rewrite the
  // strong application ETag to the exact encoded representation below. The
  // manifest body still re-derives and verifies every digest; cache identity
  // must retain the canonical application ETag used by If-None-Match.
  return observed === `"${value}-gzip"` || observed === `W/"${value}-gzip"`;
};

type PromptDigest = { id: string; sha256: string };

export type CanonicalPromptSnapshot = {
  cacheVersion: 1;
  endpoint: string;
  schemaVersion: typeof STELLA_PROMPT_SCHEMA_VERSION;
  revision: string;
  publishedAt: number;
  etag: string;
  fetchedAt: number;
  promptDigests: PromptDigest[];
  orchestratorBody: string;
  orchestratorSha256: string;
  personalityBody: string;
  personalitySha256: string;
};

export type CanonicalPromptLoadResult = {
  snapshot: CanonicalPromptSnapshot;
  disposition:
    | "fresh"
    | "cache_fresh"
    | "cache_not_modified"
    | "cache_recovery";
  refreshErrorCode?: string;
};

export class CanonicalPromptUnavailableError extends Error {
  readonly code = "CLOUD_CONTEXT_UNAVAILABLE";
  readonly component = "canonical_prompt";

  constructor(readonly reason: string) {
    super(
      "Canonical cloud prompts are unavailable or failed integrity checks.",
    );
    this.name = "CanonicalPromptUnavailableError";
  }
}

export const CLOUD_PROMPT_SNAPSHOT_STORAGE_KEY = "canonicalPromptSnapshot";

/** Cloud-only overrides follow the canonical desktop body and win conflicts. */
export const CLOUD_SESSION_OVERLAY = `# Cloud session

Everything above describes Stella on the user's desktop. THIS session runs \
in Stella's cloud instead — always available, no device of theirs needs to \
be awake. Where this section conflicts with anything above, this section \
wins.

- Your tools here are exactly: code, spawn_agent, send_input, pause_agent, web, \
Recall, Remember, Schedule, skill_search, skill_read, tool_search, mcp_describe, \
and mcp_call. Skills may provide \
instructions and assets but never add a tool or widen this list. The desktop-only tools mentioned above — html \
canvases, image_gen, view_image, map, Read, spawn_manager, and mutating \
connectors — are NOT available in this session; never call them, promise \
their output, or refer the user to a canvas. Present dense information as \
well-structured text instead.
- tool_search discovers only actions from the owner's connected services that \
carry both explicit provider safety metadata and a versioned Stella-admin review. Use mcp_describe for the \
exact schema and mcp_call with the exact name and revision. Unknown, mutating, \
destructive, stale, or disconnected actions fail closed and cannot run through \
code. If a write is needed, explain that cloud approval for connected-service \
writes is not available yet; never disguise it as a read.
- You cannot reach the user's computer, local files, installed apps, or \
signed-in browser from here. spawn_agent always runs in the user's Stella \
cloud, on the one world every agent of theirs shares: \`drive/\` for the \
user's files, \`projects/<name>/\` for connected repositories, \`apps/<name>/\` \
for apps built in Stella, and \`stella/\` for Stella's own renderer source. \
Their local machine is not reachable from cloud chat, so say so honestly and \
point them at the desktop app for machine work.
- Nothing the cloud builds goes live on its own. An app build produces a \
candidate the user applies, so describe a finished build as ready to apply \
rather than as already running. Changes to Stella itself only become a \
candidate when the agent calls publish_stella_interior, and the user then \
selects that candidate in Settings.
- Local file paths and \`stella://file/\` links do not exist here. Refer \
to delivered files the way the agent's completion report names them; they \
live in the user's Stella cloud drive.
- Every user message carries the current UTC time in a <current-time> \
tag. Use it for anything time-shaped instead of guessing, and name the \
timezone whenever you state a time, since you only know the user's \
timezone if they tell you.`;

const CLOUD_MEMORY_DISABLED_OVERLAY = `# Cloud memory preference

The owner has disabled cloud memory. Do not infer or claim durable recall. \
Recall and Remember are unavailable and no resident memory documents are \
loaded. Existing stored bytes are preserved until the owner re-enables memory.`;

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CanonicalPromptUnavailableError("invalid_payload");
  }
  return value as Record<string, unknown>;
};

const exactSafeInteger = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CanonicalPromptUnavailableError("invalid_payload");
  }
  return value as number;
};

const exactDigest = (value: unknown): string => {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new CanonicalPromptUnavailableError("invalid_digest");
  }
  return value;
};

const derivedRevision = async (digests: readonly PromptDigest[]) =>
  await sha256Hex(
    [...digests]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((prompt) => `${prompt.id}:${prompt.sha256}`)
      .join("\n"),
  );

const validateSnapshot = async (
  value: unknown,
  endpoint: string,
): Promise<CanonicalPromptSnapshot> => {
  const row = asRecord(value);
  if (row.cacheVersion !== 1 || row.endpoint !== endpoint) {
    throw new CanonicalPromptUnavailableError("stale_cache_identity");
  }
  if (row.schemaVersion !== STELLA_PROMPT_SCHEMA_VERSION) {
    throw new CanonicalPromptUnavailableError("stale_schema");
  }
  const revision = exactDigest(row.revision);
  const publishedAt = exactSafeInteger(row.publishedAt);
  const fetchedAt = exactSafeInteger(row.fetchedAt);
  if (
    typeof row.etag !== "string" ||
    row.etag !== `"${publishedAt}-${revision}"`
  ) {
    throw new CanonicalPromptUnavailableError("stale_etag");
  }
  if (!Array.isArray(row.promptDigests)) {
    throw new CanonicalPromptUnavailableError("invalid_digest_catalog");
  }
  const expectedIds = new Set<string>(EXPECTED_PROMPT_IDS);
  const promptDigests = row.promptDigests.map((value) => {
    const digest = asRecord(value);
    if (typeof digest.id !== "string" || !expectedIds.delete(digest.id)) {
      throw new CanonicalPromptUnavailableError("invalid_digest_catalog");
    }
    return { id: digest.id, sha256: exactDigest(digest.sha256) };
  });
  if (
    expectedIds.size !== 0 ||
    promptDigests.length !== EXPECTED_PROMPT_IDS.length
  ) {
    throw new CanonicalPromptUnavailableError("invalid_digest_catalog");
  }
  if ((await derivedRevision(promptDigests)) !== revision) {
    throw new CanonicalPromptUnavailableError("revision_mismatch");
  }
  if (
    typeof row.orchestratorBody !== "string" ||
    !row.orchestratorBody.trim() ||
    typeof row.personalityBody !== "string" ||
    !row.personalityBody.trim()
  ) {
    throw new CanonicalPromptUnavailableError("missing_required_prompt");
  }
  const orchestratorSha256 = exactDigest(row.orchestratorSha256);
  const personalitySha256 = exactDigest(row.personalitySha256);
  if (
    (await sha256Hex(row.orchestratorBody)) !== orchestratorSha256 ||
    (await sha256Hex(row.personalityBody)) !== personalitySha256 ||
    promptDigests.find((entry) => entry.id === CANONICAL_ORCHESTRATOR_PROMPT_ID)
      ?.sha256 !== orchestratorSha256 ||
    promptDigests.find((entry) => entry.id === CANONICAL_PERSONALITY_PROMPT_ID)
      ?.sha256 !== personalitySha256
  ) {
    throw new CanonicalPromptUnavailableError("cached_body_digest_mismatch");
  }
  return {
    cacheVersion: 1,
    endpoint,
    schemaVersion: STELLA_PROMPT_SCHEMA_VERSION,
    revision,
    publishedAt,
    etag: row.etag,
    fetchedAt,
    promptDigests,
    orchestratorBody: row.orchestratorBody,
    orchestratorSha256,
    personalityBody: row.personalityBody,
    personalitySha256,
  };
};

const parsePublication = async (
  response: Response,
  now: number,
  cached: CanonicalPromptSnapshot | null,
  endpoint: string,
): Promise<CanonicalPromptSnapshot> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > STELLA_PROMPT_MAX_MANIFEST_BYTES
  ) {
    throw new CanonicalPromptUnavailableError("response_too_large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > STELLA_PROMPT_MAX_MANIFEST_BYTES) {
    throw new CanonicalPromptUnavailableError("response_too_large");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CanonicalPromptUnavailableError("invalid_json");
  }
  const row = asRecord(payload);
  if (row.schemaVersion !== STELLA_PROMPT_SCHEMA_VERSION) {
    throw new CanonicalPromptUnavailableError("stale_schema");
  }
  const revision = exactDigest(row.revision);
  const publishedAt = exactSafeInteger(row.publishedAt);
  const etag = `"${publishedAt}-${revision}"`;
  if (!transportEtagMatchesCanonical(response.headers.get("etag"), etag)) {
    throw new CanonicalPromptUnavailableError("stale_etag");
  }
  if (
    cached &&
    (publishedAt < cached.publishedAt ||
      (publishedAt === cached.publishedAt && revision !== cached.revision))
  ) {
    throw new CanonicalPromptUnavailableError("publication_rollback");
  }
  if (
    !Array.isArray(row.prompts) ||
    row.prompts.length !== EXPECTED_PROMPT_IDS.length
  ) {
    throw new CanonicalPromptUnavailableError("invalid_prompt_catalog");
  }
  const expectedIds = new Set<string>(EXPECTED_PROMPT_IDS);
  const promptDigests: PromptDigest[] = [];
  let totalBytes = 0;
  let orchestratorBody: string | undefined;
  let orchestratorSha256: string | undefined;
  let personalityBody: string | undefined;
  let personalitySha256: string | undefined;
  for (const value of row.prompts) {
    const prompt = asRecord(value);
    if (typeof prompt.id !== "string" || !expectedIds.delete(prompt.id)) {
      throw new CanonicalPromptUnavailableError("invalid_prompt_catalog");
    }
    if (typeof prompt.content !== "string" || !prompt.content.trim()) {
      throw new CanonicalPromptUnavailableError("missing_required_prompt");
    }
    const contentBytes = new TextEncoder().encode(prompt.content).byteLength;
    totalBytes += contentBytes;
    if (
      contentBytes > STELLA_PROMPT_MAX_CONTENT_BYTES ||
      totalBytes > STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES
    ) {
      throw new CanonicalPromptUnavailableError("prompt_content_too_large");
    }
    const digest = exactDigest(prompt.sha256);
    if ((await sha256Hex(prompt.content)) !== digest) {
      throw new CanonicalPromptUnavailableError("prompt_digest_mismatch");
    }
    promptDigests.push({ id: prompt.id, sha256: digest });
    if (prompt.id === CANONICAL_ORCHESTRATOR_PROMPT_ID) {
      orchestratorBody = prompt.content;
      orchestratorSha256 = digest;
    } else if (prompt.id === CANONICAL_PERSONALITY_PROMPT_ID) {
      personalityBody = prompt.content;
      personalitySha256 = digest;
    }
  }
  if (
    expectedIds.size !== 0 ||
    !orchestratorBody ||
    !orchestratorSha256 ||
    !personalityBody ||
    !personalitySha256 ||
    (await derivedRevision(promptDigests)) !== revision
  ) {
    throw new CanonicalPromptUnavailableError("revision_mismatch");
  }
  return {
    cacheVersion: 1,
    endpoint,
    schemaVersion: STELLA_PROMPT_SCHEMA_VERSION,
    revision,
    publishedAt,
    etag,
    fetchedAt: now,
    promptDigests,
    orchestratorBody,
    orchestratorSha256,
    personalityBody,
    personalitySha256,
  };
};

/** Load a fresh or integrity-validated cached canonical publication. */
export const refreshCanonicalPrompts = async (
  convexSiteBase: string,
  cachedValue: unknown,
  now: number,
  signal?: AbortSignal,
): Promise<CanonicalPromptLoadResult> => {
  signal?.throwIfAborted();
  const endpoint = convexSiteBase.replace(/\/+$/u, "");
  const validatedCache = await validateSnapshot(cachedValue, endpoint).catch(
    () => null,
  );
  signal?.throwIfAborted();
  const cached =
    validatedCache && validatedCache.fetchedAt <= now ? validatedCache : null;
  const cacheInsideHardAge =
    cached !== null && now - cached.fetchedAt <= PROMPT_LKG_MAX_AGE_MS;
  if (cached && now - cached.fetchedAt < PROMPT_REFRESH_INTERVAL_MS) {
    return { snapshot: cached, disposition: "cache_fresh" };
  }
  try {
    signal?.throwIfAborted();
    const response = await fetch(`${endpoint}/api/stella/prompts`, {
      headers: {
        accept: "application/json",
        ...(cached ? { "if-none-match": cached.etag } : {}),
      },
      signal: signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(PROMPT_FETCH_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(PROMPT_FETCH_TIMEOUT_MS),
    });
    signal?.throwIfAborted();
    if (response.status === 304 && cached) {
      const responseEtag = response.headers.get("etag");
      if (
        responseEtag &&
        !transportEtagMatchesCanonical(responseEtag, cached.etag)
      ) {
        throw new CanonicalPromptUnavailableError("stale_etag");
      }
      return {
        snapshot: { ...cached, fetchedAt: now },
        disposition: "cache_not_modified",
      };
    }
    if (!response.ok) {
      throw new CanonicalPromptUnavailableError(`http_${response.status}`);
    }
    const snapshot = await parsePublication(response, now, cached, endpoint);
    signal?.throwIfAborted();
    return {
      snapshot,
      disposition: "fresh",
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (cached && cacheInsideHardAge) {
      return {
        snapshot: cached,
        disposition: "cache_recovery",
        refreshErrorCode:
          error instanceof CanonicalPromptUnavailableError
            ? error.reason
            : "fetch_failed",
      };
    }
    if (error instanceof CanonicalPromptUnavailableError) throw error;
    throw new CanonicalPromptUnavailableError("fetch_failed");
  }
};

export const buildCloudSystemPrompt = (args: {
  canonicalBody: string;
  personalityBody: string | null;
  localeDirective: string | undefined;
  residentSection: string;
  skillSection?: string;
  memoryEnabled?: boolean;
}): string => {
  const memoryEnabled = args.memoryEnabled !== false;
  const cloudOverlay = memoryEnabled
    ? CLOUD_SESSION_OVERLAY
    : CLOUD_SESSION_OVERLAY.replace(
        "web, Recall, Remember, Schedule",
        "web, Schedule",
      );
  return [
    args.canonicalBody,
    cloudOverlay,
    memoryEnabled ? "" : CLOUD_MEMORY_DISABLED_OVERLAY,
    args.localeDirective ?? "",
    args.personalityBody
      ? buildStartupDocBlock("~/.stella/PERSONALITY.md", args.personalityBody)
      : "",
    args.residentSection,
    args.skillSection ?? "",
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
};
