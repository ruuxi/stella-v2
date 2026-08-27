import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterAll, beforeAll, bench, describe, expect } from "vitest";

import { Markdown } from "../src/app/chat/Markdown";
import { MAX_MARKDOWN_PARSE_CHARS } from "../src/features/chat/streaming/markdown-chunks";
import { withI18n } from "../tests/helpers/i18n";

const buildMarkdown = (length: number) => {
  const paragraph =
    "A streamed paragraph with **formatting**, [a link](https://example.com), and enough words to exercise native animation.\n\n";
  return paragraph
    .repeat(Math.ceil(length / paragraph.length))
    .slice(0, length);
};

const growingCommits = (text: string, count: number) =>
  Array.from({ length: count }, (_, index) =>
    text.slice(0, Math.ceil((text.length * (index + 1)) / count)),
  );

const fastBatchedCommits = growingCommits(
  buildMarkdown(MAX_MARKDOWN_PARSE_CHARS - 500),
  48,
);
const veryLargeCommits = growingCommits(
  buildMarkdown(MAX_MARKDOWN_PARSE_CHARS * 10),
  40,
);

let renderId = 0;
const renderActiveStream = (
  commits: string[],
  animateStreamingWords: boolean,
) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const cacheKey = `streamdown-animation-bench-${renderId++}`;
  for (const text of commits) {
    flushSync(() => {
      root.render(
        withI18n(
          <Markdown
            text={text}
            cacheKey={cacheKey}
            mode="streaming"
            animateStreamingWords={animateStreamingWords}
          />,
        ),
      );
    });
  }
  const result = {
    animatedWords: container.querySelectorAll("[data-sd-animate]").length,
    usedPlaintextPath: Boolean(
      container.querySelector(".markdown--streaming-plaintext"),
    ),
  };
  flushSync(() => root.unmount());
  return result;
};

const options = {
  iterations: 3,
  time: 0,
  warmupIterations: 1,
  warmupTime: 0,
};

describe("Streamdown live word animation", () => {
  beforeAll(() => {
    document.documentElement.dataset.reduceMotion = "no-preference";
    expect(
      renderActiveStream([fastBatchedCommits.at(-1)!], true).animatedWords,
    ).toBeGreaterThan(0);
    const large = renderActiveStream([veryLargeCommits.at(-1)!], true);
    expect(large.usedPlaintextPath).toBe(true);
    expect(large.animatedWords).toBe(0);
  });

  afterAll(() => {
    delete document.documentElement.dataset.reduceMotion;
  });

  bench(
    "48 fast-batched active commits with native word animation",
    () => renderActiveStream(fastBatchedCommits, true),
    options,
  );

  bench(
    "48 fast-batched active commits without native word animation",
    () => renderActiveStream(fastBatchedCommits, false),
    options,
  );

  bench(
    "40 active commits growing to 120k on the existing plaintext bound",
    () => renderActiveStream(veryLargeCommits, true),
    options,
  );
});
