/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { requireConfiguredRawR2MediaTarget } from "./lib/raw_r2_media_target";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const OWNER_ID = "https://issuer.test|raw-r2-media-owner";
const SHA256 = "a".repeat(64);
const RAW_MEDIA_ENV = {
  R2_PETS_BUCKET: "stella-v2-pets-dev",
  R2_PETS_PUBLIC_BASE_URL: "https://pets.dev.example.test",
  R2_EMOJI_BUCKET: "stella-v2-emoji-dev",
  R2_EMOJI_PUBLIC_BASE_URL: "https://emoji.dev.example.test",
} as const;

const stubRawMediaEnv = (
  overrides: Partial<Record<keyof typeof RAW_MEDIA_ENV, string>> = {},
) => {
  for (const [key, value] of Object.entries({
    ...RAW_MEDIA_ENV,
    ...overrides,
  })) {
    vi.stubEnv(key, value);
  }
};

const createTest = async () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  await t.mutation(internal.billing.setAdminBillingPlan, {
    ownerId: OWNER_ID,
    plan: "pro",
  });
  return t;
};

const asOwner = (t: Awaited<ReturnType<typeof createTest>>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "raw-r2-media-owner",
    tokenIdentifier: OWNER_ID,
  });

const expectNoExternalMediaAuthority = async (
  t: Awaited<ReturnType<typeof createTest>>,
) => {
  expect(
    await t.run(async (ctx) => ({
      objects: await ctx.db.query("account_external_media_objects").collect(),
      jobs: await ctx.db.query("media_jobs").collect(),
    })),
  ).toEqual({ objects: [], jobs: [] });
};

