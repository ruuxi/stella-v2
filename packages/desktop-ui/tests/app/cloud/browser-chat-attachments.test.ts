import { beforeEach, describe, expect, test, vi } from "vitest";

const action = vi.fn();
vi.mock("@/platform/convex/convex-client", () => ({
  convexClient: { action },
}));

class SuccessfulUploadRequest {
  status = 200;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  send(file: File) {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: file.size,
      total: file.size,
    } as ProgressEvent);
    queueMicrotask(() => {
      this.onload?.();
      this.onloadend?.();
    });
  }
  abort() {
    this.onabort?.();
    this.onloadend?.();
  }
}

describe("browser chat attachments", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("XMLHttpRequest", SuccessfulUploadRequest);
    const { browserAttachmentUploads } =
      await import("../../../src/features/cloud/browser-chat-attachments");
    for (const entry of browserAttachmentUploads.getSnapshot()) {
      browserAttachmentUploads.remove(entry.id);
    }
  });

  test("sanitizes a bounded Cloud Drive attachment path", async () => {
    const { browserAttachmentDrivePath } =
      await import("../../../src/features/cloud/browser-chat-attachments");
    expect(
      browserAttachmentDrivePath(
        { name: "../../quarter/report.png" },
        "upload-123456789",
        new Date("2026-08-31T12:00:00Z"),
      ),
    ).toBe("/Chat Attachments/2026-08-31/23456789-quarter-report.png");
  });

  test("prepares, uploads, finalizes, and only then exposes the immutable path", async () => {
    action
      .mockResolvedValueOnce({
        path: "/Chat Attachments/2026-08-31/image.png",
        uploadId: "upload-id",
        uploadUrl: "https://r2.example/put",
        contentType: "image/png",
      })
      .mockResolvedValueOnce({
        path: "/Chat Attachments/2026-08-31/image.png",
        name: "image.png",
        sizeBytes: 3,
        contentType: "image/png",
        updatedAt: 1,
      });
    const {
      browserAttachmentUploads,
      hasPendingCloudAttachmentUploads,
      waitForCloudAttachmentUploads,
    } = await import("../../../src/features/cloud/browser-chat-attachments");
    const { cloudAttachmentsStore } =
      await import("../../../src/features/cloud/cloud-composer-store");
    browserAttachmentUploads.add([
      new File([new Uint8Array([1, 2, 3])], "image", { type: "image/png" }),
    ]);
    expect(hasPendingCloudAttachmentUploads()).toBe(true);
    expect(cloudAttachmentsStore.getSnapshot()).toEqual([]);
    const ready = waitForCloudAttachmentUploads();
    await vi.waitFor(() => {
      expect(browserAttachmentUploads.getSnapshot()[0]?.status).toBe("ready");
    });
    await ready;
    expect(cloudAttachmentsStore.getSnapshot()).toEqual([
      expect.objectContaining({
        path: "/Chat Attachments/2026-08-31/image.png",
        contentType: "image/png",
      }),
    ]);
    expect(hasPendingCloudAttachmentUploads()).toBe(false);
  });

  test("reports an oversized file without starting an upload", async () => {
    const { BROWSER_ATTACHMENT_MAX_BYTES, browserAttachmentUploads } =
      await import("../../../src/features/cloud/browser-chat-attachments");
    browserAttachmentUploads.add([
      {
        name: "too-large.zip",
        size: BROWSER_ATTACHMENT_MAX_BYTES + 1,
        type: "application/zip",
      } as File,
    ]);
    expect(browserAttachmentUploads.getSnapshot()[0]).toMatchObject({
      status: "error",
      error: "This file is larger than 20 MB.",
    });
    expect(action).not.toHaveBeenCalled();
  });

  test("creates and releases a local thumbnail URL for images", async () => {
    const createObjectURL = vi.fn(() => "blob:local-thumbnail");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const { browserAttachmentUploads } =
      await import("../../../src/features/cloud/browser-chat-attachments");
    browserAttachmentUploads.add([
      new File([new Uint8Array([1])], "photo.jpg", { type: "image/jpeg" }),
    ]);
    const entry = browserAttachmentUploads.getSnapshot()[0];
    expect(entry?.previewUrl).toBe("blob:local-thumbnail");
    expect(createObjectURL).toHaveBeenCalledOnce();
    browserAttachmentUploads.remove(entry!.id);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:local-thumbnail");
  });

  test("resizes an oversized image before it is uploaded", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 6000, height: 4000, close }),
    );
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (callback: (blob: Blob) => void) =>
          callback(
            new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
          ),
      })),
    });
    const { resizeOversizedBrowserImage } =
      await import("../../../src/features/cloud/browser-chat-attachments");
    const resized = await resizeOversizedBrowserImage({
      name: "camera.png",
      size: 21 * 1024 * 1024,
      type: "image/png",
      lastModified: 123,
    } as File);
    expect(resized).toMatchObject({
      name: "camera.webp",
      size: 3,
      type: "image/webp",
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
