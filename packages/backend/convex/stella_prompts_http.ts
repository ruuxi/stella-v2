import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { STELLA_PROMPT_DEFAULTS } from "./stella_prompt_defaults.generated";
import {
  isCompleteStellaPromptPublication,
  STELLA_PROMPT_SCHEMA_VERSION,
} from "./stella_prompt_contract";

export const STELLA_PROMPTS_PATH = "/api/stella/prompts";

export type StoredPrompt = {
  id: string;
  sha256: string;
  content: string;
  sourceRevision: string;
  updatedAt: number;
};

export type PromptResponseSnapshot = {
  prompts: Array<{ id: string; sha256: string; content: string }>;
  revision: string;
  publishedAt: number;
};

export const stellaPromptPublicationEtag = (
  publishedAt: number,
  revision: string,
): string => `"${publishedAt}-${revision}"`;

export const stellaPromptResponse = (
  request: Request,
  snapshot: PromptResponseSnapshot,
): Response => {
  const etag = stellaPromptPublicationEtag(
    snapshot.publishedAt,
    snapshot.revision,
  );
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
      revision: snapshot.revision,
      publishedAt: snapshot.publishedAt,
      prompts: snapshot.prompts,
    }),
    { status: 200, headers },
  );
};

export const resolveStellaPromptSnapshot = (
  stored: StoredPrompt[],
): PromptResponseSnapshot => {
  const useStored = isCompleteStellaPromptPublication(stored);
  const prompts = useStored ? stored : STELLA_PROMPT_DEFAULTS.prompts;
  return {
    revision: useStored
      ? stored[0]!.sourceRevision
      : STELLA_PROMPT_DEFAULTS.revision,
    publishedAt: useStored
      ? stored[0]!.updatedAt
      : STELLA_PROMPT_DEFAULTS.publishedAt,
    prompts: prompts.map(({ id, sha256, content }) => ({
      id,
      sha256,
      content,
    })),
  };
};

export const stellaPrompts = httpAction(async (ctx, request) => {
  let stored: StoredPrompt[] = await ctx.runQuery(
    internal.stella_prompts.list,
    {},
  );
  if (!isCompleteStellaPromptPublication(stored)) {
    stored = await ctx.runMutation(
      internal.stella_prompts.ensureDefaultPublication,
      {},
    );
  }
  return stellaPromptResponse(request, resolveStellaPromptSnapshot(stored));
});
