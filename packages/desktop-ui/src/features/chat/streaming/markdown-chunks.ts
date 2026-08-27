export const MAX_MARKDOWN_PARSE_CHARS = 12_000;

export const shouldUseBoundedMarkdownPlaintext = (textLength: number): boolean =>
  textLength >= MAX_MARKDOWN_PARSE_CHARS;
