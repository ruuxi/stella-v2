import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const chatPane = readFileSync(
  resolve(__dirname, "../../components/ChatPane.tsx"),
  "utf8",
);

describe("assistant message boundary rendering", () => {
  test("renders the complete assistant body instead of slicing at event offsets", () => {
    expect(chatPane).toContain("renderAssistantMarkdown(item.text)");
    expect(chatPane.includes("item.text.slice(")).toBe(false);
    expect(chatPane.includes("renderTextWithInlineTimeline")).toBe(false);
  });

  test("selects assistant text on the rendered markdown without a plain-text fallback", () => {
    // Assistant text arrives whole, so selection is never gated on a partial
    // render window — the markdown is always selectable.
    expect(chatPane).toContain("        selectable\n");
    expect(chatPane.includes("selectable={!isStreaming}")).toBe(false);
    expect(chatPane.match(/<AssistantTextSelection/g)).toHaveLength(1);
  });

  test("wraps assistant message text — and only the text — in the assistant bubble", () => {
    const bubbles = [...chatPane.matchAll(
      /<MorphingAssistantBubble\b([^>]*?)>([\s\S]*?)<\/MorphingAssistantBubble>/g,
    )];
    expect(bubbles).toHaveLength(1);
    const [, attributes, body] = bubbles[0]!;
    expect(attributes).toContain("styles.assistantBubble");
    expect(attributes).toContain("animate={animate || mountedEmptyRef.current}");
    expect(body.trim()).toBe("{renderAssistantMarkdown(item.text)}");
    // Artifacts, tool traces and row actions stay outside the bubble.
    expect(/<\/MorphingAssistantBubble>\s*\) : null}\s*{toolActivity \? \(/.test(chatPane)).toBe(true);
  });

  test("keeps every agent activity artifact in the boundary group", () => {
    expect(chatPane).toContain(
      "const groupAgentWorkArtifacts = agentWorkArtifacts;",
    );
    expect(chatPane.includes("inlineAgentCards")).toBe(false);
  });
});
