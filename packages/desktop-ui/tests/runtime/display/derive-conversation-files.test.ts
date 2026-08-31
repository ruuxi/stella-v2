import { describe, expect, it } from "vitest";
import { deriveConversationFiles } from "../../../src/features/workspace-display/derive-conversation-files";
import type { EventRecord } from "../../../src/features/chat/lib/event-transforms";

const event = (
  type: EventRecord["type"],
  payload: EventRecord["payload"],
  timestamp = 1,
): EventRecord => ({ _id: `${type}-${timestamp}`, type, timestamp, payload });

describe("deriveConversationFiles", () => {
  it("derives files from ordinary absolute Markdown links in assistant responses", () => {
    const files = deriveConversationFiles([
      event("assistant_message", {
        text: "Created [report](/Users/me/report.pdf) and [notes](</Users/me/My Notes.md>).",
      }),
    ]);

    expect(files.map((entry) => entry.path)).toEqual([
      "/Users/me/report.pdf",
      "/Users/me/My Notes.md",
    ]);
  });

  it("derives delegated files only from agent completion result links", () => {
    const files = deriveConversationFiles([
      event("tool_result", {
        agentId: "a1",
        fileChanges: [{ path: "/tmp/intermediate.png", kind: { type: "add" } }],
      }),
      event(
        "agent-completed",
        {
          agentId: "a1",
          result: "Final video: [demo](/Users/me/demo.mp4)",
          producedFiles: Array.from({ length: 1_000 }, (_, index) => ({
            path: `/tmp/frame-${index}.png`,
            kind: { type: "add" },
          })),
        },
        2,
      ),
    ]);

    expect(files.map((entry) => entry.path)).toEqual(["/Users/me/demo.mp4"]);
  });

  it("ignores bare paths and remote links", () => {
    expect(
      deriveConversationFiles([
        event("assistant_message", {
          text: "Bare /tmp/a.pdf and [remote](https://example.com/a.pdf)",
        }),
      ]),
    ).toEqual([]);
  });

});
