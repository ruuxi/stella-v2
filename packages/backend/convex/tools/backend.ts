import { parse, type DefaultTreeAdapterMap } from "parse5";
import TurndownService from "turndown";
import type { ActionCtx } from "../_generated/server";
import { BACKEND_TOOL_IDS } from "../lib/agent_constants";
import { truncateWithNotice } from "../lib/text_utils";
import { normalizeSafeExternalUrl } from "../lib/url_security";
import { createManagedUsageDispatchGuard } from "../lib/managed_billing";
import { hashSha256Hex } from "../lib/crypto_utils";
import {
  PARALLEL_SEARCH_FAST_BILLING_KIND,
  PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
} from "../lib/managed_dispatch";
import { runManagedDispatchAttempt } from "../runtime_ai/managed";
import type {
  BackendToolExecutionOptions,
  BackendToolSet,
  ToolOptions,
} from "./types";

const MAX_WEB_SEARCH_RESULTS = 6;
const MAX_WEB_SEARCH_SNIPPET_CHARS = 300;
const MAX_WEB_FETCH_REDIRECTS = 5;
const MAX_WEB_FETCH_BODY_BYTES = 5 * 1024 * 1024;
const HTML_MIME_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXTUAL_APPLICATION_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/javascript",
  "application/x-javascript",
]);
const SKIPPED_HTML_ELEMENTS = new Set([
  "head",
  "script",
  "style",
  "template",
  "noscript",
  "svg",
  "canvas",
]);
const BLOCK_HTML_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);
type HtmlNode = DefaultTreeAdapterMap["node"];

const htmlToText = (html: string): string => {
  const document = parse(html);
  const chunks: string[] = [];
  const visit = (node: HtmlNode) => {
    if ("nodeName" in node && SKIPPED_HTML_ELEMENTS.has(node.nodeName)) return;
    if (node.nodeName === "#text" && "value" in node) {
      chunks.push(node.value);
      return;
    }
    const isBlock =
      "nodeName" in node &&
      BLOCK_HTML_ELEMENTS.has(node.nodeName.toLowerCase());
    if (isBlock) chunks.push("\n");
    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child);
    }
    if (isBlock) chunks.push("\n");
  };
  visit(document);
  return chunks
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});
turndown.remove(["head", "script", "style", "template", "noscript", "canvas"]);
turndown.addRule("removeSvg", {
  filter: (node) => node.nodeName === "SVG",
  replacement: () => "",
});
const htmlToMarkdown = (html: string): string =>
  turndown
    .turndown(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const isSupportedTextualMimeType = (contentType: string): boolean => {
  const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mimeType.startsWith("text/") ||
    TEXTUAL_APPLICATION_MIME_TYPES.has(mimeType) ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
};

const backendToolAbortError = (signal: AbortSignal): Error => {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Backend tool execution was aborted");
  error.name = "AbortError";
  return error;
};

const throwIfBackendToolAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw backendToolAbortError(signal);
};

const readTextBodyWithLimit = async (
  response: Response,
  signal: AbortSignal,
): Promise<string> => {
  throwIfBackendToolAborted(signal);
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_WEB_FETCH_BODY_BYTES
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `Response body exceeds the ${MAX_WEB_FETCH_BODY_BYTES} byte limit.`,
    );
  }
  if (!response.body) {
    throwIfBackendToolAborted(signal);
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  const abortRead = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abortRead, { once: true });
  if (signal.aborted) abortRead();
  try {
    while (true) {
      throwIfBackendToolAborted(signal);
      const { done, value } = await reader.read();
      throwIfBackendToolAborted(signal);
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_WEB_FETCH_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `Response body exceeds the ${MAX_WEB_FETCH_BODY_BYTES} byte limit.`,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    throwIfBackendToolAborted(signal);
    return chunks.join("");
  } finally {
    signal.removeEventListener("abort", abortRead);
    reader.releaseLock();
  }
};

const SECRET_TOKEN_RE =
  /\b(?:sk-(?:proj-)?|sk-ant-|gh[pousr]_|github_pat_|xox[baprs]-|hf_|AKIA|AIza)[A-Za-z0-9._:=+/~-]{10,}\b/g;
