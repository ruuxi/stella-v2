import { describe, expect, test } from "bun:test";
import type { MarkdownNode } from "react-native-nitro-markdown";
import {
  estimateMarkdownTableColumnWidths,
  extractMarkdownTable,
  fitMarkdownTableColumnWidths,
} from "../markdown-table-layout";

const cell = (content: string, align?: string): MarkdownNode => ({
  type: "table_cell",
  align,
  children: [{ type: "text", content }],
});

const table: MarkdownNode = {
  type: "table",
  children: [
    {
      type: "table_head",
      children: [
        {
          type: "table_row",
          children: [cell("route"), cell("duration", "right")],
        },
      ],
    },
    {
      type: "table_body",
      children: [
        {
          type: "table_row",
          children: [
            cell("Phoenix to Flagstaff"),
            cell("2 hr 10 min", "right"),
          ],
        },
      ],
    },
  ],
};

describe("markdown table layout", () => {
  test("extracts headers, rows, and column alignment from the markdown AST", () => {
    const data = extractMarkdownTable(table);

    expect(data.headers).toHaveLength(2);
    expect(data.rows).toHaveLength(1);
    expect(data.alignments).toEqual([undefined, "right"]);
    expect(data.rows[0]?.[0]?.children?.[0]?.content).toBe(
      "Phoenix to Flagstaff",
    );
  });

  test("keeps content-based widths so a wide table can overflow horizontally", () => {
    const widths = estimateMarkdownTableColumnWidths(
      extractMarkdownTable(table),
    );

    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeGreaterThan(widths[1] ?? 0);
    expect(widths.every((width) => width >= 88 && width <= 280)).toBe(true);
  });

  test("fills a wider viewport but does not compress overflowing columns", () => {
    expect(fitMarkdownTableColumnWidths([100, 100], 300)).toEqual([150, 150]);
    expect(fitMarkdownTableColumnWidths([180, 180], 300)).toEqual([180, 180]);
  });
});
