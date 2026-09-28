// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "@/app/chat/Markdown";
import {
  MAX_CACHED_MARKDOWN_CHARS,
  clearMarkdownRenderCache,
  getMarkdownRenderCacheStats,
} from "@/app/chat/markdown-render-cache";
import { withI18n } from "../../helpers/i18n";

const REPLY = [
  "## Heading with “quotes” — and a dash",
  "",
  "Some **bold**, _italic_, `code`, a [link](https://example.com) and a",
  "[quarterly-report.md](/Users/me/report.md).",
  "",
  "- one",
  "- two",
  "  - nested",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "<div>raw html</div>",
].join("\n");

const mountHtml = (node: React.ReactNode): string => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(withI18n(node)));
  const html = container.innerHTML;
  act(() => root.unmount());
  container.remove();
  return html;
};

/**
 * Streamdown resolves `processor.runSync` before its first `parse` freezes
 * the processor (which is when the cache hooks install), so the very first
 * render per plugin configuration is uncached. Warm each configuration once.
 */
const warm = (props: { hiddenFilePaths?: string[] } = {}) => {
  mountHtml(<Markdown text="warm-up" {...props} />);
  clearMarkdownRenderCache();
};

describe("markdown render cache", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    warm();
    warm({ hiddenFilePaths: ["local:/Users/me/report.md"] });
  });

  afterEach(() => {
    clearMarkdownRenderCache();
  });

  it("re-mounting a row reuses the parsed tree and renders identical markup", () => {
    const first = mountHtml(<Markdown text={REPLY} cacheKey="row-a" />);
    expect(getMarkdownRenderCacheStats()).toMatchObject({ hits: 0, misses: 1 });

    // A virtualized row scrolling back in: fresh instance, same text.
    const second = mountHtml(<Markdown text={REPLY} cacheKey="row-a" />);
    const third = mountHtml(<Markdown text={REPLY} cacheKey="row-b" />);

    expect(getMarkdownRenderCacheStats()).toMatchObject({ hits: 2, misses: 1 });
    expect(second).toBe(first);
    expect(third).toBe(first);
    // Guard against a Streamdown call-shape change silently emptying rows.
    expect(first).toContain("<table");
    expect(first).toContain("quarterly-report.md");
    expect(first).toContain("raw html");
  });

  it("keys on the options that change the tree", () => {
    const visible = mountHtml(<Markdown text={REPLY} />);
    const hidden = mountHtml(
      <Markdown
        text={REPLY}
        hiddenFilePaths={["local:/Users/me/report.md"]}
      />,
    );
    expect(getMarkdownRenderCacheStats().misses).toBe(2);
    expect(visible).toContain("quarterly-report.md");
    expect(hidden).not.toContain("quarterly-report.md");
  });

  it("bounds retained text", () => {
    const chunk = "word ".repeat(2_000);
    for (let index = 0; index < 60; index += 1) {
      mountHtml(<Markdown text={`${index} ${chunk}`} />);
    }
    const stats = getMarkdownRenderCacheStats();
    expect(stats.chars).toBeLessThanOrEqual(MAX_CACHED_MARKDOWN_CHARS);
    expect(stats.entries).toBeLessThan(60);
  });
});
