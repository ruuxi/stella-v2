import { describe, expect, test } from "bun:test";
import {
  pdfArtifactFor,
  pdfFileName,
  renderMarkdownBody,
  renderPdfHtml,
  summarizePdf,
} from "../chat-pdf";
import { parseToolBlock, TOOL_BLOCK_CLOSE, TOOL_BLOCK_OPEN } from "../chat-tools";
import { isMobileDisplayPayload, parseChatArtifacts } from "../mobile-artifacts";

describe("pdfFileName", () => {
  test("slugifies a title into a safe .pdf name", () => {
    expect(pdfFileName("Trip Itinerary: Japan 2026!")).toBe(
      "trip-itinerary-japan-2026.pdf",
    );
  });

  test("prefers an explicit filename and strips a trailing .pdf", () => {
    expect(pdfFileName("Ignored", "Weekly Report.pdf")).toBe(
      "weekly-report.pdf",
    );
  });

  test("falls back to a default when nothing is usable", () => {
    expect(pdfFileName("   ")).toBe("document.pdf");
    expect(pdfFileName("!!!")).toBe("document.pdf");
  });
});

describe("renderMarkdownBody", () => {
  test("renders headings, emphasis, and lists", () => {
    const html = renderMarkdownBody(
      "# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
  });

  test("renders ordered lists and fenced code without transforming it", () => {
    const html = renderMarkdownBody("1. first\n2. second\n\n```\na = **b**\n```");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<pre><code>a = **b**</code></pre>");
  });

  test("renders pipe tables", () => {
    const html = renderMarkdownBody(
      "| Name | Qty |\n| --- | --- |\n| Apple | 3 |",
    );
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<td>Apple</td>");
    expect(html).toContain("<td>3</td>");
  });

  test("escapes HTML in the content", () => {
    const html = renderMarkdownBody("A <script>alert(1)</script> & co.");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; co.");
  });
});

describe("renderPdfHtml", () => {
  test("wraps the body in a full HTML document", () => {
    const doc = renderPdfHtml("Report", "# Report\n\nHello.");
    expect(doc).toContain("<!doctype html>");
    expect(doc).toContain("<h1>Report</h1>");
    expect(doc).toContain("<p>Hello.</p>");
  });
});

describe("pdf artifact + summary", () => {
  const payload = {
    kind: "pdf" as const,
    filePath: "trip-itinerary.pdf",
    title: "Trip Itinerary",
    localUri: "file:///cache/trip-itinerary.pdf",
    sizeBytes: 20480,
  };

  test("summary names the file and invites open/save/share", () => {
    const summary = summarizePdf(payload);
    expect(summary).toContain("Trip Itinerary");
    expect(summary).toContain("share");
  });

  test("artifact id keys off the local file uri", () => {
    const artifact = pdfArtifactFor(payload, "offline-chat");
    expect(artifact.id).toBe(
      "offline-chat:pdf:file:///cache/trip-itinerary.pdf",
    );
    expect(artifact.payload.kind).toBe("pdf");
  });

  test("the payload validates and round-trips through parseChatArtifacts", () => {
    expect(isMobileDisplayPayload(payload)).toBe(true);
    const parsed = parseChatArtifacts([payload], "offline-chat");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.payload).toMatchObject({
      kind: "pdf",
      localUri: "file:///cache/trip-itinerary.pdf",
      sizeBytes: 20480,
    });
  });

  test("rejects a pdf payload with a non-string localUri", () => {
    expect(
      isMobileDisplayPayload({ kind: "pdf", filePath: "x.pdf", localUri: 5 }),
    ).toBe(false);
  });
});

describe("pdf tool block parsing", () => {
  test("parses a pdf tool call with string content and hides the block", () => {
    const raw = `Here is your PDF.\n${TOOL_BLOCK_OPEN}\n{"tool":"pdf","title":"Notes","content":"# Notes\\n\\nBody"}\n${TOOL_BLOCK_CLOSE}`;
    const parsed = parseToolBlock(raw);
    expect(parsed.visibleText).toBe("Here is your PDF.");
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]).toMatchObject({
      tool: "pdf",
      title: "Notes",
      content: "# Notes\n\nBody",
    });
  });

  test("accepts array-of-lines content", () => {
    const raw = `${TOOL_BLOCK_OPEN}\n{"tool":"pdf","content":["# H","","para"]}\n${TOOL_BLOCK_CLOSE}`;
    const parsed = parseToolBlock(raw);
    expect(parsed.calls[0]).toMatchObject({
      tool: "pdf",
      content: "# H\n\npara",
    });
  });

  test("drops a pdf call with no content", () => {
    const raw = `${TOOL_BLOCK_OPEN}\n{"tool":"pdf","title":"Empty"}\n${TOOL_BLOCK_CLOSE}`;
    expect(parseToolBlock(raw).calls).toHaveLength(0);
  });
});
