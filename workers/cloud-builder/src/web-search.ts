/**
 * Web search through Parallel's fast search API. The `search` owner domain
 * meters it; this module only talks to the provider.
 */

import type { WebSearchHit, WebSearchResult } from "@stella/contracts/backend/search";

const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";
const MAX_RESULTS = 6;
const MAX_SNIPPET_CHARS = 300;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Parallel Fast is $1 per 1,000 requests: $0.001 in micro-cents. */
export const WEB_SEARCH_COST_MICRO_CENTS = 100_000;

export type WebSearchOutcome = {
  result: WebSearchResult;
  /** A request reached the provider, so it may bill us. */
  dispatched: boolean;
};

const formatText = (query: string, results: WebSearchHit[]): string => {
  if (results.length === 0) return `No web results found for "${query}".`;
  const formatted = results
    .map((result, index) => {
      const parts = [`${index + 1}. ${result.title}`, `   ${result.url}`];
      if (result.snippet) parts.push(`   ${result.snippet}`);
      return parts.join("\n");
    })
    .join("\n\n");
  return `[External Content - Untrusted Source: web search: ${query}]\nWeb search results for "${query}":\n\n${formatted}\n[End External Content]`;
};

const failed = (text: string, dispatched: boolean): WebSearchOutcome => ({
  result: { text, results: [] },
  dispatched,
});

const readBody = async (response: Response): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Search response is too large.");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Search response is too large.");
  return new TextDecoder().decode(bytes);
};

export const searchWeb = async (
  env: Cloudflare.Env,
  input: { query: string; category?: string; signal: AbortSignal },
): Promise<WebSearchOutcome> => {
  const query = input.query.trim();
  if (!query) return failed("WebSearch failed: query is required.", false);
  const apiKey = (env as { PARALLEL_API_KEY?: string }).PARALLEL_API_KEY?.trim();
  if (!apiKey) return failed("WebSearch is not configured (missing PARALLEL_API_KEY).", false);
  const category = input.category?.trim();
  try {
    const response = await fetch(PARALLEL_SEARCH_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        search_queries: [query],
        objective: category
          ? `Find information relevant to: ${query}. Focus on ${category}.`
          : query,
        mode: "fast",
        advanced_settings: { max_results: MAX_RESULTS },
      }),
      signal: input.signal,
    });
    const body = await readBody(response);
    if (!response.ok) return failed(`WebSearch failed (${response.status}): ${body}`, true);
    const data = JSON.parse(body) as {
      results?: Array<{ title?: string; url?: string; excerpts?: string[] }>;
    };
    const results: WebSearchHit[] = (data.results ?? []).map((result) => ({
      title: (result.title ?? "(no title)").trim(),
      url: (result.url ?? "").trim(),
      snippet: (result.excerpts?.join(" ... ") ?? "").trim().slice(0, MAX_SNIPPET_CHARS),
    }));
    return { result: { text: formatText(query, results), results }, dispatched: true };
  } catch (error) {
    if (input.signal.aborted) return failed("WebSearch timed out.", true);
    return failed(`WebSearch failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
};
