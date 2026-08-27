import { describe, expect, test } from "vitest";
import { getFunctionName, type FunctionArgs } from "convex/server";
import { cloudHomeApi } from "@/features/cloud/cloud-home-api";

describe("Cloud Home Memory API references", () => {
  test("targets the subject-fenced preference and lifecycle functions", () => {
    expect(getFunctionName(cloudHomeApi.getMyMemoryPreference)).toBe(
      "cloud_memory:getMyMemoryPreference",
    );
    expect(getFunctionName(cloudHomeApi.setMyMemoryEnabled)).toBe(
      "cloud_memory:setMyMemoryEnabled",
    );
    expect(getFunctionName(cloudHomeApi.getMyMemoryWipeStatus)).toBe(
      "cloud_memory_lifecycle:getMyMemoryWipeStatus",
    );
    expect(getFunctionName(cloudHomeApi.startMyMemoryWipe)).toBe(
      "cloud_memory_lifecycle:startMyMemoryWipe",
    );
    expect(getFunctionName(cloudHomeApi.authorizeMyMemoryReimport)).toBe(
      "cloud_memory_lifecycle:authorizeMyMemoryReimport",
    );
  });

  test("requires the exact subject, generation, epoch, and request fence", () => {
    const args = {
      expectedSubject: "https://site.example|owner-a",
      expectedOwnerGeneration: "generation-1",
      expectedMemoryEpoch: "memory-epoch-2",
      requestId: "desktop-memory-reimport:stable",
    } satisfies FunctionArgs<typeof cloudHomeApi.authorizeMyMemoryReimport>;

    expect(args).toEqual({
      expectedSubject: "https://site.example|owner-a",
      expectedOwnerGeneration: "generation-1",
      expectedMemoryEpoch: "memory-epoch-2",
      requestId: "desktop-memory-reimport:stable",
    });
  });
});
