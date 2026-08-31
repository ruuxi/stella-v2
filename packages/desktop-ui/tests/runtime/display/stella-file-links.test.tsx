import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown, defaultRemarkPlugins } from "streamdown";
import {
  displayPayloadForStellaFile,
  parseStellaFileUrl,
  remarkStellaFileLinks,
  STELLA_FILE_TAG,
  STELLA_FILE_TAG_ATTRIBUTES,
} from "../../../src/features/chat/lib/stella-file-links";
import { StellaFileLink } from "../../../src/app/chat/StellaFileLink";
import { withI18n } from "../../helpers/i18n";

describe("parseStellaFileUrl", () => {
  it("accepts ordinary absolute Markdown destinations", () => {
    expect(parseStellaFileUrl("/Users/sam/report.pdf")).toBe(
      "/Users/sam/report.pdf",
    );
    expect(parseStellaFileUrl("C:/Users/sam/report.pdf")).toBe(
      "C:/Users/sam/report.pdf",
    );
  });

  it("decodes percent-encoded segments", () => {
    expect(parseStellaFileUrl("/Users/sam/My%20File.pdf")).toBe(
      "/Users/sam/My File.pdf",
    );
  });

  it("rejects other stella deep links and malformed refs", () => {
    expect(parseStellaFileUrl("stella://join/ABC123")).toBeNull();
    expect(parseStellaFileUrl("stella://filesystem/x")).toBeNull();
    expect(parseStellaFileUrl("stella://file")).toBeNull();
    expect(parseStellaFileUrl("stella://file/")).toBeNull();
    expect(parseStellaFileUrl("https://example.com/a.pdf")).toBeNull();
  });
});

describe("displayPayloadForStellaFile", () => {
  it("routes viewable types to their in-app viewer payloads", () => {
    expect(displayPayloadForStellaFile("/tmp/a.pdf", 1)).toMatchObject({
      kind: "pdf",
      filePath: "/tmp/a.pdf",
    });
    expect(displayPayloadForStellaFile("/tmp/demo.mp4", 1)).toMatchObject({
      kind: "media",
      asset: { kind: "video", filePath: "/tmp/demo.mp4" },
    });
    expect(displayPayloadForStellaFile("/tmp/pic.png", 1)).toMatchObject({
      kind: "media",
      asset: { kind: "image", filePaths: ["/tmp/pic.png"] },
    });
    expect(displayPayloadForStellaFile("/tmp/notes.md", 1)).toMatchObject({
      kind: "markdown",
      filePath: "/tmp/notes.md",
    });
  });

  it("opens ANY html file as a canvas, not just outputs-tree html", () => {
    expect(
      displayPayloadForStellaFile("/Users/sam/site/index.html", 1),
    ).toMatchObject({
      kind: "canvas-html",
      filePath: "/Users/sam/site/index.html",
    });
    expect(
      displayPayloadForStellaFile(
        "/Users/sam/.stella/outputs/html/city-guide.html",
        1,
      ),
    ).toMatchObject({ kind: "canvas-html", slug: "city-guide" });
  });

  it("returns null for types with no in-app viewer (external fallback)", () => {
    expect(displayPayloadForStellaFile("/tmp/archive.zip", 1)).toBeNull();
    expect(displayPayloadForStellaFile("/tmp/no-extension", 1)).toBeNull();
  });
});

describe("stella-file chat rendering round-trip", () => {

  const render = (markdown: string) =>
    renderToStaticMarkup(
      withI18n(
        createElement(
          Streamdown,
          {
            remarkPlugins: [
              ...Object.values(defaultRemarkPlugins),
              remarkStellaFileLinks,
            ],
            components: { [STELLA_FILE_TAG]: StellaFileLink },
            allowedTags: {
              [STELLA_FILE_TAG]: [...STELLA_FILE_TAG_ATTRIBUTES],
            },
            linkSafety: { enabled: false },
            codeBlockMaxHeight: Number.POSITIVE_INFINITY,
            tableMaxHeight: Number.POSITIVE_INFINITY,
          },
          markdown,
        ),
      ),
    );

  it("renders an ordinary absolute-path Markdown link", () => {
    const html = render("Here's [the report](/Users/sam/report.pdf).");
    expect(html).toContain("markdown-stella-file");
    expect(html).toContain(">the report</a>");
    expect(html).toContain("/Users/sam/report.pdf");
  });

  it("renders an angle-bracket destination containing spaces", () => {
    const html = render("Here's [the report](</Users/sam/My Reports/final report.pdf>).");
    expect(html).toContain("markdown-stella-file");
    expect(html).toContain("/Users/sam/My Reports/final report.pdf");
  });

  it("leaves invalid references as plain text", () => {
    const html = render("A busted link: [x](stella://file/) here.");
    expect(html).not.toContain("markdown-stella-file");
  });

  it("does not rewrite references inside code spans", () => {
    const html = render("Use `[report](/Users/sam/a.pdf)` as the format.");
    expect(html).not.toContain("markdown-stella-file");
    expect(html).toContain("[report](/Users/sam/a.pdf)");
  });

  it("keeps normal links untouched", () => {
    const html = render("See [docs](https://example.com/docs).");
    expect(html).toContain('href="https://example.com/docs"');
  });

  it("keeps code blocks and tables unbounded", () => {
    const html = render(
      "```ts\nconst answer = 42;\n```\n\n| Key | Value |\n| --- | --- |\n| answer | 42 |",
    );

    expect(html).toContain('data-streamdown="code-block-body"');
    expect(html).toContain('data-streamdown="table-wrapper"');
    expect(html).not.toContain("max-height:");
  });
});
