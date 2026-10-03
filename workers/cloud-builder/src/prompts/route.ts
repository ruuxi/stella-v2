/**
 * `GET /api/stella/prompts`: the bundled prompt set for desktop runtimes.
 * Public, like every client's copy of the same text. The revision is the
 * ETag, so a desktop revalidation of an unchanged deploy is one 304.
 */
import { STELLA_PROMPT_SCHEMA_VERSION } from "@stella/contracts/stella-prompts";

import { STELLA_PROMPT_DEFAULTS } from "./defaults.generated.js";

const ETAG = `"${STELLA_PROMPT_DEFAULTS.revision}"`;

const BODY = JSON.stringify({
  schemaVersion: STELLA_PROMPT_SCHEMA_VERSION,
  revision: STELLA_PROMPT_DEFAULTS.revision,
  publishedAt: STELLA_PROMPT_DEFAULTS.publishedAt,
  prompts: STELLA_PROMPT_DEFAULTS.prompts.map(({ id, sha256, content }) => ({
    id,
    sha256,
    content,
  })),
});

export const stellaPromptsResponse = (request: Request): Response => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control":
      "public, max-age=60, s-maxage=300, stale-while-revalidate=300",
    "Content-Type": "application/json; charset=utf-8",
    ETag: ETAG,
  };
  // Edge compression may weaken the ETag a client echoes back.
  if (request.headers.get("if-none-match")?.replace(/^W\//u, "") === ETAG) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(BODY, { status: 200, headers });
};
