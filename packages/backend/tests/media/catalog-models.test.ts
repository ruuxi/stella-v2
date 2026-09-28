import { describe, expect, it } from "bun:test";

import { meterCompletedMediaJob } from "../../convex/media_billing";
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
