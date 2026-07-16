import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { downloadModelWithResume } from "@stella/desktop/electron/dictation/resumable-model-download.js";

const roots = new Set<string>();
const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

describe("resumable model download", () => {
  it("resumes a persistent partial file and verifies its checksum", async () => {
    const payload = Buffer.from("verified-parakeet-model-payload");
    const split = 11;
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-model-"));
    roots.add(root);
    const targetPath = path.join(root, "model.bin");
    await writeFile(`${targetPath}.part`, payload.subarray(0, split));

    let observedRange = "";
    const server = createServer((request, response) => {
      observedRange = request.headers.range ?? "";
      response.writeHead(206, {
        "Content-Length": payload.length - split,
        "Content-Range": `bytes ${split}-${payload.length - 1}/${payload.length}`,
      });
      response.end(payload.subarray(split));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(
        downloadModelWithResume({
          url: `http://127.0.0.1:${port}/model.bin`,
          targetPath,
          expectedSize: payload.length,
          expectedSha256: sha256(payload),
          attempts: 1,
        }),
      ).resolves.toBe(targetPath);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(observedRange).toBe(`bytes=${split}-`);
    expect(await readFile(targetPath)).toEqual(payload);
  });

  it("rejects and removes a completed file with the wrong checksum", async () => {
    const payload = Buffer.from("corrupt-model");
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-model-"));
    roots.add(root);
    const targetPath = path.join(root, "model.bin");
    const server = createServer((_request, response) => response.end(payload));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(
        downloadModelWithResume({
          url: `http://127.0.0.1:${port}/model.bin`,
          targetPath,
          expectedSize: payload.length,
          expectedSha256: "0".repeat(64),
          attempts: 1,
        }),
      ).rejects.toThrow("integrity check");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await expect(readFile(`${targetPath}.part`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
