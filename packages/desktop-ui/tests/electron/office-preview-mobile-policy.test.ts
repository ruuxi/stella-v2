import { describe, expect, it } from "vitest";
import {
  filterOfficePreviewSnapshotsForMobile,
  resolveOfficePreviewBinaryPath,
} from "@stella/desktop/electron/ipc/office-preview-handlers.js";
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
  it("uses the monorepo binary in development and the shipped resource in packaged apps", () => {
    const binary = "stella-office-darwin-arm64";
    expect(
      resolveOfficePreviewBinaryPath(
        "/repo",
        false,
        "/electron/resources",
        binary,
      ),
    ).toBe("/repo/packages/stella-office/bin/" + binary);
    expect(
      resolveOfficePreviewBinaryPath(
        "/App/Resources/app.asar",
        true,
        "/App/Resources",
        binary,
      ),
    ).toBe("/App/Resources/stella-office/bin/" + binary);
  });
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
