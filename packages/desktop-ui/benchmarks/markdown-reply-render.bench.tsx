// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterAll, beforeAll, bench, describe, expect } from "vitest";

import { Markdown } from "../src/app/chat/Markdown";
import {
  clearMarkdownRenderCache,
  getMarkdownRenderCacheStats,
} from "../src/app/chat/markdown-render-cache";
import { MAX_MARKDOWN_PARSE_CHARS } from "../src/features/chat/streaming/markdown-chunks";
import { withI18n } from "../tests/helpers/i18n";

/**
 * Replies arrive whole, so the per-reply markdown cost is paid once per row
 * mount: when the reply lands and every time a virtualized row scrolls back
 * into the draw window. The parse is cached across mounts
 * (`markdown-render-cache`), so a remount only converts the cached tree to
 * React elements and renders them.
 */
const section = (index: number) =>
  [
    `## Step ${index}`,
    "",
    `Here is what changed in **step ${index}** — it touches the “renderer” and [the docs](https://example.com/${index}).`,
    "",
    `- first item with \`inline code\` and *emphasis*`,
    `- second item that wraps across a longer line of prose to look like a real reply`,
    `  - a nested item`,
    "",
    "```ts",
    `export const step${index} = (value: number): number => {`,
    "  // em dashes and curly quotes — “like these” — appear in code comments too",
    `  return value * ${index};`,
    "};",
    "```",
    "",
    "| Column | Value |",
    "| --- | --- |",
    `| alpha | ${index} |`,
    `| beta | ${index * 2} |`,
    "",
  ].join("\n");

const buildReply = (length: number) => {
  let text = "";
  for (let index = 1; text.length < length; index += 1) text += section(index);
  return text.slice(0, length);
};

const SMALL = buildReply(1_500);
const MEDIUM = buildReply(5_000);
const LARGE = buildReply(MAX_MARKDOWN_PARSE_CHARS - 500);

let renderId = 0;
const mountOnce = (node: (key: string) => React.ReactNode) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const key = `markdown-reply-bench-${renderId++}`;
  flushSync(() => root.render(withI18n(node(key))));
  const html = container.innerHTML;
  flushSync(() => root.unmount());
  return html;
};

const mountCurrent = (text: string) =>
  mountOnce((key) => <Markdown text={text} cacheKey={key} />);

const options = {
  iterations: 20,
  time: 0,
  warmupIterations: 3,
  warmupTime: 0,
};

describe("whole-reply markdown mount", () => {
  beforeAll(() => {
    document.documentElement.dataset.reduceMotion = "no-preference";
    for (const text of [SMALL, MEDIUM, LARGE]) {
      const cold = mountCurrent(text);
      expect(cold.length).toBeGreaterThan(text.length / 2);
      expect(mountCurrent(text)).toBe(cold);
    }
    expect(getMarkdownRenderCacheStats().hits).toBeGreaterThan(0);
  });

  afterAll(() => {
    delete document.documentElement.dataset.reduceMotion;
  });

  // Cold: first time this text is shown (reply lands, or cache evicted).
  bench("1.5k reply: cold mount", () => {
    clearMarkdownRenderCache();
    mountCurrent(SMALL);
  }, options);
  // Warm: the same row scrolling back into the virtualized draw window.
  bench("1.5k reply: remount", () => {
    mountCurrent(SMALL);
  }, options);
  bench("5k reply: cold mount", () => {
    clearMarkdownRenderCache();
    mountCurrent(MEDIUM);
  }, options);
  bench("5k reply: remount", () => {
    mountCurrent(MEDIUM);
  }, options);
  bench("11.5k reply: cold mount", () => {
    clearMarkdownRenderCache();
    mountCurrent(LARGE);
  }, options);
  bench("11.5k reply: remount", () => {
    mountCurrent(LARGE);
  }, options);
});
