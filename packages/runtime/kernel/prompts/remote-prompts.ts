/**
 * Remote system prompts: one source of truth, applied everywhere.
 *
 * Convex publishes the versioned prompt set (`/api/stella/prompts`), generated
 * from the bundled `stella-runtime` sources and kept identical to them by CI.
 * The cloud worker reads that publication per turn; this module gives the
 * desktop runtime the same behavior:
 *
 *   - The served bodies live in memory (and in a small disk cache so a cold
 *     start is not stale until the first fetch completes).
 *   - `revalidateRemotePrompts` runs at startup and at every orchestrator
 *     turn, never on the critical path: a turn uses whatever is loaded and the
 *     conditional GET (`If-None-Match`, `304 Not Modified`) refreshes it for
 *     the next one. A prompt change reaches every client within one message
 *     of the Convex deploy.
 *   - No home files, no user overrides, no merge rules. Offline, BYOK without a
 *     backend, or an invalid publication fall back to the bundled copy the
 *     consumers already read.
 *
 * Consumers: `loadAgentSystemPrompt` (agent bodies) and `readRuntimePrompt`
 * (auxiliary prompts) ask `getRemotePromptBody` first.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  STELLA_PROMPT_COUNT,
  STELLA_PROMPT_IDS,
  STELLA_PROMPT_ID_SET,
  STELLA_PROMPT_MAX_CONTENT_BYTES,
  STELLA_PROMPT_MAX_MANIFEST_BYTES,
  STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES,
  STELLA_PROMPT_REVISION_PATTERN,
  STELLA_PROMPT_SCHEMA_VERSION,
} from "@stella/contracts/stella-prompts";
import { stellaPromptEndpointFromSiteUrl } from "@stella/contracts/stella-api";
import { ensurePrivateDir } from "../shared/private-fs.js";
import { createRuntimeLogger } from "../debug.js";

const logger = createRuntimeLogger("prompts.remote");

export type RemotePrompt = { id: string; sha256: string; content: string };

export type RemotePromptManifest = {
  schemaVersion: typeof STELLA_PROMPT_SCHEMA_VERSION;
  revision: string;
  publishedAt: number;
  prompts: RemotePrompt[];
};

export type RemotePromptRevalidation =
  | "fresh"
  | "not-modified"
  | "unavailable"
  | "unconfigured"
  | "in-flight";

const CACHE_FILE = "prompt-manifest.json";
const FETCH_TIMEOUT_MS = 3_000;
/** Bursty turns (a steer right after a send) share one revalidation. */
const MIN_REVALIDATE_GAP_MS = 2_000;

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

export const publicationEtag = (
  manifest: Pick<RemotePromptManifest, "publishedAt" | "revision">,
): string => `"${manifest.publishedAt}-${manifest.revision}"`;

/**
 * Validate a served publication: schema, exact prompt set, per-prompt
 * digests, size bounds, and the aggregate revision. Anything else is
 * rejected wholesale so a half-published or corrupt set never replaces a
 * good one.
 */
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
    candidate.prompts.length !== STELLA_PROMPT_COUNT
  ) {
    return null;
  }
  const ids = new Set<string>();
  let totalContentBytes = 0;
  for (const prompt of candidate.prompts) {
    if (
      !prompt ||
      typeof prompt.id !== "string" ||
      !STELLA_PROMPT_ID_SET.has(prompt.id) ||
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
    ids.size !== STELLA_PROMPT_COUNT ||
    STELLA_PROMPT_IDS.some((id) => !ids.has(id)) ||
    revisionForPrompts(candidate.prompts) !== candidate.revision
  ) {
    return null;
  }
  return candidate as RemotePromptManifest;
};

type CachedManifest = { endpoint: string; manifest: RemotePromptManifest };

type RemotePromptsState = {
  stellaDataDir: string | null;
  getSiteUrl: () => string | null;
  fetchImpl: typeof fetch;
  endpoint: string | null;
  manifest: RemotePromptManifest | null;
  bodies: Map<string, string>;
  cacheLoaded: Promise<void> | null;
  inFlight: Promise<RemotePromptRevalidation> | null;
  lastAttemptAt: number;
  lastFailure: string | null;
};

const createState = (): RemotePromptsState => ({
  stellaDataDir: null,
  getSiteUrl: () => null,
  fetchImpl: fetch,
  endpoint: null,
  manifest: null,
  bodies: new Map(),
  cacheLoaded: null,
  inFlight: null,
  lastAttemptAt: 0,
  lastFailure: null,
});

let state = createState();

const cachePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "cache", CACHE_FILE);

const adopt = (endpoint: string, manifest: RemotePromptManifest): void => {
  state.endpoint = endpoint;
  state.manifest = manifest;
  state.bodies = new Map(
    manifest.prompts.map((prompt) => [prompt.id, prompt.content.trim()]),
  );
};

