import { describe, expect, test, vi } from "vitest";
import type { ConversationFileEntry } from "../../../src/features/workspace-display/derive-conversation-files";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { conversationFileOpenKind, useOpenConversationFile } from "../../../src/features/cloud/use-cloud-drive-open";

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

const openPayload = vi.hoisted(() => vi.fn());
vi.mock("@/features/workspace-display/open-payload", () => ({ openDisplayPayloadTab: openPayload }));
test("opens cloud files in the sidebar with their Drive source", async () => {
  const entry = fileEntry({ path: "reports/result.pdf", name: "result.pdf", sizeBytes: 100, contentType: "application/pdf" });
  let open!: ReturnType<typeof useOpenConversationFile>;
  function Probe() { open = useOpenConversationFile(); return null; }
  renderToString(createElement(Probe));
  expect(await open(entry)).toBe(true);
  expect(openPayload).toHaveBeenCalledWith({ ...entry.payload, cloudDrivePath: "reports/result.pdf" });
});
