import { describe, expect, it } from "vitest";
import { isDisplayReadPathInLocalChatFiles } from "@stella/desktop/electron/ipc/display-handlers.js";
import type { LocalChatEventRecord } from "@stella/runtime/kernel/storage/shared";

describe("mobile display read file policy", () => {
  it("allows paths linked in recent assistant responses", () => {
    const events: LocalChatEventRecord[] = [
      {
        _id: "event-1",
        timestamp: 1_000,
        type: "assistant_message",
        payload: {
          text: "[original](/repo/src/original.ts) [moved](/repo/src/moved.ts)",
        },
      },
      {
        _id: "event-2",
        timestamp: 2_000,
        type: "agent-completed",
        payload: {
          result: "[report](/repo/out/report.pdf)",
        },
      },
    ];

    expect(
      isDisplayReadPathInLocalChatFiles(events, "/repo/src/original.ts"),
    ).toBe(true);
    expect(isDisplayReadPathInLocalChatFiles(events, "/repo/src/moved.ts")).toBe(
      true,
    );
    expect(
      isDisplayReadPathInLocalChatFiles(events, "/repo/out/report.pdf"),
    ).toBe(true);
  });

  it("rejects paths that were touched but not linked", () => {
    const events: LocalChatEventRecord[] = [
      {
        _id: "event-1",
        timestamp: 1_000,
        type: "tool_result",
        payload: {
          fileChanges: [
            { path: "/repo/src/deleted.ts", kind: { type: "delete" } },
          ],
        },
      },
    ];

    expect(isDisplayReadPathInLocalChatFiles(events, "/repo/src/deleted.ts")).toBe(
      false,
    );
    expect(isDisplayReadPathInLocalChatFiles(events, "/Users/rahul/.ssh/id_rsa"))
      .toBe(false);
  });
});
