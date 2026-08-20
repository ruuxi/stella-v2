// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { buildContextMessageMetadata } from "@/features/chat/hooks/use-streaming-chat-core";

describe("buildContextMessageMetadata", () => {
  it("persists the Ask Stella / quoted selection onto the optimistic message", () => {
    const metadata = buildContextMessageMetadata(null, "Selected sentence to quote");
    expect(metadata?.context?.quotedText).toBe("Selected sentence to quote");
  });

  it("falls back to chatContext.selectedText when no explicit selection is passed", () => {
    const metadata = buildContextMessageMetadata(
      { selectedText: "From chat context" } as never,
      null,
    );
    expect(metadata?.context?.quotedText).toBe("From chat context");
  });

  it("bounds the stored quoted preview to 4000 chars", () => {
    const long = "x".repeat(5_000);
    const metadata = buildContextMessageMetadata(null, long);
    expect(metadata?.context?.quotedText).toHaveLength(4_000);
  });

  it("returns the base metadata untouched when there is no context to attach", () => {
    expect(buildContextMessageMetadata(null, null)).toBeUndefined();
    expect(buildContextMessageMetadata(null, "   ")).toBeUndefined();
    const base = { context: { windowLabel: "Safari" } };
    expect(buildContextMessageMetadata(null, null, base)).toBe(base);
  });

  it("keeps the quoted selection alongside other composer context", () => {
    const metadata = buildContextMessageMetadata(
      { activity: { id: "a1", label: "Build task" } } as never,
      "Quoted bit",
    );
    expect(metadata?.context?.activityLabel).toBe("Build task");
    expect(metadata?.context?.quotedText).toBe("Quoted bit");
  });
});
