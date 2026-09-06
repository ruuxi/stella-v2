import { describe, expect, test } from "bun:test";
import { markdownTextRuns } from "../selectable-markdown-runs";
const colors = { text: "#112233", accent: "#445566", muted: "#778899" };
const fonts = { sans: { regular: "Body", semiBold: "Bold" }, mono: { regular: "Code" } };
describe("selectable formatted markdown", () => {
  test("retains nested emphasis, links, inline code and line breaks without raw markup", () => {
    const runs = markdownTextRuns({ type: "paragraph", children: [
      { type: "text", content: "Choose " },
      { type: "bold", children: [{ type: "italic", children: [{ type: "text", content: "violet orbit" }] }] },
      { type: "soft_break" },
      { type: "link", href: "https://example.com", children: [{ type: "text", content: "the guide" }] },
      { type: "code_inline", content: "const value = 7" },
    ] }, colors, fonts);
    expect(runs.map((run) => run.text).join("")).toBe("Choose violet orbit the guideconst value = 7");
    expect(runs[1]).toMatchObject({ fontFamily: "Bold", italic: true });
    expect(runs[3]).toMatchObject({ href: "https://example.com", color: colors.accent });
    expect(runs[4]).toMatchObject({ fontFamily: "Code", text: "const value = 7" });
  });
  test("keeps code literal and preserves table-cell base styling", () => {
    expect(markdownTextRuns({ type: "code_block", content: "**literal**\nsecond line" }, colors, fonts, { fontFamily: "Code" })[0]).toMatchObject({ text: "**literal**\nsecond line", fontFamily: "Code" });
    expect(markdownTextRuns({ type: "table_cell", children: [{ type: "text", content: "Header" }] }, colors, fonts, { fontFamily: "Bold", fontSize: 12 })[0]).toMatchObject({ text: "Header", fontFamily: "Bold", fontSize: 12 });
  });
});
