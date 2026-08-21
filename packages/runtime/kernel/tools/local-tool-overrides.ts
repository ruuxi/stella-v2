/**
 * Local tool implementations for tools that don't need the server.
 *
 * These replace the backend passthrough (`callBackendTool`) for tools
 * that can execute entirely in the Electron process:
 * - WebFetch: direct fetch() + HTML-to-text
 * - NoResponse: immediate return
 */

import { parse, type DefaultTreeAdapterMap } from "parse5";
import TurndownService from "turndown";
import { normalizeSafeExternalUrl } from "./network-guards.js";
import { containsSecretLikeToken, sanitizeToolVisibleText } from "./safety.js";

export const MAX_FETCH_BODY_CHARS = 24_000;
export const MAX_PROMPT_FETCH_BODY_CHARS = 16_000;
export const MAX_FETCH_BODY_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_REDIRECTS = 5;
const PROMPT_CONTEXT_LINES = 5;
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
  "notes",
  "official",
  "page",
  "release",
  "relevant",
  "stable",
  "that",
  "this",
  "what",
  "with",
]);

// WebFetch

export type WebFetchFormat = "text" | "markdown" | "html";

type HtmlNode = DefaultTreeAdapterMap["node"];

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

/** Parse HTML into a DOM tree before extracting visible text. */
export const htmlToText = (html: string): string => {
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
turndown.remove([
  "head",
  "script",
  "style",
  "template",
  "noscript",
  "svg",
  "canvas",
]);

/** Convert parsed HTML semantics to Markdown (links, lists, headings, code, etc.). */
export const htmlToMarkdown = (html: string): string =>
  turndown
    .turndown(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

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

export const isSupportedTextualMimeType = (contentType: string): boolean => {
  const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mimeType.startsWith("text/") ||
    TEXTUAL_APPLICATION_MIME_TYPES.has(mimeType) ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
};

const readTextBodyWithLimit = async (response: Response): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_FETCH_BODY_BYTES
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `Response body exceeds the ${MAX_FETCH_BODY_BYTES} byte limit.`,
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_FETCH_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `Response body exceeds the ${MAX_FETCH_BODY_BYTES} byte limit.`,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
};

const promptSearchTerms = (prompt: string): string[] =>
  Array.from(
    new Set(
      (prompt.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []).filter(
        (term) =>
          !PROMPT_STOP_WORDS.has(term) && (term.length >= 3 || /\d/.test(term)),
      ),
    ),
  );

const boundedText = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const marker = "\n\n[Content truncated]\n\n";
  const available = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(available * 0.7);
  const tailChars = Math.floor(available - headChars);
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
};

/**
 * Select prompt-relevant windows from a long page before it becomes model
 * context. The extraction is deterministic and intentionally conservative:
 * when no useful term matches, the normal bounded head/tail projection wins.
 */
export const extractRelevantWebText = (
  text: string,
  prompt?: string,
): string => {
  const normalizedPrompt = prompt?.trim();
  if (!normalizedPrompt) return boundedText(text, MAX_FETCH_BODY_CHARS);

  const terms = promptSearchTerms(normalizedPrompt);
  const lines = text.split("\n");
  const scoredLines = lines
    .map((line, index) => {
      const lower = line.toLowerCase();
      const score = terms.reduce(
        (total, term) => total + (lower.includes(term) ? term.length : 0),
        0,
      );
      return { index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );

  if (scoredLines.length === 0) {
    return boundedText(text, MAX_PROMPT_FETCH_BODY_CHARS);
  }

  const selected = new Set<number>();
  for (const match of scoredLines) {
    for (
      let index = Math.max(0, match.index - PROMPT_CONTEXT_LINES);
      index <= Math.min(lines.length - 1, match.index + PROMPT_CONTEXT_LINES);
      index += 1
    ) {
      selected.add(index);
    }
    const selectedChars = Array.from(selected).reduce(
      (sum, index) => sum + (lines[index]?.length ?? 0) + 1,
      0,
    );
    if (selectedChars >= MAX_PROMPT_FETCH_BODY_CHARS) break;
  }

  const excerpts: string[] = [];
  let previousIndex = -2;
  for (const index of Array.from(selected).sort(
    (left, right) => left - right,
  )) {
    if (index > previousIndex + 1 && excerpts.length > 0) excerpts.push("[…]");
    excerpts.push(lines[index] ?? "");
    previousIndex = index;
  }

  return boundedText(
    `[Relevant excerpts for: ${normalizedPrompt}]\n\n${excerpts.join("\n")}`,
    MAX_PROMPT_FETCH_BODY_CHARS,
  );
};

export const localWebFetch = async (args: {
  url: string;
  prompt?: string;
  format?: WebFetchFormat;
}): Promise<string> => {
  if (!args.url) return "Error: URL is required.";
  if (containsSecretLikeToken(args.url)) {
    return "Error: URL contains what appears to be an API key or token. Secrets must not be sent in URLs.";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let targetUrl = await normalizeSafeExternalUrl(args.url);

    let response: Response | null = null;
    for (
      let redirectCount = 0;
      redirectCount <= MAX_FETCH_REDIRECTS;
      redirectCount += 1
    ) {
      response = await fetch(targetUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "Stella/1.0 (Desktop Assistant)",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        },
      });

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => {});
        targetUrl = await normalizeSafeExternalUrl(
          new URL(location, targetUrl).toString(),
        );
        continue;
      }

      break;
    }
    if (!response) {
      return "Error: No response received.";
    }
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get("location")
    ) {
      return `Error: Too many redirects (limit ${MAX_FETCH_REDIRECTS})`;
    }

    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText}`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!isSupportedTextualMimeType(contentType)) {
      await response.body?.cancel().catch(() => {});
      const displayedType = contentType.split(";", 1)[0]?.trim() || "missing";
      return `Error: Unsupported or binary Content-Type: ${displayedType}`;
    }

    const rawBody = await readTextBodyWithLimit(response);
    const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const format = args.format ?? "text";
    let text = rawBody;
    if (HTML_MIME_TYPES.has(mimeType)) {
      if (format === "text") text = htmlToText(rawBody);
      if (format === "markdown") text = htmlToMarkdown(rawBody);
    }

    // Prompt extraction is useful for readable text/Markdown, but would
    // destroy the structural validity of callers explicitly requesting HTML.
    text =
      format === "html"
        ? boundedText(text, MAX_FETCH_BODY_CHARS)
        : extractRelevantWebText(text, args.prompt);

    if (!text.trim()) {
      return "The page returned no readable text content.";
    }

    return sanitizeToolVisibleText(text);
  } catch (error) {
    const msg = (error as Error).message ?? "Unknown error";
    if (msg.includes("abort")) {
      return `Error: Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
    }
    return `Error fetching URL: ${sanitizeToolVisibleText(msg)}`;
  } finally {
    clearTimeout(timeout);
  }
};

// NoResponse

export const localNoResponse = async (): Promise<string> => {
  return "";
};
