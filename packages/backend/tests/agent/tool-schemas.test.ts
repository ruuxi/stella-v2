import { describe, expect, test } from "bun:test";

import {
  ExecCommandSchema,
  ImageGenSchema,
  MAX_IMAGE_GEN_REFERENCE_ITEMS,
  WebSchema,
  WebSearchSchema,
  WriteStdinSchema,
} from "../../convex/agent/tool_schemas";

describe("backend exec_command device-tool schema", () => {
  test("accepts the opt-in tty flag", () => {
    expect(
      ExecCommandSchema.safeParse({ cmd: "node", tty: true }).success,
    ).toBe(true);
    expect(
      ExecCommandSchema.safeParse({ cmd: "node", tty: "true" }).success,
    ).toBe(false);
  });
});

describe("backend write_stdin device-tool schema", () => {
  test("preserves legacy calls and accepts idempotent writes", () => {
    expect(
      WriteStdinSchema.safeParse({ session_id: "session", chars: "hello\n" })
        .success,
    ).toBe(true);
    expect(
      WriteStdinSchema.safeParse({
        session_id: "session",
        operation: "write",
        chars: "hello\n",
        write_id: "write-1",
      }).success,
    ).toBe(true);
    // Preserve the existing backend compatibility for older numeric ids.
    expect(WriteStdinSchema.safeParse({ session_id: 1234 }).success).toBe(true);
  });

  test("accepts explicit controls and rejects invalid operations or dimensions", () => {
    expect(
      WriteStdinSchema.safeParse({
        session_id: "session",
        operation: "terminate",
      }).success,
    ).toBe(true);
    expect(
      WriteStdinSchema.safeParse({
        session_id: "session",
        operation: "close_stdin",
      }).success,
    ).toBe(true);
    expect(
      WriteStdinSchema.safeParse({
        session_id: "session",
        operation: "resize",
        cols: 100,
        rows: 40,
      }).success,
    ).toBe(true);
    expect(
      WriteStdinSchema.safeParse({
        session_id: "session",
        operation: "restart",
      }).success,
    ).toBe(false);
    expect(
      WriteStdinSchema.safeParse({
        session_id: "session",
        operation: "resize",
        cols: 0,
        rows: 40.5,
      }).success,
    ).toBe(false);
  });
});

describe("backend web device-tool schema", () => {
  test("requires exactly one web mode", () => {
    expect(WebSchema.safeParse({ query: "latest news" }).success).toBe(true);
    expect(WebSchema.safeParse({ url: "https://example.test" }).success).toBe(
      true,
    );
    expect(WebSchema.safeParse({}).success).toBe(false);
    expect(
      WebSchema.safeParse({
        query: "latest news",
        url: "https://example.test",
      }).success,
    ).toBe(false);
  });

  test("uses the canonical category spelling and fetch formats", () => {
    expect(
      WebSearchSchema.safeParse({
        query: "new AI papers",
        category: "research paper",
      }).success,
    ).toBe(true);
    expect(
      WebSearchSchema.safeParse({
        query: "new AI papers",
        category: "research_paper",
      }).success,
    ).toBe(false);
    expect(
      WebSchema.safeParse({
        url: "https://example.test",
        format: "markdown",
      }).success,
    ).toBe(true);
    expect(
      WebSchema.safeParse({ url: "https://example.test", format: "pdf" })
        .success,
    ).toBe(false);
  });
});

const references = (pathCount: number, urlCount: number) => ({
  prompt: "render these references",
  referenceImagePaths: Array.from(
    { length: pathCount },
    (_, index) => `/tmp/reference-${index}.png`,
  ),
  referenceImageUrls: Array.from(
    { length: urlCount },
    (_, index) => `https://example.test/reference-${index}.png`,
  ),
});

const mixedOverflowPartitions = Array.from(
  { length: MAX_IMAGE_GEN_REFERENCE_ITEMS },
  (_, pathIndex) => pathIndex + 1,
).flatMap((pathCount) =>
  Array.from(
    { length: MAX_IMAGE_GEN_REFERENCE_ITEMS },
    (_, urlIndex) => urlIndex + 1,
  )
    .filter((urlCount) => pathCount + urlCount > MAX_IMAGE_GEN_REFERENCE_ITEMS)
    .map((urlCount) => [pathCount, urlCount] as const),
);

describe("backend image_gen device-tool schema", () => {
  test("accepts every paths + URLs partition totaling zero through four", () => {
    for (let total = 0; total <= MAX_IMAGE_GEN_REFERENCE_ITEMS; total += 1) {
      for (let pathCount = 0; pathCount <= total; pathCount += 1) {
        expect(
          ImageGenSchema.safeParse(references(pathCount, total - pathCount))
            .success,
        ).toBe(true);
      }
    }
  });

  test.each(mixedOverflowPartitions)(
    "rejects mixed reference partition %i + %i",
    (pathCount, urlCount) => {
      const result = ImageGenSchema.safeParse(references(pathCount, urlCount));
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("expected image_gen schema rejection");
      }
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          code: "custom",
          path: ["referenceImageUrls"],
          message:
            "image_gen accepts at most 4 combined referenceImagePaths + referenceImageUrls",
        }),
      );
    },
  );

  test("retains clear per-array validation issues", () => {
    const paths = ImageGenSchema.safeParse(references(5, 0));
    expect(paths.success).toBe(false);
    if (!paths.success) {
      expect(paths.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["referenceImagePaths"],
          message: "image_gen accepts at most 4 referenceImagePaths",
        }),
      );
    }

    const urls = ImageGenSchema.safeParse(references(0, 5));
    expect(urls.success).toBe(false);
    if (!urls.success) {
      expect(urls.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["referenceImageUrls"],
          message: "image_gen accepts at most 4 referenceImageUrls",
        }),
      );
    }
  });
});
