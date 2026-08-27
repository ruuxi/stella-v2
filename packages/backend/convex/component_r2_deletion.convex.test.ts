/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { r2 } from "./r2_files";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const deleteObjects = makeFunctionReference<
  "action",
  {
    objects: Array<{ locatorId: string; r2Key: string }>;
  },
  { confirmedLocatorIds: string[]; failedLocatorIds: string[] }
>("component_r2_deletion:deleteComponentR2ObjectsInternal");

const COMPONENT_R2_ENV = {
  R2_ACCESS_KEY_ID: "component-test-access",
  R2_SECRET_ACCESS_KEY: "component-test-secret",
  R2_ENDPOINT: "https://component-test.r2.cloudflarestorage.com",
  R2_BUCKET: "component-test-bucket",
} as const;

const stubComponentR2Env = () => {
  for (const [key, value] of Object.entries(COMPONENT_R2_ENV)) {
    vi.stubEnv(key, value);
  }
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("component R2 confirmed deletion", () => {
  it.each([
    [
      "non-terminal response",
      async () => new Response("secret body", { status: 503 }),
    ],
    [
      "network response loss",
      async () => Promise.reject(new Error("socket lost")),
    ],
  ])(
    "retains the opaque locator and never removes metadata after %s",
    async (_case, providerResult) => {
      const t = createTest();
      const r2Key = `private/${_case.replaceAll(" ", "-")}.bin`;
      stubComponentR2Env();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(providerResult);
      const metadataSpy = vi
        .spyOn(r2, "deleteObject")
        .mockResolvedValue(undefined);

      const result = await t.action(deleteObjects, {
        objects: [{ locatorId: "opaque-locator", r2Key }],
      });

      expect(result).toEqual({
        confirmedLocatorIds: [],
        failedLocatorIds: ["opaque-locator"],
      });
      expect(metadataSpy).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(r2Key);
      expect(serialized).not.toContain(COMPONENT_R2_ENV.R2_SECRET_ACCESS_KEY);
      expect(serialized).not.toContain("secret body");
    },
  );

  it("repeats the direct delete when metadata removal fails and converges through 404", async () => {
    const t = createTest();
    const r2Key = "private/metadata-retry.bin";
    stubComponentR2Env();
    const calls: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        calls.push("physical-204");
        return new Response(null, { status: 204 });
      })
      .mockImplementationOnce(async () => {
        calls.push("physical-404");
        return new Response(null, { status: 404 });
      });
    const metadataSpy = vi
      .spyOn(r2, "deleteObject")
      .mockImplementationOnce(async () => {
        calls.push("metadata-failed");
        throw new Error("metadata transaction unavailable");
      })
      .mockImplementationOnce(async () => {
        calls.push("metadata-confirmed");
      });

    await expect(
      t.action(deleteObjects, {
        objects: [{ locatorId: "locator-retry", r2Key }],
      }),
    ).resolves.toEqual({
      confirmedLocatorIds: [],
      failedLocatorIds: ["locator-retry"],
    });
    await expect(
      t.action(deleteObjects, {
        objects: [{ locatorId: "locator-retry", r2Key }],
      }),
    ).resolves.toEqual({
      confirmedLocatorIds: ["locator-retry"],
      failedLocatorIds: [],
    });

    expect(calls).toEqual([
      "physical-204",
      "metadata-failed",
      "physical-404",
      "metadata-confirmed",
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(metadataSpy).toHaveBeenCalledTimes(2);
  });

  it("retains the locator after a lost provider response and confirms absence on 404 replay", async () => {
    const t = createTest();
    const r2Key = "private/response-loss.bin";
    stubComponentR2Env();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("response lost after provider delete"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const metadataSpy = vi
      .spyOn(r2, "deleteObject")
      .mockResolvedValue(undefined);

    await expect(
      t.action(deleteObjects, {
        objects: [{ locatorId: "response-loss-locator", r2Key }],
      }),
    ).resolves.toEqual({
      confirmedLocatorIds: [],
      failedLocatorIds: ["response-loss-locator"],
    });
    await expect(
      t.action(deleteObjects, {
        objects: [{ locatorId: "response-loss-locator", r2Key }],
      }),
    ).resolves.toEqual({
      confirmedLocatorIds: ["response-loss-locator"],
      failedLocatorIds: [],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(metadataSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects ambiguous duplicate locator identities before provider I/O", async () => {
    const t = createTest();
    stubComponentR2Env();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const metadataSpy = vi.spyOn(r2, "deleteObject");

    await expect(
      t.action(deleteObjects, {
        objects: [
          { locatorId: "duplicate", r2Key: "private/a.bin" },
          { locatorId: "duplicate", r2Key: "private/b.bin" },
        ],
      }),
    ).rejects.toThrow(/locator is invalid/u);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(metadataSpy).not.toHaveBeenCalled();
  });

  it("preserves literal percent bytes in legacy encoded backup keys", async () => {
    const t = createTest();
    const r2Key = "backups/user%3Alegacy/objects/object.bin";
    stubComponentR2Env();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 404 }));
    const metadataSpy = vi
      .spyOn(r2, "deleteObject")
      .mockResolvedValue(undefined);

    await expect(
      t.action(deleteObjects, {
        objects: [{ locatorId: "legacy-percent", r2Key }],
      }),
    ).resolves.toEqual({
      confirmedLocatorIds: ["legacy-percent"],
      failedLocatorIds: [],
    });
    const request = fetchSpy.mock.calls[0]?.[0];
    const requestUrl =
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request?.url;
    expect(requestUrl).toContain("/backups/user%253Alegacy/objects/object.bin");
    expect(requestUrl).not.toContain("/backups/user%3Alegacy/");
    expect(metadataSpy).toHaveBeenCalledWith(expect.anything(), r2Key);
  });
});
