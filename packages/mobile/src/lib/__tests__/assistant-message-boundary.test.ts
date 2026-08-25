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
    expect(chatPane).toContain("selectable={!isStreaming}");
    expect(chatPane.match(/<AssistantTextSelection/g)).toHaveLength(1);
  });

  test("keeps every agent activity artifact in the boundary group", () => {
    expect(chatPane).toContain(
      "const groupAgentWorkArtifacts = agentWorkArtifacts;",
    );
    expect(chatPane.includes("inlineAgentCards")).toBe(false);
  });
});
