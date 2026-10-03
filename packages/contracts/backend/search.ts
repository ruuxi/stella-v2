/**
 * Web search, metered against the owner's plan. The desktop runtime calls
 * `search.web`; cloud turns reach the same operation inside the Worker.
 */

export type WebSearchHit = {
  title: string;
  url: string;
  snippet: string;
  image?: string;
  favicon?: string;
};

export type WebSearchResult = {
  /** The hits formatted for a model, wrapped as untrusted external content. */
  text: string;
  results: WebSearchHit[];
};

export type SearchCalls = {
  /**
   * Search the web. A provider failure answers with its reason in `text` and
   * no results; refused (`RATE_LIMITED`) past the plan's limits.
   */
  "search.web": {
    args: { query: string; category?: string };
    result: WebSearchResult;
  };
};
