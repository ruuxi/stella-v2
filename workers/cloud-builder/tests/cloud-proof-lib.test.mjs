import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import {
  CloudProofError,
  loadNonMutatingTarget,
  loadProtocolProofConfig,
  requestJson,
  sanitizeEvidence,
  sha256,
  writeEvidence,
} from "../scripts/cloud-proof-lib.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const validEnv = () => ({
  CONVEX_DEPLOYMENT: "dev:impartial-crab-34",
  CONVEX_URL: "https://impartial-crab-34.convex.cloud",
  CONVEX_SITE_URL: "https://impartial-crab-34.convex.site",
  CLOUD_BUILDER_URL: "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev",
  STELLA_CLOUD_PROOF_CONFIRM: "mutate-dev:impartial-crab-34",
  STELLA_CLOUD_PROOF_IDENTITY_KIND: "disposable",
  STELLA_CLOUD_PROOF_JWT: "short-lived-disposable-jwt",
  BUILDER_SERVICE_SECRET: "development-service-secret",
  STELLA_CLOUD_PROOF_EVIDENCE_PATH: path.join(
    tmpdir(),
    "stella-proof-evidence.json",
  ),
});

describe("cloud proof target fencing", () => {
  test("accepts only the explicitly confirmed impartial-crab development target", () => {
    const config = loadProtocolProofConfig(validEnv());
    expect(config.deployment).toBe("dev:impartial-crab-34");
    expect(config.convexUrl).toBe("https://impartial-crab-34.convex.cloud");
    expect(config.convexSiteUrl).toBe("https://impartial-crab-34.convex.site");
    expect(config.cloudBuilderUrl).toBe(
      "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev",
    );
  });

  test.each([
    [
      "historical deployment",
      { CONVEX_DEPLOYMENT: "dev:flexible-panther-999" },
    ],
    [
      "production deployment",
      { CONVEX_DEPLOYMENT: "prod:benevolent-minnow-586" },
    ],
    [
      "historical site",
      { CONVEX_SITE_URL: "https://flexible-panther-999.convex.site" },
    ],
    [
      "production cloud",
      { CONVEX_URL: "https://benevolent-minnow-586.convex.cloud" },
    ],
    [
      "historical worker",
      {
        CLOUD_BUILDER_URL:
          "https://stella-v2-cloud-builder-staging.example.workers.dev",
      },
    ],
    [
      "non-dev worker",
      {
        CLOUD_BUILDER_URL:
          "https://stella-v2-cloud-builder.example.workers.dev",
      },
    ],
    [
      "lookalike dev worker",
      {
        CLOUD_BUILDER_URL:
          "https://stella-v2-cloud-builder-dev.attacker.workers.dev",
      },
    ],
    ["missing confirmation", { STELLA_CLOUD_PROOF_CONFIRM: "" }],
    ["shared identity", { STELLA_CLOUD_PROOF_IDENTITY_KIND: "personal" }],
    [
      "live Stella evidence path",
      {
        STELLA_CLOUD_PROOF_EVIDENCE_PATH: path.join(
          homedir(),
          ".stella",
          "cloud-proof.json",
        ),
      },
    ],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      loadProtocolProofConfig({ ...validEnv(), ...override }),
    ).toThrow(CloudProofError);
  });

  test("validates the same target for non-mutating manifest checks", () => {
    expect(
      loadNonMutatingTarget({
        deployment: "dev:impartial-crab-34",
        convexUrl: "https://impartial-crab-34.convex.cloud",
        convexSiteUrl: "https://impartial-crab-34.convex.site",
        cloudBuilderUrl:
          "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev",
      }),
    ).toEqual({
      deployment: "dev:impartial-crab-34",
      convexUrl: "https://impartial-crab-34.convex.cloud",
      convexSiteUrl: "https://impartial-crab-34.convex.site",
      cloudBuilderUrl:
        "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev",
    });
  });
});

describe("cloud proof evidence safety", () => {
  test("redacts credential-shaped fields and bearer values", () => {
    expect(
      sanitizeEvidence({
        jwt: "abc",
        nested: { authorization: "Bearer top.secret.value" },
        message: "request used Bearer another.secret.value",
        callback:
          "https://example.test/callback?token=abc123&next=/home eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
        conversationId: "conversation-123",
      }),
    ).toEqual({
      jwt: "[REDACTED]",
      nested: { authorization: "[REDACTED]" },
      message: "request used Bearer [REDACTED]",
      callback:
        "https://example.test/callback?token=[REDACTED]&next=/home [JWT REDACTED]",
      conversationId: "conversation-123",
    });
  });

  test("writes sanitized evidence atomically with private permissions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "stella-cloud-proof-"));
    const output = path.join(directory, "nested", "evidence.json");
    await writeEvidence(output, {
      result: "passed",
      builderServiceSecret: "must-not-land",
    });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      result: "passed",
      builderServiceSecret: "[REDACTED]",
    });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  test("hashes byte evidence deterministically", () => {
    expect(sha256(Buffer.from("evidence"))).toBe(
      "ee8250fb76e094b34b471f13a73dbbe51d1ae142e9df59d7c0d31ec20f0a0a8e",
    );
  });

  test("refuses to replace an existing evidence file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "stella-cloud-proof-"));
    const output = path.join(directory, "evidence.json");
    await writeFile(output, "preserve me", "utf8");
    await expect(writeEvidence(output, { result: "passed" })).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("preserve me");
  });
});

describe("cloud proof HTTP checks", () => {
  test("rejects a non-success status with parsed details", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "denied" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    await expect(
      requestJson("https://example.test", {
        label: "test request",
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "CloudProofError",
      message: "test request returned HTTP 403.",
    });
  });

  test("rejects non-JSON success bodies without retaining the body", async () => {
    globalThis.fetch = async () => new Response("not json", { status: 200 });
    await expect(
      requestJson("https://example.test", {
        label: "test request",
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "CloudProofError",
      message: "test request returned non-JSON.",
    });
  });

  test("aborts a request that exceeds its timeout", async () => {
    globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    await expect(
      requestJson("https://example.test", {
        label: "slow request",
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({
      name: "CloudProofError",
      message: "slow request failed: timed out after 10ms",
    });
  });

  test("keeps the timeout active while reading the response body", async () => {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start() {},
        }),
        { status: 200 },
      );
    await expect(
      requestJson("https://example.test", {
        label: "stalled body",
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({
      name: "CloudProofError",
      message: "stalled body failed: timed out after 10ms",
    });
  });

  test("rejects a response body beyond its byte limit", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ value: "too large" }), { status: 200 });
    await expect(
      requestJson("https://example.test", {
        label: "large body",
        timeoutMs: 1_000,
        maxResponseBytes: 8,
      }),
    ).rejects.toMatchObject({
      name: "CloudProofError",
      message: "Response body exceeded the proof harness limit.",
    });
  });
});
