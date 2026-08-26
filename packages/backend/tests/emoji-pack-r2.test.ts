import { afterEach, describe, expect, it } from "bun:test";
import { resolveEmojiPackR2Destination } from "../convex/lib/emoji_pack_r2";

const ENV_KEYS = [
  "R2_EMOJI_BUCKET",
  "R2_PUBLIC_BASE_URL",
  "R2_EMOJI_PREFIX",
] as const;

const clearEnv = () => {
  for (const key of ENV_KEYS) delete process.env[key];
};

afterEach(clearEnv);

describe("emoji pack R2 destination", () => {
  it("uses the internally consistent built-in pair when nothing is configured", () => {
    clearEnv();
    const destination = resolveEmojiPackR2Destination();
    expect(destination.bucket).toBe("stella-emotes");
    expect(destination.publicBase).toStartWith("https://");
    expect(destination.prefix).toBe("emoji-packs");
  });

  it("honours a fully specified override pair", () => {
    clearEnv();
    process.env.R2_EMOJI_BUCKET = "my-emotes";
    process.env.R2_PUBLIC_BASE_URL = "https://cdn.example.com/";
    process.env.R2_EMOJI_PREFIX = "/packs/";
    const destination = resolveEmojiPackR2Destination();
    expect(destination).toEqual({
      bucket: "my-emotes",
      publicBase: "https://cdn.example.com",
      prefix: "packs",
    });
  });

  it("refuses a bucket override without a matching public base", () => {
    clearEnv();
    process.env.R2_EMOJI_BUCKET = "my-emotes";
    expect(() => resolveEmojiPackR2Destination()).toThrow(/R2_PUBLIC_BASE_URL/);
  });

  it("refuses a public base override without a matching bucket", () => {
    clearEnv();
    process.env.R2_PUBLIC_BASE_URL = "https://cdn.example.com";
    expect(() => resolveEmojiPackR2Destination()).toThrow(/R2_EMOJI_BUCKET/);
  });

  it("rejects a non-absolute public base", () => {
    clearEnv();
    process.env.R2_EMOJI_BUCKET = "my-emotes";
    process.env.R2_PUBLIC_BASE_URL = "cdn.example.com";
    expect(() => resolveEmojiPackR2Destination()).toThrow(/absolute http/);
  });

  it("never reads the retired pets bucket variable", () => {
    clearEnv();
    process.env.R2_PETS_BUCKET = "legacy-pets";
    const destination = resolveEmojiPackR2Destination();
    expect(destination.bucket).not.toBe("legacy-pets");
    delete process.env.R2_PETS_BUCKET;
  });
});