const readCache = async (): Promise<void> => {
  if (!state.stellaDataDir) return;
  try {
    const raw = await fs.readFile(cachePath(state.stellaDataDir), "utf-8");
    if (utf8Bytes(raw) > STELLA_PROMPT_MAX_MANIFEST_BYTES) return;
    const parsed = JSON.parse(raw) as Partial<CachedManifest>;
    const manifest = parseRemotePromptManifest(parsed.manifest);
    if (!manifest || typeof parsed.endpoint !== "string") return;
    // A cache from another backend never seeds this one.
    const endpoint = currentEndpoint();
    if (endpoint && endpoint !== parsed.endpoint) return;
    if (!state.manifest) adopt(parsed.endpoint, manifest);
  } catch {
    /* no cache, or unreadable: the bundle carries this launch */
  }
};

const writeCache = async (cache: CachedManifest): Promise<void> => {
  if (!state.stellaDataDir) return;
  const target = cachePath(state.stellaDataDir);
  try {
    await ensurePrivateDir(path.dirname(target));
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(cache)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.rename(temp, target);
  } catch (error) {
    console.warn(
      "[stella:prompts] Could not persist the prompt cache:",
      error instanceof Error ? error.message : String(error),
    );
  }
};

const currentEndpoint = (): string | null => {
  const siteUrl = state.getSiteUrl()?.trim();
  return siteUrl ? stellaPromptEndpointFromSiteUrl(siteUrl) : null;
};

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > STELLA_PROMPT_MAX_MANIFEST_BYTES
  ) {
    throw new Error("Prompt publication is too large");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > STELLA_PROMPT_MAX_MANIFEST_BYTES) {
    throw new Error("Prompt publication is too large");
  }
  return JSON.parse(new TextDecoder().decode(bytes));
};

const fetchOnce = async (
  endpoint: string,
): Promise<RemotePromptRevalidation> => {
  const headers: Record<string, string> = { accept: "application/json" };
  const cachedForEndpoint =
    state.manifest && state.endpoint === endpoint ? state.manifest : null;
  if (cachedForEndpoint) {
    headers["if-none-match"] = publicationEtag(cachedForEndpoint);
  }
  const response = await state.fetchImpl(endpoint, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 304 && cachedForEndpoint) return "not-modified";
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const manifest = parseRemotePromptManifest(await readBoundedJson(response));
  if (!manifest) throw new Error("Invalid prompt publication");
  if (
    cachedForEndpoint &&
    cachedForEndpoint.revision === manifest.revision &&
    cachedForEndpoint.publishedAt === manifest.publishedAt
  ) {
    return "not-modified";
  }
  adopt(endpoint, manifest);
  await writeCache({ endpoint, manifest });
  return "fresh";
};

/**
 * Bind the store to a data dir and a site-URL resolver. Called once when the
 * runner context is created; the resolver is read at every revalidation so a
 * sign-in that changes the backend takes effect without re-configuring.
 */
export const configureRemotePrompts = (options: {
  stellaDataDir: string;
  getSiteUrl: () => string | null;
  fetchImpl?: typeof fetch;
}): void => {
  state.stellaDataDir = options.stellaDataDir;
  state.getSiteUrl = options.getSiteUrl;
  if (options.fetchImpl) state.fetchImpl = options.fetchImpl;
  state.cacheLoaded = readCache();
};

/** The served body for a prompt id (`agents/orchestrator.md`, `prompts/personality.md`), if loaded. */
export const getRemotePromptBody = (id: string): string | undefined =>
  state.bodies.get(id);

/** Revision of the loaded publication, for diagnostics. */
export const getRemotePromptRevision = (): string | null =>
  state.manifest?.revision ?? null;

/**
 * Conditional refresh. Cheap enough to call on every turn: with a loaded
 * publication it is one `304` round trip. Never throws; a failure leaves the
 * current bodies (or the bundle) in place.
 */
export const revalidateRemotePrompts =
  async (): Promise<RemotePromptRevalidation> => {
    if (state.inFlight) return state.inFlight;
    const endpoint = currentEndpoint();
    if (!endpoint) return "unconfigured";
    const now = Date.now();
    if (now - state.lastAttemptAt < MIN_REVALIDATE_GAP_MS) return "in-flight";
    state.lastAttemptAt = now;
    const attempt = (async (): Promise<RemotePromptRevalidation> => {
      try {
        await state.cacheLoaded;
        const outcome = await fetchOnce(endpoint);
        if (outcome === "fresh") {
          logger.info("publication.adopted", {
            revision: state.manifest?.revision ?? null,
            publishedAt: state.manifest?.publishedAt ?? null,
          });
        }
        return outcome;
      } catch (error) {
        // Offline, BYOK without a backend, or a bad publication: the loaded
        // bodies (or the bundle) carry on. Logged once per outcome change.
        const message = error instanceof Error ? error.message : String(error);
        if (state.lastFailure !== message) {
          state.lastFailure = message;
          logger.warn("publication.unavailable", { endpoint, error: message });
        }
        return "unavailable";
      } finally {
        state.inFlight = null;
      }
    })();
    state.inFlight = attempt;
    return attempt;
  };

/** Fire-and-forget form for turn starts. */
export const scheduleRemotePromptRevalidation = (): void => {
  void revalidateRemotePrompts();
};

/** Wait for the initial disk cache to load (startup ordering only). */
export const remotePromptsReady = (): Promise<void> =>
  state.cacheLoaded ?? Promise.resolve();

export const resetRemotePromptsForTests = (): void => {
  state = createState();
};
