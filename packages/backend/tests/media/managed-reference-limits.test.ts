import { describe, expect, it } from "bun:test";

import { encryptSecret } from "../../convex/data/secrets_crypto";
import {
  readRequestTextBounded,
  RequestBodyLimitError,
} from "../../convex/http_shared/bounded_request_body";
import { decryptAndParseImageSubmission } from "../../convex/media_image_submission";
import {
  MAX_MANAGED_IMAGE_DISPATCH_ESTIMATED_PEAK_BYTES,
  MAX_MANAGED_IMAGE_REFERENCE_ITEM_BYTES,
  MAX_MANAGED_IMAGE_REFERENCE_ITEMS,
  MAX_MANAGED_IMAGE_REFERENCE_TOTAL_BYTES,
  MAX_MANAGED_IMAGE_REQUEST_BYTES,
  MAX_PRIVATE_MEDIA_PAYLOAD_CHARS,
  validateManagedImageReferenceEnvelope,
} from "../../convex/media_image_limits";

const dataUrlForBytes = (bytes: number): string =>
  `data:image/jpeg;base64,${Buffer.alloc(bytes, 0x61).toString("base64")}`;

describe("managed image reference resource envelope", () => {
  it("accepts the one-reference byte boundary and rejects one byte over", () => {
    expect(
      validateManagedImageReferenceEnvelope("image_edit", {
        image_urls: [dataUrlForBytes(MAX_MANAGED_IMAGE_REFERENCE_ITEM_BYTES)],
      }),
    ).toBeNull();
    expect(
      validateManagedImageReferenceEnvelope("image_edit", {
        image_urls: [
          dataUrlForBytes(MAX_MANAGED_IMAGE_REFERENCE_ITEM_BYTES + 1),
        ],
      }),
    ).toContain("per-reference");
  });

  it("enforces max items and aggregate decoded/serialized bytes", () => {
    expect(
      validateManagedImageReferenceEnvelope("image_edit", {
        image_urls: Array.from(
          { length: MAX_MANAGED_IMAGE_REFERENCE_ITEMS },
          (_, index) => `https://example.test/${index}.jpg`,
        ),
      }),
    ).toBeNull();
    expect(
      validateManagedImageReferenceEnvelope("image_edit", {
        image_urls: Array.from(
          { length: MAX_MANAGED_IMAGE_REFERENCE_ITEMS + 1 },
          (_, index) => `https://example.test/${index}.jpg`,
        ),
      }),
    ).toContain("at most");
    expect(
      validateManagedImageReferenceEnvelope("image_edit", {
        image_urls: [
          dataUrlForBytes(MAX_MANAGED_IMAGE_REFERENCE_TOTAL_BYTES / 2),
          dataUrlForBytes(MAX_MANAGED_IMAGE_REFERENCE_TOTAL_BYTES / 2),
        ],
      }),
    ).toBeNull();
    expect(
      validateManagedImageReferenceEnvelope("image_edit", {
        image_urls: [
          dataUrlForBytes(
            Math.floor(MAX_MANAGED_IMAGE_REFERENCE_TOTAL_BYTES / 3) + 1,
          ),
          dataUrlForBytes(
            Math.floor(MAX_MANAGED_IMAGE_REFERENCE_TOTAL_BYTES / 3) + 1,
          ),
          dataUrlForBytes(
            Math.floor(MAX_MANAGED_IMAGE_REFERENCE_TOTAL_BYTES / 3) + 1,
          ),
        ],
      }),
    ).toContain("aggregate");
  });

  it("rejects oversized Content-Length before opening the request stream", async () => {
    const request = new Request("https://stella.test/api/media/v1/generate", {
      method: "POST",
      headers: {
        "content-length": String(MAX_MANAGED_IMAGE_REQUEST_BYTES + 1),
      },
      body: "{}",
    });
    let opened = false;
    Object.defineProperty(request.body!, "getReader", {
      value: () => {
        opened = true;
        throw new Error("body stream should not be opened");
      },
    });
    await expect(
      readRequestTextBounded(request, MAX_MANAGED_IMAGE_REQUEST_BYTES),
    ).rejects.toMatchObject({ status: 413 });
    expect(opened).toBe(false);
  });

  it("aborts oversized chunked bodies and reports interrupted uploads", async () => {
    let canceled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_MANAGED_IMAGE_REQUEST_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        canceled = true;
      },
    });
    const chunkedRequest = new Request("https://stella.test/generate", {
      method: "POST",
      body: oversized,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(
      readRequestTextBounded(chunkedRequest, MAX_MANAGED_IMAGE_REQUEST_BYTES),
    ).rejects.toMatchObject({ status: 413 });
    expect(canceled).toBe(true);

    let reads = 0;
    const interrupted = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) controller.enqueue(new TextEncoder().encode("{"));
        else controller.error(new Error("connection reset"));
      },
    });
    const interruptedRequest = new Request("https://stella.test/generate", {
      method: "POST",
      body: interrupted,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(
      readRequestTextBounded(
        interruptedRequest,
        MAX_MANAGED_IMAGE_REQUEST_BYTES,
      ),
    ).rejects.toEqual(
      expect.objectContaining<RequestBodyLimitError>({ status: 400 }),
    );
  });

  it("decrypts a production-shaped payload below a conservative 64 MiB peak", async () => {
    process.env.STELLA_SECRETS_MASTER_KEYS_JSON = JSON.stringify({
      "1": Buffer.alloc(32, 7).toString("base64"),
    });
    process.env.STELLA_SECRETS_MASTER_KEY_VERSION = "1";
    const submission = {
      input: {
        prompt: "use the bounded references",
        image_urls: [dataUrlForBytes(512 * 1024), dataUrlForBytes(512 * 1024)],
      },
      webhookUrl: "https://stella.test/api/media/v1/webhooks/fal?jobId=test",
    };
    const encrypted = JSON.stringify(
      await encryptSecret(JSON.stringify(submission)),
    );
    expect(encrypted.length).toBeLessThan(MAX_PRIVATE_MEDIA_PAYLOAD_CHARS);
    await expect(decryptAndParseImageSubmission(encrypted)).resolves.toEqual(
      submission,
    );
    expect(MAX_MANAGED_IMAGE_DISPATCH_ESTIMATED_PEAK_BYTES).toBeLessThan(
      64 * 1024 * 1024,
    );
    await expect(
      decryptAndParseImageSubmission(
        "x".repeat(MAX_PRIVATE_MEDIA_PAYLOAD_CHARS + 1),
      ),
    ).rejects.toThrow("safe limits");
  });
});
