import { describe, expect, it } from "bun:test";

import { applyConvenienceInput } from "../../convex/http_routes/media";
import { getMediaCapability } from "../../convex/media_catalog";

const resolve = (capabilityId: string) => {
  const capability = getMediaCapability(capabilityId);
  if (!capability) {
    throw new Error(`Failed to resolve ${capabilityId}`);
  }
  return capability;
};

describe("media defaults", () => {
  it("defaults text-to-image requests to low quality", () => {
    const capability = resolve("text_to_image");

    const input = applyConvenienceInput({
      capability,
      input: {},
      prompt: "a small cabin at sunrise",
    });

    expect(input.quality).toBe("low");
  });

  it("defaults GPT Image 2 text-to-image requests to automatic image size", () => {
    const capability = resolve("text_to_image");

    const input = applyConvenienceInput({
      capability,
      input: {},
      prompt: "a small cabin at sunrise",
    });

    expect(input.image_size).toBe("auto");
  });

  it("preserves an explicit client image size override", () => {
    const capability = resolve("text_to_image");

    const input = applyConvenienceInput({
      capability,
      input: { image_size: { width: 1280, height: 720 } },
      prompt: "a small cabin at sunrise",
    });

    expect(input.image_size).toEqual({ width: 1280, height: 720 });
  });

  it("uses aspect ratio presets instead of the automatic image size default", () => {
    const capability = resolve("text_to_image");

    const input = applyConvenienceInput({
      capability,
      input: {},
      prompt: "a small cabin at sunrise",
      aspectRatio: "16:9",
    });

    expect(input.image_size).toEqual({ width: 1280, height: 720 });
  });

  it("preserves an explicit client quality override", () => {
    const capability = resolve("text_to_image");

    const input = applyConvenienceInput({
      capability,
      input: { quality: "medium" },
      prompt: "a small cabin at sunrise",
    });

    expect(input.quality).toBe("medium");
  });

  it("defaults image edit requests to low quality", () => {
    const capability = resolve("image_edit");

    const input = applyConvenienceInput({
      capability,
      input: { image_urls: ["https://example.com/input.png"] },
      prompt: "make the background blue",
    });

    expect(input.quality).toBe("low");
  });
});