beforeEach(() => {
  const values: Record<string, string> = {
    FAL_KEY: "test-fal-key",
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
    R2_ENDPOINT: "https://test-account.r2.cloudflarestorage.com",
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "10",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "20",
    STELLA_FREE_MONTHLY_LIMIT_USD: "30",
    STELLA_FREE_LIFETIME_LIMIT_USD: "10",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("raw R2 media authority configuration", () => {
  it("resolves only the explicitly configured per-kind development buckets", () => {
    stubRawMediaEnv();

    expect(
      requireConfiguredRawR2MediaTarget({
        bucketEnv: "R2_PETS_BUCKET",
        purpose: "Pet uploads",
      }),
    ).toEqual({
      bucket: "stella-v2-pets-dev",
      publicBase: "https://pets.dev.example.test",
    });
    expect(
      requireConfiguredRawR2MediaTarget({
        bucketEnv: "R2_EMOJI_BUCKET",
        purpose: "Emoji pack uploads",
      }),
    ).toEqual({
      bucket: "stella-v2-emoji-dev",
      publicBase: "https://emoji.dev.example.test",
    });
  });

  it("accepts distinct Cloudflare r2.dev origins for explicit dev buckets", () => {
    stubRawMediaEnv({
      R2_PETS_PUBLIC_BASE_URL:
        "https://pub-11111111111111111111111111111111.r2.dev",
      R2_EMOJI_PUBLIC_BASE_URL:
        "https://pub-22222222222222222222222222222222.r2.dev",
    });
    expect(
      requireConfiguredRawR2MediaTarget({
        bucketEnv: "R2_PETS_BUCKET",
        purpose: "Pet uploads",
      }).publicBase,
    ).toBe("https://pub-11111111111111111111111111111111.r2.dev");
    expect(
      requireConfiguredRawR2MediaTarget({
        bucketEnv: "R2_EMOJI_BUCKET",
        purpose: "Emoji uploads",
      }).publicBase,
    ).toBe("https://pub-22222222222222222222222222222222.r2.dev");
  });

  it.each([
    "http://media.example.test",
    "https://user:password@media.example.test",
    "https://media.example.test/shared/path",
    "https://media.example.test?deployment=prod",
    "https://media.example.test#prod",
    "https://pets.dev.example.test/",
    "https://media.example.com",
  ])("rejects a non-origin public target before use: %s", (publicBase) => {
    stubRawMediaEnv({ R2_PETS_PUBLIC_BASE_URL: publicBase });
    expect(() =>
      requireConfiguredRawR2MediaTarget({
        bucketEnv: "R2_PETS_BUCKET",
        purpose: "Pet uploads",
      }),
    ).toThrow(/R2_PETS_PUBLIC_BASE_URL/u);
  });

  it.each([
    ["R2_PETS_BUCKET", "stella-files"],
    ["R2_PETS_BUCKET", "stella-v2-pets-prod"],
    ["R2_EMOJI_BUCKET", "stella-emotes"],
    ["R2_EMOJI_BUCKET", "stella-v2-emoji-production"],
  ] as const)(
    "rejects a production-looking %s before use",
    (envName, bucket) => {
      stubRawMediaEnv({ [envName]: bucket });
      expect(() =>
        requireConfiguredRawR2MediaTarget({
          bucketEnv: "R2_PETS_BUCKET",
          purpose: "Raw media",
        }),
      ).toThrow(/development-only bucket/u);
    },
  );

  it("requires distinct per-kind buckets and public origins", () => {
    stubRawMediaEnv({ R2_EMOJI_BUCKET: RAW_MEDIA_ENV.R2_PETS_BUCKET });
    expect(() =>
      requireConfiguredRawR2MediaTarget({
        bucketEnv: "R2_PETS_BUCKET",
        purpose: "Raw media",
      }),
    ).toThrow(/distinct R2_PETS_BUCKET and R2_EMOJI_BUCKET/u);

    stubRawMediaEnv({
      R2_EMOJI_BUCKET: RAW_MEDIA_ENV.R2_EMOJI_BUCKET,
      R2_EMOJI_PUBLIC_BASE_URL: RAW_MEDIA_ENV.R2_PETS_PUBLIC_BASE_URL,
    });
    expect(() =>
      requireConfiguredRawR2MediaTarget({
        bucketEnv: "R2_EMOJI_BUCKET",
        purpose: "Raw media",
      }),
    ).toThrow(/distinct R2_PETS_PUBLIC_BASE_URL and R2_EMOJI_PUBLIC_BASE_URL/u);
  });

  it("does not fall back to the legacy shared public base", () => {
    stubRawMediaEnv({ R2_PETS_PUBLIC_BASE_URL: "" });
    vi.stubEnv(
      "R2_PUBLIC_BASE_URL",
      "https://pub-58708621bfa94e3bb92de37cde354c0d.r2.dev",
    );
    expect(() =>
      requireConfiguredRawR2MediaTarget({
        bucketEnv: "R2_PETS_BUCKET",
        purpose: "Pet uploads",
      }),
    ).toThrow(/R2_PETS_PUBLIC_BASE_URL/u);
  });

  it("never substitutes the other product bucket for upload signing authority", async () => {
    const t = await createTest();
    const owner = asOwner(t);
    const providerFetch = vi.spyOn(globalThis, "fetch");
    stubRawMediaEnv({ R2_PETS_BUCKET: "" });

    await expect(
      owner.action(api.data.user_pet_uploads.createUploadUrl, {
        petId: "safe-pet",
        spritesheetSha256: SHA256,
      }),
    ).rejects.toThrow(/R2_PETS_BUCKET/u);

    stubRawMediaEnv({ R2_EMOJI_BUCKET: "" });
    await expect(
      owner.action(api.data.emoji_pack_uploads.createUploadUrl, {
        packId: "safe-pack",
        sheetSha256s: [SHA256, SHA256, SHA256],
      }),
    ).rejects.toThrow(/R2_EMOJI_BUCKET/u);

    expect(providerFetch).not.toHaveBeenCalled();
    await expectNoExternalMediaAuthority(t);
  });

  it("signs and records only the explicitly configured development targets", async () => {
    const t = await createTest();
    const owner = asOwner(t);
    const providerFetch = vi.spyOn(globalThis, "fetch");
    stubRawMediaEnv();

    const pet = await owner.action(api.data.user_pet_uploads.createUploadUrl, {
      petId: "safe-pet",
      spritesheetSha256: SHA256,
    });
    const emoji = await owner.action(
      api.data.emoji_pack_uploads.createUploadUrl,
      {
        packId: "safe-pack",
        sheetSha256s: [SHA256, SHA256, SHA256],
      },
    );

    expect(pet.spritesheet.publicUrl).toMatch(
      /^https:\/\/pets\.dev\.example\.test\/user-pets\//u,
    );
    expect(emoji.sheets).toHaveLength(3);
    expect(
      emoji.sheets.every((sheet) =>
        sheet.publicUrl.startsWith(
          "https://emoji.dev.example.test/emoji-packs/",
        ),
      ),
    ).toBe(true);
    expect(providerFetch).not.toHaveBeenCalled();

    const objects = await t.run(async (ctx) =>
      ctx.db.query("account_external_media_objects").collect(),
    );
    expect(objects).toHaveLength(4);
    expect(
      objects.filter((row) => row.bucket === "stella-v2-pets-dev"),
    ).toHaveLength(1);
    expect(
      objects.filter((row) => row.bucket === "stella-v2-emoji-dev"),
    ).toHaveLength(3);
  });

  it("missing generation targets create no provider job, locator, or external I/O", async () => {
    const t = await createTest();
    const owner = asOwner(t);
    const providerFetch = vi.spyOn(globalThis, "fetch");
    vi.stubEnv(
      "R2_PUBLIC_BASE_URL",
      "https://pub-58708621bfa94e3bb92de37cde354c0d.r2.dev",
    );
    vi.stubEnv("R2_PETS_BUCKET", "");
    vi.stubEnv("R2_EMOJI_BUCKET", "");
    vi.stubEnv("R2_PETS_PUBLIC_BASE_URL", "");
    vi.stubEnv("R2_EMOJI_PUBLIC_BASE_URL", "");

    await expect(
      owner.action(api.data.user_pet_generation.generatePet, {
        prompt: "a safe dev pet",
        visibility: "private",
      }),
    ).rejects.toThrow(/R2_PETS_BUCKET/u);
    stubRawMediaEnv({
      R2_EMOJI_BUCKET: "",
      R2_EMOJI_PUBLIC_BASE_URL: "",
    });
    await expect(
      owner.action(api.data.emoji_pack_generation.generatePack, {
        prompt: "a safe dev emoji pack",
        visibility: "private",
      }),
    ).rejects.toThrow(/R2_EMOJI_BUCKET/u);

    expect(providerFetch).not.toHaveBeenCalled();
    await expectNoExternalMediaAuthority(t);
  });
});
