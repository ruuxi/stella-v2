export const DELIMITED_PREVIEW_MAX_ROWS = 1_000;
export const DELIMITED_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export type DelimitedParseResult = {
  rows: string[][];
  hitLimit: boolean;
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
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      if (commitRow()) {
        return { rows, hitLimit: true };
      }
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (commitRow()) {
      return { rows, hitLimit: true };
    }
  }

  return { rows, hitLimit: false };
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
