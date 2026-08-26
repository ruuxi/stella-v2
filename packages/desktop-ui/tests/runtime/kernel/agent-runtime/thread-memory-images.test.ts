import { describe, expect, it } from "vitest";
import { stripStaleImageBlocks } from "@stella/runtime/kernel/agent-runtime/thread-memory";
import {
  collectThreadImageReceipts,
  getThreadImageHistoryStats,
  splitThreadMessagesForImagePressure,
} from "@stella/runtime/kernel/thread-runtime";

type TestMessage = {
  role: string;
  content: Array<{
    type: string;
    data?: string;
    mimeType?: string;
    text?: string;
  }>;
};

const imageResult = (base64Bytes: number): TestMessage => ({
  role: "toolResult",
  content: [
    { type: "text", text: "viewed" },
    { type: "image", data: "a".repeat(base64Bytes), mimeType: "image/png" },
  ],
});

const stored = (messages: TestMessage[]) =>
  messages.map((message, index) => ({
    entryId: `entry-${index}`,
    timestamp: index,
    role: "toolResult",
    content: "viewed",
    payload: {
      role: "toolResult" as const,
      toolCallId: `call-${index}`,
      toolName: "screenshot",
      content: message.content,
      isError: false,
      timestamp: index,
    },
  })) as never;

describe("image history cache and compaction accounting", () => {
  it("never rewrites an existing message prefix between compactions", () => {
    const messages = Array.from({ length: 10 }, () => imageResult(1024));
    expect(stripStaleImageBlocks(messages)).toBe(messages);
  });

  it("keeps a multi-image reference set below the pressure threshold", () => {
    const messages = Array.from({ length: 6 }, () => imageResult(400 * 1024));
    expect(getThreadImageHistoryStats(stored(messages))).toMatchObject({
      count: 6,
      overBudget: false,
    });
  });

  it("requests checkpoint compaction past the active image-count cap", () => {
    const messages = Array.from({ length: 9 }, () => imageResult(1024));
    expect(getThreadImageHistoryStats(stored(messages))).toMatchObject({
      count: 9,
      overBudget: true,
    });
  });

  it("accounts decoded base64 bytes for the checkpoint budget", () => {
    const messages = Array.from({ length: 5 }, () =>
      imageResult(4 * 1024 * 1024),
    );
    const stats = getThreadImageHistoryStats(stored(messages));
    expect(stats.decodedBytes).toBe(15 * 1024 * 1024);
    expect(stats.overBudget).toBe(true);
  });

  it("accounts every image block in a batched result", () => {
    const batched: TestMessage = {
      role: "toolResult",
      content: Array.from({ length: 10 }, () => ({
        type: "image",
        data: "a".repeat(1024),
        mimeType: "image/png",
      })),
    };
    expect(getThreadImageHistoryStats(stored([batched]))).toMatchObject({
      count: 10,
      overBudget: true,
    });
    const plan = splitThreadMessagesForImagePressure(stored([batched]));
    expect(plan).toMatchObject({
      fromEntryId: "entry-0",
      toEntryId: "entry-0",
      imagePressure: true,
    });
    expect(plan?.middleMessages).toHaveLength(1);
  });

  it("marks receipts explicitly non-durable when promotion is unavailable", () => {
    const receipts = collectThreadImageReceipts(
      stored([imageResult(4)]),
      undefined,
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.artifact).toMatchObject({
      durability: "non-durable",
      reason: expect.stringContaining("no durable artifact directory"),
    });
  });
});
