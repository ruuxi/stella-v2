import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { STELLA_PROMPT_DEFAULTS } from "./stella_prompt_defaults.generated";

export const STELLA_PROMPTS_PATH = "/api/stella/prompts";

type StoredPrompt = {
  id: string;
  sha256: string;
  content: string;
  sourceRevision: string;
  updatedAt: number;
};

export const stellaPrompts = httpAction(async (ctx, request) => {
  const stored: StoredPrompt[] = await ctx.runQuery(
    internal.stella_prompts.list,
    {},
  );
  const prompts = stored.length > 0 ? stored : STELLA_PROMPT_DEFAULTS.prompts;
  const revision =
    stored.length > 0
      ? [...stored].sort((a, b) => b.updatedAt - a.updatedAt)[0]!.sourceRevision
      : STELLA_PROMPT_DEFAULTS.revision;
  const etag = `"${revision}"`;
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control":
      "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
    "Content-Type": "application/json; charset=utf-8",
    ETag: etag,
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      revision,
      prompts: prompts.map(({ id, sha256, content }) => ({
        id,
        sha256,
        content,
      })),
    }),
    { status: 200, headers },
  );
});
