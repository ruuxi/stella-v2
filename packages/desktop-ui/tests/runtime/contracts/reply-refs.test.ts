import { describe, expect, it } from "vitest";
import {
  appendMessageRefTag,
  formatMessageRefTag,
  splitReplyRefs,
  stripMessageRefTag,
  toReplyPreview,
} from "@stella/contracts/reply-refs";

describe("splitReplyRefs", () => {
  it("strips a trailing refs fence and parses message and agent lines", () => {
    const text = [
      "Pricing research is done. Three vendors publish rates.",
      "",
      "```refs",
      "#142",
      "agent:pricing-research",
      "```",
    ].join("\n");
    expect(splitReplyRefs(text)).toEqual({
      text: "Pricing research is done. Three vendors publish rates.",
      refs: [
        { kind: "message", sequence: 142 },
        { kind: "agent", threadId: "pricing-research" },
      ],
    });
  });

  it("accepts tilde fences, bullets, bare thread ids, and trailing whitespace", () => {
    const text =
      "Done.\n\n~~~refs\n- #7\n* thread_id: task-3\nresearch-notes\n~~~\n\n  ";
    expect(splitReplyRefs(text)).toEqual({
      text: "Done.",
      refs: [
        { kind: "message", sequence: 7 },
        { kind: "agent", threadId: "task-3" },
        { kind: "agent", threadId: "research-notes" },
      ],
    });
  });

  it("dedupes repeated targets and drops unparseable lines", () => {
    const text = "Ok\n```refs\n#5\n#5\nnot a ref!!\nagent:x\nagent:x\n```";
    expect(splitReplyRefs(text).refs).toEqual([
      { kind: "message", sequence: 5 },
      { kind: "agent", threadId: "x" },
    ]);
  });

  it("removes a malformed trailing block without failing the reply", () => {
    expect(splitReplyRefs("Reply\n```refs\n\n```")).toEqual({
      text: "Reply",
      refs: [],
    });
  });

  it("leaves a refs block quoted mid-message alone", () => {
    const text = "Use this:\n```refs\n#1\n```\nThen continue.";
    expect(splitReplyRefs(text)).toEqual({ text, refs: [] });
  });

  it("leaves ordinary code fences alone", () => {
    const text = "Here:\n```ts\nconst a = 1;\n```";
    expect(splitReplyRefs(text)).toEqual({ text, refs: [] });
  });
});

describe("message ref tag", () => {
  it("appends and strips the sequence tag", () => {
    const tagged = appendMessageRefTag("hello  \n", 12);
    expect(tagged).toBe(`hello\n\n${formatMessageRefTag(12)}`);
    expect(stripMessageRefTag(tagged)).toBe("hello");
    expect(stripMessageRefTag("no tag here")).toBe("no tag here");
  });

  it("does not tag an empty prompt", () => {
    expect(appendMessageRefTag("   ", 3)).toBe("   ");
  });
});

describe("toReplyPreview", () => {
  it("collapses markdown and reminders into a bounded single line", () => {
    const preview = toReplyPreview(
      "# Title\n\nSome **bold** text\n\n```ts\ncode\n```\n<system-reminder>3:04 PM</system-reminder>",
    );
    expect(preview).toBe("Title Some bold text");
    expect(toReplyPreview("x".repeat(400)).length).toBeLessThanOrEqual(160);
  });
});
