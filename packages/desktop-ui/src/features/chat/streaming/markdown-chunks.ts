export const MAX_MARKDOWN_PARSE_CHARS = 12_000;

/** Keep every Streamdown parse below a hard main-thread work budget. */
export const shouldUseBoundedMarkdownPlaintext = (textLength: number): boolean =>
  textLength >= MAX_MARKDOWN_PARSE_CHARS;
