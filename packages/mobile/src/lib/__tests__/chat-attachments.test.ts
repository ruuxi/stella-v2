import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  appendAttachments,
  attachmentsSettled,
  CHAT_ATTACHMENT_MAX_COUNT,
  driveAttachmentPath,
  driveFileNameFor,
  isAttachmentReady,
  uploadChatAttachment,
  withAttachmentPreamble,
  withAttachmentStatus,
  type AttachmentUploadDeps,
  type ComposerAttachment,
  type PickedAttachment,
} from "../chat-attachments";

const PNG = new Uint8Array(
  new ArrayBuffer(16),
) as unknown as Uint8Array<ArrayBuffer>;
PNG.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const picked = (
  id: string,
  overrides: Partial<PickedAttachment> = {},
): PickedAttachment => ({
  id,
  uri: `file:///cache/${id}`,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: PNG.byteLength,
  kind: "image",
  ...overrides,
});

const uploading = (id: string): ComposerAttachment => ({
  ...picked(id),
  status: "uploading",
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * A drive that records what it was asked to do, so a test can assert the exact
 * two-step upload rather than just its result.
 */
const fakeDrive = (options: { putOk?: boolean; finalizeThrows?: boolean } = {}) => {
  const calls: string[] = [];
  const deps: AttachmentUploadDeps = {
    client: {
      action: (async (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as FunctionReference<"action">);
        calls.push(name.split(":").pop()!);
        if (name.endsWith("finalizeDriveUpload")) {
          if (options.finalizeThrows) throw new Error("Drive quota exceeded.");
          return {
            path: args.path,
            name: "receipt.png",
            sizeBytes: PNG.byteLength,
            contentType: "image/png",
            updatedAt: 0,
          };
        }
        return {
          path: args.path,
          uploadId: "upload-1",
          uploadUrl: "https://r2.example/put",
          contentType: String(args.contentType),
        };
      }) as AttachmentUploadDeps["client"]["action"],
    },
    readFile: async () => PNG,
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  };
  globalThis.fetch = (async () => ({
    ok: options.putOk !== false,
    status: options.putOk === false ? 503 : 200,
  })) as unknown as typeof fetch;
  return { calls, deps };
};

describe("a drive path for a picked file", () => {
  test("day-buckets under uploads/ and keeps the picked name", () => {
    expect(
      driveAttachmentPath({
        name: "Receipt.PNG",
        kind: "image",
        now: new Date("2026-08-29T23:59:59.000Z"),
        taken: new Set(),
      }),
    ).toBe("uploads/2026-08-29/Receipt.PNG");
  });

  test("suffixes rather than landing a second file on the first one's path", () => {
    const taken = new Set(["uploads/2026-08-29/a.png"]);
    const second = driveAttachmentPath({
      name: "a.png",
      kind: "image",
      now: new Date("2026-08-29T00:00:00.000Z"),
      taken,
    });
    expect(second).toBe("uploads/2026-08-29/a-2.png");
    taken.add(second);
    expect(
      driveAttachmentPath({
        name: "a.png",
        kind: "image",
        now: new Date("2026-08-29T00:00:00.000Z"),
        taken,
      }),
    ).toBe("uploads/2026-08-29/a-3.png");
  });

  test("reduces a picked name to something the drive index accepts", () => {
    expect(driveFileNameFor("../../etc/passwd", "file")).toBe("passwd");
    expect(driveFileNameFor("C:\\Users\\me\\note.txt", "file")).toBe("note.txt");
    expect(driveFileNameFor("  ", "image")).toBe("photo.jpg");
    expect(driveFileNameFor("..", "file")).toBe("file");
    expect(driveFileNameFor("a\u0000b.png", "image")).toBe("ab.png");
  });
});

describe("the turn budget", () => {
  test("reports the overflow instead of swallowing picks", () => {
    const current = Array.from({ length: CHAT_ATTACHMENT_MAX_COUNT - 1 }, (_, i) =>
      uploading(`have-${i}`),
    );
    const result = appendAttachments(current, [
      uploading("new-1"),
      uploading("new-2"),
    ]);
    expect(result.attachments).toHaveLength(CHAT_ATTACHMENT_MAX_COUNT);
    expect(result.rejected).toBe(1);
    expect(result.attachments.at(-1)?.id).toBe("new-1");
  });
});

describe("the prompt preamble", () => {
  test("names every path, which is what hydrates them into a cloud turn", () => {
    expect(
      withAttachmentPreamble("is this legal", [
        "uploads/2026-08-29/a.png",
        "uploads/2026-08-29/b.pdf",
      ]),
    ).toBe(
      "is this legal\n\nAttached in my drive:\n- uploads/2026-08-29/a.png\n- uploads/2026-08-29/b.pdf",
    );
  });

  test("leaves a text-only turn alone", () => {
    expect(withAttachmentPreamble("hello", [])).toBe("hello");
  });
});

describe("the two-step drive upload", () => {
  test("sends native file bytes directly without constructing an unsupported RN Blob", async () => {
    const { deps } = fakeDrive();
    const originalBlob = globalThis.Blob;
    let uploaded: unknown;
    globalThis.Blob = class {
      constructor() { throw new Error("Native Blob cannot accept ArrayBufferView"); }
    } as unknown as typeof Blob;
    try {
      await uploadChatAttachment(picked("native"), new Set(), {
        ...deps,
        fetch: async (_url, init) => {
          uploaded = init.body;
          return { ok: true, status: 200 };
        },
      });
      expect(uploaded).toBe(PNG);
    } finally {
      globalThis.Blob = originalBlob;
    }
  });

  test("claims a presigned PUT, sends the bytes, then records the row", async () => {
    const { calls, deps } = fakeDrive();
    const path = await uploadChatAttachment(picked("a"), new Set(), deps);
    expect(calls).toEqual(["prepareDriveUpload", "finalizeDriveUpload"]);
    expect(path).toBe("uploads/2026-08-29/a.png");
  });

  test("records the sniffed content type, not the picker's claim", async () => {
    const { deps } = fakeDrive();
    const declared: string[] = [];
    const client: AttachmentUploadDeps["client"] = {
      action: (async (reference: unknown, args: Record<string, unknown>) => {
        declared.push(String(args.contentType));
        return await deps.client.action(
          reference as never,
          args as never,
        );
      }) as AttachmentUploadDeps["client"]["action"],
    };
    // A HEIC that iOS labelled image/jpeg is the production case; here PNG
    // bytes under a jpeg label make the same point without a second fixture.
    await uploadChatAttachment(
      picked("a", { mimeType: "image/jpeg" }),
      new Set(),
      { ...deps, client },
    );
    expect(new Set(declared)).toEqual(new Set(["image/png"]));
  });
});

describe("an upload failure keeps the draft", () => {
  /**
   * The failure lands on the chip, never on the composer. Uploads start at pick
   * time, so there is no send in flight to unwind and nothing typed to restore:
   * the user retries the one file that broke and sends when it lands.
   */
  const failedChip = async (deps: AttachmentUploadDeps, chips: ComposerAttachment[]) => {
    try {
      await uploadChatAttachment(picked("broken"), new Set(), deps);
      throw new Error("the upload was expected to fail");
    } catch (error) {
      return withAttachmentStatus(chips, "broken", {
        status: "failed",
        message: error instanceof Error ? error.message : "Upload failed.",
      });
    }
  };

  test("a rejected PUT marks only its own chip and blocks the send", async () => {
    const { deps } = fakeDrive({ putOk: false });
    const chips = await failedChip(deps, [uploading("ok"), uploading("broken")]);
    expect(chips.map((chip) => chip.status)).toEqual(["uploading", "failed"]);
    expect(chips[1]).toMatchObject({ message: "Upload failed (503)." });
    expect(attachmentsSettled(chips)).toBe(false);
  });

  test("a rejected finalize surfaces the drive's own reason", async () => {
    const { deps } = fakeDrive({ finalizeThrows: true });
    const chips = await failedChip(deps, [uploading("broken")]);
    expect(chips[0]).toMatchObject({
      status: "failed",
      message: "Drive quota exceeded.",
    });
  });

  test("the failed chip survives so it can be retried, and retry can succeed", async () => {
    const { deps: failing } = fakeDrive({ putOk: false });
    let chips = await failedChip(failing, [uploading("broken")]);
    expect(chips).toHaveLength(1);

    chips = withAttachmentStatus(chips, "broken", { status: "uploading" });
    const { deps: working } = fakeDrive();
    const drivePath = await uploadChatAttachment(
      picked("broken"),
      new Set(),
      working,
    );
    chips = withAttachmentStatus(chips, "broken", {
      status: "ready",
      drivePath,
    });
    expect(attachmentsSettled(chips)).toBe(true);
    expect(chips.filter(isAttachmentReady).map((chip) => chip.drivePath)).toEqual([
      "uploads/2026-08-29/broken.png",
    ]);
  });

  test("a chip the user removed while its upload ran is not resurrected", async () => {
    const chips = withAttachmentStatus([uploading("kept")], "removed", {
      status: "ready",
      drivePath: "uploads/2026-08-29/removed.png",
    });
    expect(chips.map((chip) => chip.id)).toEqual(["kept"]);
    expect(chips[0]?.status).toBe("uploading");
  });
});
