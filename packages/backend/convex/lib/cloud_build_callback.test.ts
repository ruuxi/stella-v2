import { describe, expect, it } from "vitest";
import { parseCloudBuildCallback } from "./cloud_build_callback";

const OWNER_HASH = "a".repeat(64);

const valid = () => ({
  buildId: "build_123",
  appId: "app:12345678",
  ownerId: "user:123",
  ownerGeneration: "owner-generation-123",
  turnId: "turn:12345678",
  artifactPrefix: `builds/${OWNER_HASH}/build_123`,
  previewUrl: "https://apps.example.test/apps/orbit/",
  metrics: { wallClockMs: 42 },
  slug: "orbit",
});

describe("parseCloudBuildCallback", () => {
  it("returns a bounded normalized DTO", () => {
    expect(parseCloudBuildCallback(valid())).toMatchObject({
      buildId: "build_123",
      turnId: "turn:12345678",
      metricsJson: '{"wallClockMs":42}',
    });
  });

  it("rejects a prefix that is not bound to the build id", () => {
    expect(() =>
      parseCloudBuildCallback({
        ...valid(),
        artifactPrefix: `builds/${OWNER_HASH}/other`,
      }),
    ).toThrow(/artifactPrefix/);
    expect(() =>
      parseCloudBuildCallback({
        ...valid(),
        artifactPrefix: "builds/build_123",
      }),
    ).toThrow(/artifactPrefix/);
  });

  it("requires the owner lifecycle generation", () => {
    expect(() =>
      parseCloudBuildCallback({ ...valid(), ownerGeneration: undefined }),
    ).toThrow(/ownerGeneration/);
  });

  it("rejects oversized metrics", () => {
    expect(() =>
      parseCloudBuildCallback({
        ...valid(),
        metrics: { payload: "x".repeat(70_000) },
      }),
    ).toThrow(/too large/);
  });

  it("carries no activation decision for the build to obey", () => {
    expect(
      parseCloudBuildCallback({ ...valid(), autoActivate: true }),
    ).not.toHaveProperty("autoActivate");
  });
});
