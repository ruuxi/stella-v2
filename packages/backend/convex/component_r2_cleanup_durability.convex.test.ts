/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { r2 } from "./r2_files";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const cleanupCanceledDriveObject = makeFunctionReference<
  "action",
  { r2Key: string; attempt?: number },
  { deleted: boolean }
>("cloud_drive:cleanupCanceledPendingUploadInternal");

const deleteRelayedMedia = makeFunctionReference<
  "action",
  {
    media: Array<{
      id: string;
      kind: "file";
      url: string;
      expiresAt: number;
      r2Key?: string;
    }>;
    attempt?: number;
  },
  null
>("channels/connector_media:deleteRelayedMedia");

const stubComponentR2Env = () => {
  vi.stubEnv("R2_ACCESS_KEY_ID", "cleanup-test-access");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "cleanup-test-secret");
  vi.stubEnv(
    "R2_ENDPOINT",
    "https://cleanup-test.r2.cloudflarestorage.com",
  );
  vi.stubEnv("R2_BUCKET", "cleanup-test-bucket");
};

const scheduledWithKey = async (
  t: ReturnType<typeof createTest>,
  r2Key: string,
) =>
  await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) => JSON.stringify(job.args).includes(r2Key),
    ),
  );

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("durable component-R2 cleanup chains", () => {
  it("keeps a Drive orphan locator scheduled across response loss and converges on replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    const t = createTest();
    const r2Key = "drive/orphaned-finalization.bin";
    stubComponentR2Env();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("delete response lost"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const metadataSpy = vi
      .spyOn(r2, "deleteObject")
      .mockResolvedValue(undefined);

    await expect(
      t.action(cleanupCanceledDriveObject, { r2Key }),
    ).resolves.toEqual({ deleted: false });
    expect(await scheduledWithKey(t, r2Key)).toHaveLength(1);

    await t.finishAllScheduledFunctions(vi.runAllTimers, 10);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(metadataSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps connector relay locators scheduled until every object is confirmed absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(200_000));
    const t = createTest();
    const r2Key = "ephemeral/connectors/relay/private.bin";
    const media = [
      {
        id: "relay-media",
        kind: "file" as const,
        url: "https://signed.example.test/private.bin",
        expiresAt: 300_000,
        r2Key,
      },
    ];
    stubComponentR2Env();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("retry", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const metadataSpy = vi
      .spyOn(r2, "deleteObject")
      .mockResolvedValue(undefined);

    await expect(t.action(deleteRelayedMedia, { media })).resolves.toBeNull();
    expect(await scheduledWithKey(t, r2Key)).toHaveLength(1);

    await t.finishAllScheduledFunctions(vi.runAllTimers, 10);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(metadataSpy).toHaveBeenCalledTimes(1);
  });
});