const redactSecretLikeText = (text: string): string =>
  text.replace(
    SECRET_TOKEN_RE,
    (value) => `${value.slice(0, 6)}...${value.slice(-4)}`,
  );

const PROMPT_STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "check",
  "current",
  "extract",
  "from",
  "give",
  "just",
  "latest",
  "official",
  "page",
  "relevant",
  "that",
  "this",
  "what",
  "with",
]);
const extractRelevantText = (text: string, prompt: string): string => {
  const terms = Array.from(
    new Set(
      (prompt.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []).filter(
        (term) =>
          !PROMPT_STOP_WORDS.has(term) && (term.length >= 3 || /\d/.test(term)),
      ),
    ),
  );
  if (terms.length === 0) return text;
  const lines = text.split("\n");
  const matches = lines
    .map((line, index) => ({
      index,
      score: terms.reduce(
        (total, term) =>
          total + (line.toLowerCase().includes(term) ? term.length : 0),
        0,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
  if (matches.length === 0) return text;
  const selected = new Set<number>();
  for (const match of matches) {
    for (
      let index = Math.max(0, match.index - 5);
      index <= Math.min(lines.length - 1, match.index + 5);
      index += 1
    ) {
      selected.add(index);
    }
    if (
      Array.from(selected).reduce(
        (total, index) => total + (lines[index]?.length ?? 0),
        0,
      ) >= 15_000
    )
      break;
  }
  const excerpts: string[] = [];
  let previous = -2;
  for (const index of Array.from(selected).sort(
    (left, right) => left - right,
  )) {
    if (index > previous + 1 && excerpts.length > 0) excerpts.push("[…]");
    excerpts.push(lines[index] ?? "");
    previous = index;
  }
  return `[Relevant excerpts for: ${prompt}]\n\n${excerpts.join("\n")}`;
};

const wrapExternalContent = (content: string, source: string): string =>
  `[External Content - Untrusted Source: ${source}]\n${content}\n[End External Content]`;

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  /** Optional compatibility field for providers that return result images. */
  image?: string;
  /** Optional compatibility field for providers that return favicons. */
  favicon?: string;
};

export type WebSearchResponse = {
  text: string;
  results: SearchHit[];
};

class ParallelSearchResponseError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string) {
    super(`Parallel search failed with status ${status}`);
    this.name = "ParallelSearchResponseError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

const formatWebSearchText = (query: string, results: SearchHit[]): string => {
  if (results.length === 0) {
    return `No web results found for "${query}".`;
  }

  const formatted = results
    .map((result, index) => {
      const parts = [`${index + 1}. ${result.title}`, `   ${result.url}`];
      if (result.snippet) parts.push(`   ${result.snippet}`);
      return parts.join("\n");
    })
    .join("\n\n");

  return wrapExternalContent(
    `Web search results for "${query}":\n\n${formatted}`,
    `web search: ${query}`,
  );
};

export const executeWebSearch = async (
  ctx: Pick<ActionCtx, "runMutation">,
  queryInput: string,
  options: {
    ownerId: string;
    ownerGeneration: string;
    /** The cloud turn this search runs for (capability-authenticated route). */
    turnAuthority?: { turnId: string };
    signal: AbortSignal;
    category?: string;
  },
): Promise<WebSearchResponse> => {
  throwIfBackendToolAborted(options.signal);
  const ownerId = options.ownerId.trim();
  const ownerGeneration = options.ownerGeneration.trim();
  if (!ownerId || !ownerGeneration) {
    throw new Error("WebSearch requires an exact owner generation.");
  }
  const query = queryInput.trim();
  if (!query) {
    return {
      text: "WebSearch failed: query is required.",
      results: [],
    };
  }

  const apiKey = process.env.PARALLEL_API_KEY;
  if (!apiKey) {
    return {
      text: "WebSearch is not configured (missing PARALLEL_API_KEY).",
      results: [],
    };
  }

  throwIfBackendToolAborted(options.signal);
  const requestBody = {
    search_queries: [query],
    objective: options.category
      ? `Find information relevant to: ${query}. Focus on ${options.category}.`
      : query,
    mode: "fast",
    advanced_settings: {
      max_results: MAX_WEB_SEARCH_RESULTS,
    },
  } as const;
  const requestFingerprint = await hashSha256Hex(
    JSON.stringify({
      provider: "parallel",
      endpoint: "/v1/search",
      requestBody,
    }),
  );
  throwIfBackendToolAborted(options.signal);
  const dispatchGuard = createManagedUsageDispatchGuard(ctx, {
    ownerId,
    ownerGeneration,
    ...(options.turnAuthority
      ? { turnAuthority: options.turnAuthority }
      : {}),
    billing: {
      kind: PARALLEL_SEARCH_FAST_BILLING_KIND,
      requestFingerprint,
      chargeMicroCents: PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
    },
  });

  try {
    const upstream = await runManagedDispatchAttempt({
      dispatchGuard,
      callerSignal: options.signal,
      run: async (signal) => {
        const response = await fetch("https://api.parallel.ai/v1/search", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
          signal,
        });
        const body = await readTextBodyWithLimit(response, signal);
        if (!response.ok) {
          throw new ParallelSearchResponseError(response.status, body);
        }
        return body;
      },
    });

    const data = JSON.parse(upstream) as {
      results?: Array<{
        title?: string;
        url?: string;
        excerpts?: string[];
      }>;
    };

    const results: SearchHit[] = (data.results ?? []).map((result) => {
      const snippet = result.excerpts?.join(" ... ") ?? "";
      return {
        title: (result.title ?? "(no title)").trim(),
        url: (result.url ?? "").trim(),
        snippet: snippet.trim().slice(0, MAX_WEB_SEARCH_SNIPPET_CHARS),
      };
    });

    throwIfBackendToolAborted(options.signal);
    return {
      text: formatWebSearchText(query, results),
      results,
    };
  } catch (error) {
    if (options.signal.aborted || dispatchGuard.signal.aborted) {
      throw error;
    }
    if (error instanceof ParallelSearchResponseError) {
      return {
        text: `WebSearch failed (${error.status}): ${error.responseBody}`,
        results: [],
      };
    }
    return {
      text: `WebSearch failed: ${(error as Error).message}`,
      results: [],
    };
  }
};

const WEB_SEARCH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      minLength: 2,
      description:
        "Natural language search query - write descriptively, not as keywords",
    },
    category: {
      type: "string",
      description:
        "Optional focus hint for the search objective. Most queries should omit this.",
    },
  },
  required: ["query"],
} as const;

