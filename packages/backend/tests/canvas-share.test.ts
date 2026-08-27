import { afterEach, describe, expect, it, setSystemTime } from "bun:test";

import { deleteR2Object, signR2Put } from "../convex/lib/r2_sigv4";
import {
  CANVAS_SHARE_BASE_URL_PLACEHOLDER,
  buildCanvasShareUrl,
  resolveCanvasShareBaseUrl,
} from "../convex/lib/canvas_share_url";

const R2 = {
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret-example-key",
  endpoint: "https://accountid.r2.cloudflarestorage.com",
  bucket: "stella-canvas-shares",
};

describe("r2 sigv4 signer", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("signs a PUT with the canonical scope, sorted headers, and hex signature", () => {
    setSystemTime(new Date("2026-07-08T12:00:00.000Z"));
    const { putUrl, headers } = signR2Put({
      ...R2,
      key: "shares/abc123.html",
      payloadHash: "a".repeat(64),
      contentType: "text/html; charset=utf-8",
      cacheControl: "public, max-age=300",
    });

    expect(putUrl).toBe(
      "https://accountid.r2.cloudflarestorage.com/stella-canvas-shares/shares/abc123.html",
    );
    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(headers["cache-control"]).toBe("public, max-age=300");
    expect(headers["x-amz-content-sha256"]).toBe("a".repeat(64));
    expect(headers["x-amz-date"]).toBe("20260708T120000Z");

    const auth = headers["authorization"]!;
    expect(auth).toContain(
      "Credential=AKIAEXAMPLE/20260708/auto/s3/aws4_request",
    );
    const signedHeaders = /SignedHeaders=([^,]+),/.exec(auth)?.[1];
    expect(signedHeaders).toBe(
      "cache-control;content-type;host;x-amz-content-sha256;x-amz-date",
    );
    const signature = /Signature=([0-9a-f]+)$/.exec(auth)?.[1];
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical inputs at a fixed time", () => {
    setSystemTime(new Date("2026-07-08T12:00:00.000Z"));
    const args = {
      ...R2,
      key: "shares/abc123.html",
      payloadHash: "b".repeat(64),
      contentType: "text/html; charset=utf-8",
      cacheControl: "public, max-age=300",
    };
    const a = signR2Put(args).headers["authorization"];
    const b = signR2Put(args).headers["authorization"];
    expect(a).toBe(b);
  });

  it("signs custom metadata headers (they must be in SignedHeaders)", () => {
    setSystemTime(new Date("2026-07-08T12:00:00.000Z"));
    const { headers } = signR2Put({
      ...R2,
      key: "shares/abc123.html",
      payloadHash: "c".repeat(64),
      contentType: "text/html; charset=utf-8",
      cacheControl: "public, max-age=300",
      metadata: { "expires-at": "1799539200000", owner: "user_123" },
    });
    expect(headers["x-amz-meta-expires-at"]).toBe("1799539200000");
    expect(headers["x-amz-meta-owner"]).toBe("user_123");
    const signedHeaders = /SignedHeaders=([^,]+),/.exec(
      headers["authorization"]!,
    )?.[1];
    expect(signedHeaders).toContain("x-amz-meta-expires-at");
    expect(signedHeaders).toContain("x-amz-meta-owner");
  });

  it("constructs the exact encoded object pathname segment by segment", () => {
    const { putUrl } = signR2Put({
      ...R2,
      key: "shares/space snow/é!()*.txt",
      payloadHash: "d".repeat(64),
      contentType: "text/plain",
      cacheControl: "private",
    });
    expect(putUrl).toBe(
      "https://accountid.r2.cloudflarestorage.com/stella-canvas-shares/shares/space%20snow/%C3%A9%21%28%29%2A.txt",
    );
  });

  it.each([
    "",
    "/shares/a",
    "shares/a/",
    "shares//a",
    "shares/./a",
    "shares/../a",
    "shares/%252F..%252Fvictim",
    "user-pets/attacker/../../../user-pets/victim/pet.webp",
    "user-pets/attacker/../../../../emoji-dev/emoji-packs/victim/sheet.webp",
    String.raw`user-pets\attacker\..\victim\pet.webp`,
  ])("rejects an unsafe R2 key before signing: %s", (key) => {
    expect(() =>
      signR2Put({
        ...R2,
        key,
        payloadHash: "e".repeat(64),
        contentType: "text/plain",
        cacheControl: "private",
      }),
    ).toThrow(/unsafe path segment/u);
  });

  it.each(["", ".", "..", "pets/victim", String.raw`pets\victim`])(
    "rejects an unsafe R2 bucket before signing: %s",
    (bucket) => {
      expect(() =>
        signR2Put({
          ...R2,
          bucket,
          key: "shares/safe.html",
          payloadHash: "f".repeat(64),
          contentType: "text/html",
          cacheControl: "private",
        }),
      ).toThrow(/unsafe path segment/u);
    },
  );

  it.each([
    "http://accountid.r2.cloudflarestorage.com",
    "https://user:secret@accountid.r2.cloudflarestorage.com",
    "https://accountid.r2.cloudflarestorage.com/prefix",
    "https://accountid.r2.cloudflarestorage.com?bucket=other",
    "https://accountid.r2.cloudflarestorage.com#other",
  ])("rejects a non-origin R2 endpoint: %s", (endpoint) => {
    expect(() =>
      signR2Put({
        ...R2,
        endpoint,
        key: "shares/safe.html",
        payloadHash: "1".repeat(64),
        contentType: "text/html",
        cacheControl: "private",
      }),
    ).toThrow(/exact HTTPS origin/u);
  });

  it("rejects a cross-bucket DELETE key before external I/O", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      await expect(
        deleteR2Object({
          key: "user-pets/attacker/../../../../emoji-dev/emoji-packs/victim/sheet.webp",
          r2: R2,
        }),
      ).rejects.toThrow(/unsafe path segment/u);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("canvas share url", () => {
  const prev = process.env.CANVAS_SHARE_BASE_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.CANVAS_SHARE_BASE_URL;
    else process.env.CANVAS_SHARE_BASE_URL = prev;
  });

  it("falls back to the placeholder when unconfigured", () => {
    delete process.env.CANVAS_SHARE_BASE_URL;
    expect(resolveCanvasShareBaseUrl()).toBe(CANVAS_SHARE_BASE_URL_PLACEHOLDER);
    expect(buildCanvasShareUrl("slug1")).toBe(
      `${CANVAS_SHARE_BASE_URL_PLACEHOLDER}/c/slug1`,
    );
  });

  it("uses the configured base and trims trailing slashes", () => {
    process.env.CANVAS_SHARE_BASE_URL = "https://share.example.com/";
    expect(buildCanvasShareUrl("abc")).toBe("https://share.example.com/c/abc");
  });
});
