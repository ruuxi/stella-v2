import { describe, expect, it } from "bun:test";

import { meterCompletedMediaJob } from "../../convex/media_billing";
import {
  getMediaCapability,
  listMediaCapabilities,
} from "../../convex/media_catalog";

describe("managed media model catalog", () => {
  it("uses one GPT Image 2 endpoint per image operation", () => {
    expect(getMediaCapability("text_to_image")?.endpointId).toBe(
      "openai/gpt-image-2",
    );
    expect(getMediaCapability("image_edit")?.endpointId).toBe(
      "openai/gpt-image-2/edit",
    );
    expect(getMediaCapability("icon")).toBeNull();
    expect(
      listMediaCapabilities().every((entry) => !("profiles" in entry)),
    ).toBe(true);
  });

  it("uses H3 Max for the three video operations", () => {
    expect(getMediaCapability("text_to_video")?.endpointId).toBe(
      "minimax/h3-max/text-to-video",
    );
    expect(getMediaCapability("image_to_video")?.endpointId).toBe(
      "minimax/h3-max/image-to-video",
    );
    expect(getMediaCapability("reference_to_video")?.endpointId).toBe(
      "minimax/h3-max/reference-to-video",
    );
    expect(getMediaCapability("video_extend")).toBeNull();
    expect(getMediaCapability("video_to_video")).toBeNull();
  });

  it("uses Hunyuan 3D v3.1 Pro for text to 3D", () => {
    expect(getMediaCapability("text_to_3d")?.endpointId).toBe(
      "fal-ai/hunyuan-3d/v3.1/pro/text-to-3d",
    );
  });
});

describe("new media endpoint billing", () => {
  it("meters H3 Max by output seconds and requested resolution", () => {
    expect(
      meterCompletedMediaJob({
        endpointId: "minimax/h3-max/text-to-video",
        request: { input: { duration: 5, resolution: "480P" } },
        output: {},
      }),
    ).toMatchObject({
      billingUnit: "second",
      quantity: 5,
      unitPriceUsd: 0.05,
      costMicroCents: 25_000_000,
    });

    expect(
      meterCompletedMediaJob({
        endpointId: "minimax/h3-max/image-to-video",
        request: { input: { duration: 5, resolution: "768P" } },
        output: {},
      }),
    ).toMatchObject({
      billingUnit: "second",
      quantity: 5,
      unitPriceUsd: 0.08,
      costMicroCents: 40_000_000,
    });

    expect(
      meterCompletedMediaJob({
        endpointId: "minimax/h3-max/reference-to-video",
        request: { input: { duration: 5, resolution: "480P" } },
        output: {},
      }),
    ).toMatchObject({
      billingUnit: "second",
      quantity: 5,
      unitPriceUsd: 0.08,
      costMicroCents: 40_000_000,
    });
  });

  it("meters Hunyuan generation type and PBR", () => {
    expect(
      meterCompletedMediaJob({
        endpointId: "fal-ai/hunyuan-3d/v3.1/pro/text-to-3d",
        request: { input: { generate_type: "Normal", enable_pbr: true } },
        output: {},
      }),
    ).toMatchObject({
      billingUnit: "request",
      quantity: 1,
      unitPriceUsd: 0.525,
      costMicroCents: 52_500_000,
    });
  });
});
