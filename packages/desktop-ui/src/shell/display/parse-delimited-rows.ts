/**
 * Bounded CSV/TSV parsing for the spreadsheet preview tab.
 *
 * The preview only ever renders the first screenfuls of a table, so both the
 * byte read and the row parse are capped: a several-hundred-MB export must not
 * be decoded and split into cells on the UI thread just to show its head.
 */
export const DELIMITED_PREVIEW_MAX_COLUMNS = 100;
export const DELIMITED_PREVIEW_MAX_ROWS = 1_000;
export const DELIMITED_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export type DelimitedParseResult = {
  rows: string[][];
  /** True when `maxRows` stopped the parse before the text ran out. */
  hitLimit: boolean;
  columnsTruncated?: boolean;
};

export const parseDelimitedRows = (
  text: string,
  delimiter: "," | "\t",
  maxRows: number = DELIMITED_PREVIEW_MAX_ROWS,
): DelimitedParseResult => {
  const rows: string[][] = [];
  if (maxRows <= 0) {
    return { rows, hitLimit: false };
  }

  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let columnsTruncated = false;
  const append = (value: string) => {
    if (row.length < DELIMITED_PREVIEW_MAX_COLUMNS) cell += value;
    else columnsTruncated = true;
  };
  const commitCell = () => {
    if (row.length < DELIMITED_PREVIEW_MAX_COLUMNS) row.push(cell);
    else columnsTruncated = true;
    cell = "";
  };

  const commitRow = (): boolean => {
    rows.push(row);
    row = [];
    cell = "";
    return rows.length >= maxRows;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        append('"');
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        append(char);
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      commitCell();
    } else if (char === "\n") {
      commitCell();
      if (commitRow()) {
        return { rows, hitLimit: true, columnsTruncated };
      }
    } else if (char !== "\r") {
      append(char);
    }
  }

  if (cell.length > 0 || row.length > 0) {
    commitCell();
    if (commitRow()) {
      return { rows, hitLimit: true, columnsTruncated };
    }
  }

  return { rows, hitLimit: false, columnsTruncated };
};

/** Drop the last row when a byte cap may have torn it mid-line. */
export const rowsForDelimitedPreview = (
  parsed: DelimitedParseResult,
  truncated: boolean,
): string[][] => {
  if (truncated && !parsed.hitLimit && parsed.rows.length > 0) {
    return parsed.rows.slice(0, -1);
  }
  return parsed.rows;
};
