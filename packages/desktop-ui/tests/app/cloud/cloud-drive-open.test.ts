import { describe, expect, test } from "vitest";
import type { ConversationFileEntry } from "../../../src/features/workspace-display/derive-conversation-files";
import { conversationFileOpenKind } from "../../../src/features/cloud/use-cloud-drive-open";

const fileEntry = (
  cloudDriveFile?: ConversationFileEntry["cloudDriveFile"],
): ConversationFileEntry =>
  ({
    path: cloudDriveFile?.path ?? "/tmp/local.txt",
    timestamp: 1,
    payload: {
      kind: "media",
      asset: {
        kind: "download",
        filePath: cloudDriveFile?.path ?? "/tmp/local.txt",
        label: cloudDriveFile?.name ?? "local.txt",
      },
      createdAt: 1,
    },
    ...(cloudDriveFile ? { cloudDriveFile } : {}),
  }) as ConversationFileEntry;

describe("conversation file open authority", () => {
  test("keeps local files on the display-payload path", () => {
    expect(conversationFileOpenKind(fileEntry())).toBe("local");
  });

  test("resolves stored Drive files through an owner-scoped signed URL", () => {
    expect(
      conversationFileOpenKind(
        fileEntry({
          path: "reports/result.pdf",
          name: "result.pdf",
          sizeBytes: 100,
          contentType: "application/pdf",
        }),
      ),
    ).toBe("cloud-signed-url");
  });

  test("rejects cloud metadata that explicitly says the bytes were not stored", () => {
    expect(
      conversationFileOpenKind(
        fileEntry({
          path: "workspace/large-output.zip",
          name: "large-output.zip",
          sizeBytes: 1_000_000,
          contentType: "application/zip",
          stored: false,
        }),
      ),
    ).toBe("cloud-not-stored");
  });
});
