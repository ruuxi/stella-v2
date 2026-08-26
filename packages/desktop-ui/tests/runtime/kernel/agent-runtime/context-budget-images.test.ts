import { describe, expect, it } from "vitest";

import {
  decodedBase64ByteLength,
  estimateProviderPayloadTokens,
  getProviderPayloadImageStats,
} from "@stella/runtime/kernel/agent-runtime/context-budget";

describe("provider context image accounting", () => {
  it("does not classify ordinary HTTP url fields as images", () => {
    const tokens = estimateProviderPayloadTokens(
      { browser: { url: "https://example.test/dashboard" } },
      Number.POSITIVE_INFINITY,
    );
    expect(tokens).toBeLessThan(100);
  });

  it("counts typed image blocks once without charging their base64 as text", () => {
    const small = estimateProviderPayloadTokens(
      {
        content: [
          { type: "image", data: "a".repeat(32), mimeType: "image/png" },
        ],
      },
      Number.POSITIVE_INFINITY,
    );
    const large = estimateProviderPayloadTokens(
      {
        content: [
          {
            type: "image",
            data: "a".repeat(4 * 1024 * 1024),
            mimeType: "image/png",
          },
        ],
      },
      Number.POSITIVE_INFINITY,
    );
    expect(small).toBeGreaterThanOrEqual(1_200);
    expect(large - small).toBeLessThan(20);
  });

  it("recognizes Responses-style image_url content", () => {
    const tokens = estimateProviderPayloadTokens(
      {
        content: [
          {
            type: "input_image",
            image_url: "https://example.test/screenshot.png",
          },
        ],
      },
      Number.POSITIVE_INFINITY,
    );
    expect(tokens).toBeGreaterThanOrEqual(1_200);
    expect(tokens).toBeLessThan(1_300);
  });

  it("uses dimensions consistently in the quick and exact passes", () => {
    const payload = {
      content: [
        {
          type: "image",
          data: "a".repeat(1024),
          mimeType: "image/png",
          width: 1536,
          height: 1024,
        },
      ],
    };
    const quick = estimateProviderPayloadTokens(
      payload,
      Number.POSITIVE_INFINITY,
    );
    const exact = estimateProviderPayloadTokens(payload, 1);
    expect(quick).toBeGreaterThanOrEqual(1_105);
    expect(Math.abs(quick - exact)).toBeLessThan(30);
  });

  it("measures padded and unpadded base64 decoded bytes exactly", () => {
    expect(decodedBase64ByteLength("YQ==")).toBe(1);
    expect(decodedBase64ByteLength("YWI=")).toBe(2);
    expect(decodedBase64ByteLength("YWJj")).toBe(3);
    expect(decodedBase64ByteLength("data:image/png;base64,YQ==")).toBe(1);
  });

  it("normalizes typed, Responses, Google, and Bedrock image envelopes", () => {
    const data = Buffer.alloc(256 * 1024, 7).toString("base64");
    const variants = [
      {
        type: "image",
        mimeType: "image/png",
        data,
        width: 1024,
        height: 768,
      },
      {
        type: "input_image",
        image_url: `data:image/png;base64,${data}`,
        width: 1024,
        height: 768,
      },
      {
        inlineData: { mimeType: "image/png", data },
        width: 1024,
        height: 768,
      },
      {
        image: {
          format: "png",
          source: { bytes: Buffer.from(data, "base64") },
          width: 1024,
          height: 768,
        },
      },
    ];
    const estimates = variants.map((content) =>
      estimateProviderPayloadTokens({ content: [content] }, 1),
    );
    expect(Math.max(...estimates) - Math.min(...estimates)).toBeLessThan(30);
    expect(Math.max(...estimates)).toBeLessThan(900);
    for (const content of variants) {
      expect(getProviderPayloadImageStats({ content: [content] })).toEqual({
        count: 1,
        decodedBytes: 256 * 1024,
      });
    }
  });
});