const WEB_FETCH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: {
      type: "string",
      description: "URL to fetch (HTTP auto-upgrades to HTTPS)",
    },
    prompt: {
      type: "string",
      description: "What information you want from this page",
    },
    format: {
      type: "string",
      enum: ["text", "markdown", "html"],
      description: "Fetch output format. Defaults to text.",
    },
  },
  required: ["url"],
} as const;

const EMPTY_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export const createBackendTools = (
  ctx: ActionCtx,
  options: ToolOptions,
): BackendToolSet => {
  const webSearchOwner =
    options.ownerId && options.ownerGeneration
      ? {
          ownerId: options.ownerId,
          ownerGeneration: options.ownerGeneration,
        }
      : null;
  return {
    ...(webSearchOwner
      ? {
          [BACKEND_TOOL_IDS.WEB_SEARCH]: {
            name: BACKEND_TOOL_IDS.WEB_SEARCH,
            description:
              "Search the web via Parallel for current information.\n\n" +
              "Use natural language queries, not keywords (e.g. 'Tesla current stock performance' not 'TSLA stock price').\n" +
              "Returns up to 6 ranked results with title, URL, and relevant excerpts.\n\n" +
              "The optional category is a general focus hint; most queries should omit it.",
            parameters: WEB_SEARCH_PARAMETERS,
            execute: async (
              args: Record<string, unknown>,
              execution: BackendToolExecutionOptions,
            ) => {
              const result = await executeWebSearch(
                ctx,
                String(args.query ?? ""),
                {
                  ...webSearchOwner,
                  signal: execution.signal,
                  category:
                    typeof args.category === "string"
                      ? args.category
                      : undefined,
                },
              );
              return result.text;
            },
          },
        }
      : {}),
    [BACKEND_TOOL_IDS.WEB_FETCH]: {
      name: BACKEND_TOOL_IDS.WEB_FETCH,
      description:
        "Fetch and read content from a URL.\n\n" +
        "Usage:\n" +
        "- Fetches the page content, strips HTML tags, and returns plain text.\n" +
        "- HTTP URLs are auto-upgraded to HTTPS.\n" +
        "- prompt describes what information you want to extract - it's returned alongside the content for context.\n" +
        "- Content is truncated to 15,000 characters.",
      parameters: WEB_FETCH_PARAMETERS,
      execute: async (args, execution) => {
        try {
          throwIfBackendToolAborted(execution.signal);
          const requestedUrl = String(args.url ?? "");
          SECRET_TOKEN_RE.lastIndex = 0;
          if (SECRET_TOKEN_RE.test(requestedUrl)) {
            return "Error: URL contains what appears to be an API key or token. Secrets must not be sent in URLs.";
          }
          let secureUrl = normalizeSafeExternalUrl(requestedUrl);
          let response: Response | null = null;
          for (
            let redirectCount = 0;
            redirectCount <= MAX_WEB_FETCH_REDIRECTS;
            redirectCount += 1
          ) {
            response = await fetch(secureUrl, {
              redirect: "manual",
              headers: { "User-Agent": "StellaBackend/1.0" },
              signal: execution.signal,
            });
            throwIfBackendToolAborted(execution.signal);

            const location = response.headers.get("location");
            if (response.status >= 300 && response.status < 400 && location) {
              await response.body?.cancel().catch(() => {});
              secureUrl = normalizeSafeExternalUrl(
                new URL(location, secureUrl).toString(),
              );
              continue;
            }
            break;
          }

          if (!response) {
            return "Failed to fetch (no response)";
          }
          if (
            response.status >= 300 &&
            response.status < 400 &&
            response.headers.get("location")
          ) {
            await response.body?.cancel().catch(() => {});
            throwIfBackendToolAborted(execution.signal);
            return `Failed to fetch (too many redirects, limit ${MAX_WEB_FETCH_REDIRECTS})`;
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throwIfBackendToolAborted(execution.signal);
            return `Failed to fetch (${response.status} ${response.statusText})`;
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (!isSupportedTextualMimeType(contentType)) {
            await response.body?.cancel().catch(() => {});
            throwIfBackendToolAborted(execution.signal);
            const displayedType =
              contentType.split(";", 1)[0]?.trim() || "missing";
            return `Error: Unsupported or binary Content-Type: ${displayedType}`;
          }
          const rawBody = await readTextBodyWithLimit(
            response,
            execution.signal,
          );
          const mimeType =
            contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
          const format =
            args.format === "markdown" || args.format === "html"
              ? args.format
              : "text";
          let body = rawBody;
          if (HTML_MIME_TYPES.has(mimeType)) {
            if (format === "text") body = htmlToText(rawBody);
            if (format === "markdown") body = htmlToMarkdown(rawBody);
          }
          const prompt = String(args.prompt ?? "").trim();
          if (prompt && format !== "html")
            body = extractRelevantText(body, prompt);
          throwIfBackendToolAborted(execution.signal);
          return wrapExternalContent(
            `Content from ${secureUrl}${prompt ? `\nPrompt: ${prompt}` : ""}\n\n${truncateWithNotice(redactSecretLikeText(body), 15_000)}`,
            secureUrl,
          );
        } catch (error) {
          if (execution.signal.aborted) throw error;
          return `Error fetching URL: ${(error as Error).message}`;
        }
      },
    },
    [BACKEND_TOOL_IDS.NO_RESPONSE]: {
      name: BACKEND_TOOL_IDS.NO_RESPONSE,
      description:
        "Signal that you have nothing to say to the user right now. " +
        "Call this instead of generating a message when a system event, task result, or heartbeat check " +
        "does not warrant a visible response. Do NOT call this for user messages - always reply to users.",
      parameters: EMPTY_PARAMETERS,
      execute: async (_args, execution) => {
        throwIfBackendToolAborted(execution.signal);
        return "__NO_RESPONSE__";
      },
    },
  };
};
