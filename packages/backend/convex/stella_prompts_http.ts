import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
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

/** Shape a complete stored publication (one revision, one timestamp). */
export const resolveStellaPromptSnapshot = (
  stored: StoredPrompt[],
): PromptResponseSnapshot => {
  const [first] = stored;
  if (!first) throw new Error("Stella prompt publication is empty");
  return {
    revision: first.sourceRevision,
    publishedAt: first.updatedAt,
    prompts: stored.map(({ id, sha256, content }) => ({
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
