/**
 * HTML → text / Markdown conversion for WebFetch.
 *
 * Kept out of `local-tool-overrides.ts` so the worker does not parse it at
 * boot: parse5 and turndown (which pulls in domino and entities) are ~830 KB
 * of bundled JS, and only a fetched HTML page needs them.
 * `local-tool-overrides.ts` loads this module with `await import()` on first
 * use, and esbuild splits it into its own chunk.
 */

import { parse, type DefaultTreeAdapterMap } from "parse5";
import TurndownService from "turndown";

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
