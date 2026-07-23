import { hashSha256Hex } from "./lib/crypto_utils";

export const STELLA_PROMPT_SCHEMA_VERSION = 2 as const;
export const STELLA_PROMPT_IDS = [
  "agents/orchestrator.md",
  "agents/manager.md",
  "agents/general.md",
  "agents/schedule.md",
  "agents/fashion.md",
  "agents/social_session.md",
  "agents/explore.md",
  "agents/dream.md",
  "agents/install_update.md",
  "prompts/dream-scheduled.md",
  "prompts/chronicle-summarizer.md",
  "prompts/memory-review.md",
  "prompts/thread-compaction.md",
  "prompts/fallback-orchestrator.md",
  "prompts/fallback-subagent.md",
  "prompts/personality-stella.md",
  "prompts/personality-professional.md",
] as const;

export const STELLA_PROMPT_COUNT = STELLA_PROMPT_IDS.length;
export const STELLA_PROMPT_MAX_CONTENT_BYTES = 256 * 1024;
export const STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES = 1024 * 1024;
export const STELLA_PROMPT_MAX_REQUEST_BYTES = 1200 * 1024;
export const STELLA_PROMPT_REVISION_PATTERN = /^[0-9a-f]{64}$/;

const EXPECTED_IDS = new Set<string>(STELLA_PROMPT_IDS);
const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).length;

export type StellaPromptInput = { id: string; content: string };

export type PromptValidationResult =
  | { ok: true; prompts: StellaPromptInput[] }
  | { ok: false; error: string };

export const validateStellaPromptInputs = (
  value: unknown,
): PromptValidationResult => {
  if (!Array.isArray(value) || value.length !== STELLA_PROMPT_COUNT) {
    return {
      ok: false,
      error: `Expected exactly ${STELLA_PROMPT_COUNT} prompts.`,
    };
  }
  const prompts: StellaPromptInput[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") {
      return { ok: false, error: "Every prompt must be an object." };
    }
    const prompt = candidate as Record<string, unknown>;
    const keys = Object.keys(prompt).sort();
    if (keys.length !== 2 || keys[0] !== "content" || keys[1] !== "id") {
      return {
        ok: false,
        error: "Prompt entries may contain only id and content.",
      };
    }
    if (typeof prompt.id !== "string" || !EXPECTED_IDS.has(prompt.id)) {
      return { ok: false, error: `Unexpected prompt id: ${String(prompt.id)}` };
    }
    if (seen.has(prompt.id)) {
      return { ok: false, error: `Duplicate prompt id: ${prompt.id}` };
    }
    if (typeof prompt.content !== "string" || prompt.content.length === 0) {
      return {
        ok: false,
        error: `Prompt ${prompt.id} must have non-empty content.`,
      };
    }
    const contentBytes = utf8Bytes(prompt.content);
    if (contentBytes > STELLA_PROMPT_MAX_CONTENT_BYTES) {
      return {
        ok: false,
        error: `Prompt ${prompt.id} exceeds the size limit.`,
      };
    }
    totalBytes += contentBytes;
    if (totalBytes > STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES) {
      return {
        ok: false,
        error: "Prompt content exceeds the total size limit.",
      };
    }
    seen.add(prompt.id);
    prompts.push({ id: prompt.id, content: prompt.content });
  }
  if (seen.size !== EXPECTED_IDS.size) {
    return { ok: false, error: "One or more required prompts are missing." };
  }
  return { ok: true, prompts };
};

export const hashStellaPromptInputs = async (
  prompts: readonly StellaPromptInput[],
): Promise<Array<StellaPromptInput & { sha256: string }>> =>
  await Promise.all(
    prompts.map(async (prompt) => ({
      ...prompt,
      sha256: await hashSha256Hex(prompt.content),
    })),
  );

export const deriveStellaPromptRevision = async (
  prompts: readonly StellaPromptInput[],
): Promise<string> => {
  const hashed = await hashStellaPromptInputs(prompts);
  return await hashSha256Hex(
    hashed
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((prompt) => `${prompt.id}:${prompt.sha256}`)
      .join("\n"),
  );
};

export const nextStellaPromptPublishedAt = (
  existingPublicationTimes: readonly number[],
  now: number,
): number =>
  Math.max(now, ...existingPublicationTimes.map((value) => value + 1));

export const readBoundedPromptPublishBody = async (
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> => {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > STELLA_PROMPT_MAX_REQUEST_BYTES
  ) {
    return { ok: false, error: "Request body is too large." };
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > STELLA_PROMPT_MAX_REQUEST_BYTES) {
    return { ok: false, error: "Request body is too large." };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, error: "Request body must be valid JSON." };
  }
};
