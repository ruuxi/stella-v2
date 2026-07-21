// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Markdown } from "@/app/chat/Markdown";

const MARKDOWN_CSS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/app/chat/markdown.css",
);

const SHORT_BLOCK = [
  "```ts",
  "const one = 1;",
  "const two = 2;",
  "console.log(one + two);",
  "```",
].join("\n");

const TALL_UNLABELLED_BLOCK = [
  "```",
  ...Array.from({ length: 14 }, (_, index) => `line ${index + 1}`),
  "```",
].join("\n");

const cssRuleBody = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};

describe("markdown fenced-code surface", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps Streamdown's outer chrome around one semantic code body", async () => {
    await act(async () => {
      root.render(
        <Markdown text={`${SHORT_BLOCK}\n\n${TALL_UNLABELLED_BLOCK}`} />,
      );
    });

    const cards = container.querySelectorAll('[data-streamdown="code-block"]');
    expect(cards).toHaveLength(2);

    const labelledHeader = cards[0]!.querySelector(
      '[data-streamdown="code-block-header"]',
    );
    expect(labelledHeader?.textContent).toBe("ts");
    expect(
      cards[0]!.querySelector('[data-streamdown="code-block-actions"]'),
    ).not.toBeNull();
    expect(
      cards[0]!.querySelector('button[title="Download file"]'),
    ).not.toBeNull();
    expect(cards[0]!.querySelector('button[title="Copy Code"]')).not.toBeNull();

    const unlabelledHeader = cards[1]!.querySelector(
      '[data-streamdown="code-block-header"]',
    );
    expect(unlabelledHeader).not.toBeNull();
    expect(unlabelledHeader?.textContent).toBe("");

    for (const card of cards) {
      const body = card.querySelector(
        ':scope > [data-streamdown="code-block-body"]',
      );
      expect(body).not.toBeNull();
      expect(body!.querySelector("pre > code")).not.toBeNull();
      expect(
        body!.querySelector('[data-streamdown="code-block-body"]'),
      ).toBeNull();
    }

    expect(cards[0]!.querySelector("pre")?.textContent).toContain(
      "console.log(one + two);",
    );
    expect(cards[1]!.querySelector("pre")?.textContent).toContain("line 14");
  });

  it("collapses only the redundant body frame and preserves the tinted pre contract", () => {
    const css = fs.readFileSync(MARKDOWN_CSS_PATH, "utf8");
    const bodyRule = cssRuleBody(
      css,
      '.markdown [data-streamdown="code-block-body"]',
    );

    expect(bodyRule).toContain("border: 0;");
    expect(bodyRule).toContain("border-radius: 0;");
    expect(bodyRule).toContain("outline: none;");
    expect(bodyRule).toContain("box-shadow: none;");
    expect(bodyRule).toContain("background: transparent;");
    expect(bodyRule).toContain("padding: 0;");

    const preRule = cssRuleBody(css, ".markdown pre,\n.markdown .shiki");
    expect(preRule).toContain("padding: 12px 16px;");
    expect(preRule).toContain("border-radius: var(--radius-md);");
    expect(preRule).toContain("background-color: var(--surface-inset);");
    expect(preRule).toContain("overflow-x: auto;");
  });
});
