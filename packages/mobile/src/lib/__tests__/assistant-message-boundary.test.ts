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

    expect(chatPane).toContain("        selectable\n");
    expect(chatPane.includes("selectable={!isStreaming}")).toBe(false);
    expect(chatPane.match(/<AssistantTextSelection/g)).toHaveLength(1);
  });

  test("wraps assistant message text — and only the text — in the assistant bubble", () => {
    expect(chatPane).toContain(
      "<AssistantBubble styles={styles} animate={mountedEmptyRef.current}>",
    );

    expect(chatPane).toContain("</AssistantBubble>\n      ) : null}\n      {toolActivity ? (");
  });

  test("keeps every agent activity artifact in the boundary group", () => {
    expect(chatPane).toContain(
      "const groupAgentWorkArtifacts = agentWorkArtifacts;",
    );
    expect(chatPane.includes("inlineAgentCards")).toBe(false);
  });
});
