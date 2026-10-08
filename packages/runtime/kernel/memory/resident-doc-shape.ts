/**
 * How a resident memory document's file text becomes what the model reads,
 * on every host: HTML comments stripped, secrets redacted, capped at a line
 * boundary with a visible marker. Pure, so the desktop (reading
 * `~/.stella`) and the cloud (reading the owner's home) shape the same file
 * into the same bytes.
 */

import { redactMemoryText } from "./redaction.js";

const unicodeCodePointLength = (text: string): number => Array.from(text).length;

const stripInjectedHtmlComments = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<!--[\s\S]*$/u, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

const TRUNCATION_MARKER =
  "\n...[truncated for context budget — the file on disk is complete; edit it down]";

const truncateUnicodeAtLineBoundary = (
  text: string,
  maxChars: number,
): string => {
  if (unicodeCodePointLength(text) <= maxChars) return text;
  const markerChars = unicodeCodePointLength(TRUNCATION_MARKER);
  if (maxChars < markerChars) return "";
  const prefixBudget = maxChars - markerChars;
  let prefix = "";
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n)/gu)) {
    const candidate = `${prefix}${match[0]}`;
    if (unicodeCodePointLength(candidate) > prefixBudget) break;
    prefix = candidate;
  }
  if (!prefix) {
    prefix = [...text].slice(0, prefixBudget).join("");
  }
  return `${prefix}${TRUNCATION_MARKER}`;
};

/** The injected body for a memory file's text, or undefined when empty. */
export const shapeResidentMemoryDoc = (
  raw: string,
  maxChars: number,
): string | undefined => {
  const content = stripInjectedHtmlComments(raw);
  if (!content) return undefined;
  return truncateUnicodeAtLineBoundary(redactMemoryText(content), maxChars) || undefined;
};
