// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Markdown } from "@/app/chat/Markdown";
import { AssistantMessageRow } from "@/app/chat/MessageRow";
import { MAX_MARKDOWN_PARSE_CHARS } from "@/features/chat/streaming/markdown-chunks";
import { withI18n } from "../../helpers/i18n";

const markdownStyles = readFileSync(
  path.join(process.cwd(), "src/app/chat/markdown.css"),
  "utf8",
);

const animatedWord = (container: HTMLElement, word: string) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-sd-animate]")).find(
    (element) => element.textContent?.trim() === word,
  );

describe("live Streamdown word animation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let style: HTMLStyleElement;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    document.documentElement.dataset.reduceMotion = "no-preference";
    style = document.createElement("style");
    style.textContent = markdownStyles;
    document.head.appendChild(style);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    style.remove();
    delete document.documentElement.dataset.reduceMotion;
  });

  const render = async (
    text: string,
    options: {
      animateStreamingWords?: boolean;
      mode?: "static" | "streaming";
    } = {},
  ) => {
    await act(async () => {
      root.render(
        withI18n(
          <Markdown
            text={text}
            mode={options.mode ?? "streaming"}
            animateStreamingWords={options.animateStreamingWords ?? true}
          />,
        ),
      );
    });
  };

  it("uses the native word-level blurIn timing only for newly streamed words", async () => {
    await render("Alpha beta");

    expect(
      animatedWord(container, "Alpha")?.style.getPropertyValue(
        "--sd-animation",
      ),
    ).toBe("sd-blurIn");
    expect(
      animatedWord(container, "Alpha")?.style.getPropertyValue("--sd-duration"),
    ).toBe("190ms");
    expect(
      animatedWord(container, "Alpha")?.style.getPropertyValue("--sd-easing"),
    ).toBe("ease-out");
    expect(
      animatedWord(container, "beta")?.style.getPropertyValue("--sd-delay"),
    ).toBe("20ms");

    await render("Alpha beta gamma");

    expect(
      animatedWord(container, "Alpha")?.style.getPropertyValue("--sd-duration"),
    ).toBe("0ms");
    expect(
      animatedWord(container, "beta")?.style.getPropertyValue("--sd-duration"),
    ).toBe("0ms");
    expect(
      animatedWord(container, "gamma")?.style.getPropertyValue("--sd-duration"),
    ).toBe("190ms");
  });

  it("drops animation wrappers at finalization without changing rendered content", async () => {
    const text =
      "Read [the docs](https://example.com), use `bun test`, and keep this table:\n\n" +
      "| Key | Value |\n| --- | --- |\n| answer | 42 |\n\n" +
      "```ts\nconst answer = 42;\n```\n\n" +
      "![preview](https://example.com/preview.png)\n\n" +
      "Open [the report](stella://file/tmp/report.pdf).";

    await render(text);
    expect(container.querySelector("[data-sd-animate]")).not.toBeNull();
    const link = container.querySelector('a[href="https://example.com/"]');
    const inlineCode = container.querySelector(
      '[data-streamdown="inline-code"]',
    );
    const table = container.querySelector("table");
    const image = container.querySelector('img[alt="preview"]');
    const stellaFile = container.querySelector(".markdown-stella-file");
    expect(link).not.toBeNull();
    expect(inlineCode?.textContent).toBe("bun test");
    expect(table).not.toBeNull();
    expect(image).not.toBeNull();
    expect(stellaFile?.textContent).toBe("the report");
    for (const structuredContent of [link, inlineCode, table, image]) {
      const animated = [
        ...(structuredContent?.matches("[data-sd-animate]")
          ? [structuredContent as HTMLElement]
          : []),
        ...Array.from(
          structuredContent?.querySelectorAll<HTMLElement>(
            "[data-sd-animate]",
          ) ?? [],
        ),
      ];
      expect(animated.length).toBeGreaterThan(0);
      for (const word of animated) {
        expect(getComputedStyle(word).animation).toBe("none");
      }
    }
    expect(stellaFile?.matches("[data-sd-animate]")).toBe(false);
    expect(stellaFile?.querySelector("[data-sd-animate]")).toBeNull();
    expect(
      container.querySelector('[data-streamdown="code-block-body"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-streamdown="code-block-body"] code')
        ?.textContent,
    ).toContain("const answer = 42;");
    expect(
      container.querySelector(
        '[data-streamdown="code-block-body"] [data-sd-animate]',
      ),
    ).toBeNull();
    const liveRoot = container.querySelector(".markdown");

    await render(text, { mode: "static", animateStreamingWords: false });

    expect(container.querySelector("[data-sd-animate]")).toBeNull();
    expect(container.querySelector("[data-sd-animate-marker]")).toBeNull();
    expect(
      container.querySelector('a[href="https://example.com/"]'),
    ).not.toBeNull();
    expect(container.querySelector("table")).not.toBeNull();
    expect(
      container.querySelector('[data-streamdown="code-block-body"] code')
        ?.textContent,
    ).toContain("const answer = 42;");
    expect(container.querySelector(".markdown")).toBe(liveRoot);
    expect(container.textContent).toContain(
      "Read the docs, use bun test, and keep this table:",
    );
  });

  it("omits native animation machinery when motion is reduced or not live", async () => {
    document.documentElement.dataset.reduceMotion = "reduce";
    await render("Reduced motion stream");
    expect(container.querySelector("[data-sd-animate]")).toBeNull();

    document.documentElement.dataset.reduceMotion = "no-preference";
    await render("Non-live streaming parse", { animateStreamingWords: false });
    expect(container.querySelector("[data-sd-animate]")).toBeNull();

    await render("Completed message", {
      mode: "static",
      animateStreamingWords: false,
    });
    expect(container.querySelector("[data-sd-animate]")).toBeNull();
  });

  it("animates the live assistant owner but not its fading handoff", async () => {
    const renderRow = async (isFadingOut: boolean) => {
      await act(async () => {
        root.render(
          withI18n(
            <AssistantMessageRow
              row={{
                kind: "assistant",
                id: "assistant-user-1-1",
                cacheKey: "assistant-user-1-1",
                text: "Live assistant words",
                isStreaming: true,
                ...(isFadingOut ? { isFadingOut: true } : {}),
              }}
              conversationId="conversation-1"
            />,
          ),
        );
      });
    };

    await renderRow(false);
    expect(animatedWord(container, "Live")).not.toBeUndefined();

    await renderRow(true);
    expect(container.querySelector("[data-sd-animate]")).toBeNull();
    expect(container.textContent).toContain("Live assistant words");
  });

  it("keeps a very large active stream on the existing plaintext fast path", async () => {
    const text = "large stream ".repeat(
      Math.ceil(MAX_MARKDOWN_PARSE_CHARS / "large stream ".length) + 1,
    );

    await render(text);

    expect(
      container.querySelector(".markdown--streaming-plaintext"),
    ).not.toBeNull();
    expect(container.querySelector("[data-sd-animate]")).toBeNull();
    expect(container.textContent).toBe(text);
  });
});
