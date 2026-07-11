import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { STELLA_PROMPT_DEFAULTS } from "./stella_prompt_defaults.generated";
import {
  STELLA_PROMPT_COUNT,
  STELLA_PROMPT_IDS,
  STELLA_PROMPT_SCHEMA_VERSION,
} from "./stella_prompt_contract";

export const STELLA_PROMPTS_PATH = "/api/stella/prompts";

type StoredPrompt = {
  id: string;
  sha256: string;
  content: string;
  sourceRevision: string;
  updatedAt: number;
};

const isCompleteStoredSnapshot = (stored: StoredPrompt[]): boolean => {
  if (stored.length !== STELLA_PROMPT_COUNT) return false;
  const expected = new Set<string>(STELLA_PROMPT_IDS);
  const revisions = new Set(stored.map((prompt) => prompt.sourceRevision));
  const publicationTimes = new Set(stored.map((prompt) => prompt.updatedAt));
  return (
    revisions.size === 1 &&
    publicationTimes.size === 1 &&
    stored.every((prompt) => expected.delete(prompt.id)) &&
    expected.size === 0
  );
};

export const stellaPrompts = httpAction(async (ctx, request) => {
  const stored: StoredPrompt[] = await ctx.runQuery(
    internal.stella_prompts.list,
    {},
  );
  const useStored = isCompleteStoredSnapshot(stored);
  const prompts = useStored ? stored : STELLA_PROMPT_DEFAULTS.prompts;
  const revision = useStored
    ? stored[0]!.sourceRevision
    : STELLA_PROMPT_DEFAULTS.revision;
  const publishedAt = useStored
    ? stored[0]!.updatedAt
    : STELLA_PROMPT_DEFAULTS.publishedAt;
  const etag = `"${revision}"`;
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control":
      "public, max-age=60, s-maxage=300, stale-while-revalidate=300",
    "Content-Type": "application/json; charset=utf-8",
    ETag: etag,
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(
    JSON.stringify({
      schemaVersion: STELLA_PROMPT_SCHEMA_VERSION,
      revision,
      publishedAt,
      prompts: prompts.map(({ id, sha256, content }) => ({
        id,
        sha256,
        content,
      })),
    }),
    { status: 200, headers },
  );
});
