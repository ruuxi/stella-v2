import { describe, expect, test } from "bun:test";

import {
  ImageGenSchema,
  MAX_IMAGE_GEN_REFERENCE_ITEMS,
} from "../../convex/agent/tool_schemas";

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
