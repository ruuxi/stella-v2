import { describe, expect, it } from "vitest";
import { filterOfficePreviewSnapshotsForMobile } from "@stella/desktop/electron/ipc/office-preview-handlers.js";
import type { OfficePreviewSnapshot } from "@stella/contracts/office-preview";
import type { LocalChatEventRecord } from "@stella/runtime/kernel/storage/shared";

const snapshot = (
  sessionId: string,
  sourcePath: string,
): OfficePreviewSnapshot => ({
  sessionId,
  title: sourcePath.split("/").pop() ?? sourcePath,
  sourcePath,
  format: "docx",
  startedAt: 1_000,
  updatedAt: 1_100,
  status: "ready",
  html: "<p>Preview</p>",
});

describe("mobile office preview policy", () => {
  it("limits mobile office preview snapshots to recent conversation files", () => {
    const events: LocalChatEventRecord[] = [
      {
        _id: "event-1",
        timestamp: 1_000,
        type: "assistant_message",
        payload: {
          text: "[report](/repo/report.docx)",
        },
      },
    ];

    expect(
      filterOfficePreviewSnapshotsForMobile(
        [
          snapshot("allowed", "/repo/report.docx"),
          snapshot("artifact", "/repo/existing-deck.pptx"),
          snapshot("deleted", "/repo/deleted.docx"),
          snapshot("unrelated", "/Users/rahul/private.docx"),
        ],
        {
          fileEvents: events,
          artifactPaths: new Set(["/repo/existing-deck.pptx"]),
        },
      ).map((entry) => entry.sessionId),
    ).toEqual(["allowed", "artifact"]);
  });
});
