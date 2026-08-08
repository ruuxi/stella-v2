import type { MarkdownNode } from "react-native-nitro-markdown";

export type MarkdownTableData = {
  headers: MarkdownNode[];
  rows: MarkdownNode[][];
  alignments: (string | undefined)[];
};

const MIN_COLUMN_WIDTH = 88;
const MAX_COLUMN_WIDTH = 280;
const APPROX_CHARACTER_WIDTH = 7;
const CELL_HORIZONTAL_PADDING = 24;
const WIDTH_STEP = 24;

export function extractMarkdownTable(node: MarkdownNode): MarkdownTableData {
  const headers: MarkdownNode[] = [];
  const rows: MarkdownNode[][] = [];
  const alignments: (string | undefined)[] = [];

  for (const section of node.children ?? []) {
    if (section.type === "table_head") {
      for (const row of section.children ?? []) {
        if (row.type !== "table_row") continue;
        for (const cell of row.children ?? []) {
          headers.push(cell);
          alignments.push(cell.align);
        }
      }
      continue;
    }

    if (section.type === "table_body") {
      for (const row of section.children ?? []) {
        if (row.type === "table_row") rows.push(row.children ?? []);
      }
    }
  }

  return { headers, rows, alignments };
}

function markdownNodeText(node: MarkdownNode): string {
  if (node.children?.length) {
    return node.children.map(markdownNodeText).join("");
  }
  return node.content ?? "";
}

export function estimateMarkdownTableColumnWidths(
  data: MarkdownTableData,
): number[] {
  return data.headers.map((header, columnIndex) => {
    let longestText = markdownNodeText(header).trim().length;
    for (const row of data.rows) {
      const cell = row[columnIndex];
      if (cell) {
        longestText = Math.max(
          longestText,
          markdownNodeText(cell).trim().length,
        );
      }
    }

    const estimated =
      longestText * APPROX_CHARACTER_WIDTH + CELL_HORIZONTAL_PADDING;
    const stepped = Math.ceil(estimated / WIDTH_STEP) * WIDTH_STEP;
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, stepped));
  });
}

/**
 * Fill the viewport when a table is narrow, but preserve intrinsic column
 * widths when it is wide so the horizontal scroller has real overflow.
 */
export function fitMarkdownTableColumnWidths(
  widths: number[],
  viewportWidth: number,
): number[] {
  if (widths.length === 0 || viewportWidth <= 0) return widths;
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  if (totalWidth >= viewportWidth) return widths;

  const extraPerColumn = (viewportWidth - totalWidth) / widths.length;
  return widths.map((width) => width + extraPerColumn);
}
