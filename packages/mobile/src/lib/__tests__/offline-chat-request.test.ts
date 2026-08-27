import { describe, expect, test } from "bun:test";

import {
  appendOfflineChatAttachments,
  buildOfflineChatRequest,
  MAX_OFFLINE_CHAT_IMAGE_BASE64_CHARS,
  MAX_OFFLINE_CHAT_IMAGES,
  prepareOfflineChatImages,
} from "../offline-chat-request";

const PNG_BASE64 = Buffer.from(
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
).toString("base64");

const expectRejection = async (promise: Promise<unknown>, message: string) => {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    expect(error instanceof Error).toBe(true);
    expect((error as Error).message).toContain(message);
  }
};

describe("normal mobile chat image request", () => {
  test("normalizes picked images and serializes the exact backend request shape", async () => {
    const images = await prepareOfflineChatImages([
      {
        uri: "file:///photo.png",
        base64: PNG_BASE64,
        mimeType: "image/png",
      },
    ]);
    const request = buildOfflineChatRequest({
      turnId: "mobile:user-message-1",
      operationId: "answer:0",
      message: "What is this?",
      history: [{ role: "assistant", text: "Earlier reply" }],
      images,
    });

    expect(request).toMatchObject({
      message: "What is this?",
      history: [{ role: "assistant", text: "Earlier reply" }],
      images: [{ base64: PNG_BASE64, mimeType: "image/png" }],
    });
    expect(/^mobile-offline:[a-f0-9]{64}$/u.test(request.requestId)).toBe(true);
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  });

  test("keeps retries stable and separates identical independent turns", () => {
    const input = {
      turnId: "mobile:user-message-1",
      operationId: "answer:0",
      message: "Hello",
      history: [{ role: "assistant" as const, text: "Earlier" }],
      images: [],
    };
    const first = buildOfflineChatRequest(input);
    expect(buildOfflineChatRequest({ ...input })).toEqual(first);
    expect(
      buildOfflineChatRequest({ ...input, turnId: "mobile:user-message-2" })
        .requestId === first.requestId,
    ).toBe(false);
    expect(
      buildOfflineChatRequest({ ...input, message: "Changed" }).requestId,
    ).toBe(first.requestId);
    expect(
      buildOfflineChatRequest({ ...input, operationId: "answer:1" })
        .requestId === first.requestId,
    ).toBe(false);
    expect(first.requestId.length).toBeLessThanOrEqual(256);
  });

  test("fails visibly instead of silently dropping unreadable or unsupported images", async () => {
    await expectRejection(
      prepareOfflineChatImages([
        { uri: "file:///missing.jpg", base64: null, mimeType: "image/jpeg" },
      ]),
      "could not be read",
    );

    const heicHeader = Buffer.from(
      new Uint8Array([
        0x00, 0x00, 0x00, 0x28, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69,
        0x63,
      ]),
    ).toString("base64");
    await expectRejection(
      prepareOfflineChatImages([
        { uri: "file:///photo.heic", base64: heicHeader, mimeType: "image/jpeg" },
      ]),
      "format is not supported",
    );
  });

  test("enforces count, per-image, and total request limits before upload", async () => {
    await expectRejection(
      prepareOfflineChatImages(
        Array.from({ length: MAX_OFFLINE_CHAT_IMAGES + 1 }, (_, index) => ({
          uri: `file:///${index}.png`,
          base64: PNG_BASE64,
          mimeType: "image/png",
        })),
      ),
      `up to ${MAX_OFFLINE_CHAT_IMAGES}`,
    );

    await expectRejection(
      prepareOfflineChatImages([
        {
          uri: "file:///huge.png",
          base64: "A".repeat(MAX_OFFLINE_CHAT_IMAGE_BASE64_CHARS + 4),
          mimeType: "image/png",
        },
      ]),
      "smaller than 4.5 MB",
    );

    await expectRejection(
      prepareOfflineChatImages(
        Array.from({ length: 3 }, (_, index) => ({
          uri: `file:///${index}.png`,
          base64: "A".repeat(4_000_004),
          mimeType: "image/png",
        })),
      ),
      "fewer or smaller images",
    );
  });

  test("caps repeated picker additions without silently exceeding backend limits", () => {
    const result = appendOfflineChatAttachments([1, 2, 3, 4], [5, 6, 7]);
    expect(result.attachments).toEqual([1, 2, 3, 4, 5]);
    expect(result.rejected).toBe(2);
  });
});
